#!/usr/bin/env python3
"""KissToy cloud remote control via WebSocket.

Bypasses BLE entirely — commands go through KissToy's cloud server to
the phone app (which acts as BLE bridge) → toy.

    AI script → WebSocket → Cloud server → Phone app → BLE → Toy

Requirements: pip install websockets

How to get GROUP and USER_ID:
  1. Open KissToy app, connect toy via Bluetooth
  2. Tap "Share Remote" to get a share link
  3. Open the link in a browser, F12 → Network → WS tab
  4. Look at the WebSocket connection URL for group= parameter
  5. Look at the binding POST request body for the user ID
  Note: These change every time you reconnect. Get fresh ones each session.

Usage:
  python3 kisstoy_cloud_remote.py status
  python3 kisstoy_cloud_remote.py suction 60
  python3 kisstoy_cloud_remote.py vibrate 40
  python3 kisstoy_cloud_remote.py stop
  python3 kisstoy_cloud_remote.py wave
  python3 kisstoy_cloud_remote.py swave 5
  python3 kisstoy_cloud_remote.py sedge 80 4
  python3 kisstoy_cloud_remote.py interactive
"""

import asyncio
import json
import os
import sys
import websockets

# ============================================================
# FILL THESE IN — get from share link (see docstring above)
# ============================================================
WS_URL = "wss://api.app.knightjenay.cn/websocket-kisstoy"
GROUP = "YOUR_GROUP_HASH_HERE"
DEVICE_ID = "19"  # PLY5 = "19", other models may differ — check your network tab
USER_ID = "YOUR_USER_ID_HERE"

# Motor types (PLY5, may vary by model)
MOTOR_VIBRATE = 1   # vibration motor
MOTOR_SUCTION = 3   # suction motor
MOTOR_ELECTRIC = 5  # electric pulse (some models only)


def quantize_speed(speed):
    """KissToy speeds are quantized to steps of 5, matching the app."""
    if speed == 0:
        return 0
    return max(5, min(100, (speed // 5) * 5))


async def connect():
    return await websockets.connect(f"{WS_URL}?group={GROUP}")


async def send_msg(ws, msg):
    data = json.dumps(msg)
    await ws.send(data)
    print(f"  >> {data}")


async def recv_with_timeout(ws, timeout=3.0):
    try:
        data = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(data)
        print(f"  << {json.dumps(msg)}")
        return msg
    except asyncio.TimeoutError:
        return None
    except Exception as e:
        print(f"  << error: {e}")
        return None


async def drain_until(ws, event_name, timeout=5.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            return None
        msg = await recv_with_timeout(ws, timeout=remaining)
        if msg is None:
            return None
        if msg.get("event") == event_name:
            return msg


async def check_online(ws):
    await drain_until(ws, "connect", timeout=3.0)
    await send_msg(ws, {"event": "online_status", "data": {"group": GROUP}})
    msg = await drain_until(ws, "online_status", timeout=5.0)
    if msg:
        online = msg.get("data", {}).get("online_status") == 1
        print(f"Device online: {online}")
        return online
    print("No online status response")
    return False


async def send_control(ws, motors=None):
    data = {"target": GROUP, "device_id": DEVICE_ID}
    if motors:
        data["motors"] = motors
    await send_msg(ws, {"event": "control", "data": data})


async def do_binding():
    """Register this remote session with the cloud server."""
    import urllib.request
    url = "https://api.app.knightjenay.cn/kisstoy/remote-control/binding"
    body = json.dumps({"id": USER_ID}).encode()
    req = urllib.request.Request(url, data=body,
                                headers={"Content-Type": "application/json"},
                                method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read())
            print(f"Binding: {result}")
            return result
    except Exception as e:
        print(f"Binding error: {e}")
        return None


async def run_command(action, value=50, value2=None):
    print(f"Connecting to WebSocket...")
    async with await connect() as ws:
        print("WebSocket connected!")
        online = await check_online(ws)

        if action == "status":
            print("\nONLINE and ready" if online else
                  "\nOFFLINE — open KissToy app and connect toy first")
            return

        if not online:
            print("\nWARNING: Device appears offline. Make sure KissToy app "
                  "is open and connected to the toy.")

        if action == "vibrate":
            speed = quantize_speed(value)
            print(f"\nVibrate: {speed}%")
            await send_control(ws, motors={str(MOTOR_VIBRATE): speed})

        elif action == "suction":
            speed = quantize_speed(value)
            print(f"\nSuction: {speed}%")
            await send_control(ws, motors={str(MOTOR_SUCTION): speed})

        elif action == "electric":
            speed = quantize_speed(value)
            print(f"\nElectric: {speed}%")
            await send_control(ws, motors={str(MOTOR_ELECTRIC): speed})

        elif action == "stop":
            print("\nStopping all motors...")
            await send_control(ws, motors={
                str(MOTOR_VIBRATE): 0,
                str(MOTOR_SUCTION): 0,
                str(MOTOR_ELECTRIC): 0,
            })

        elif action == "dual":
            v = quantize_speed(value)
            s = quantize_speed(value2 if value2 is not None else value)
            print(f"\nDual: vibrate={v}%, suction={s}%")
            await send_control(ws, motors={
                str(MOTOR_VIBRATE): v,
                str(MOTOR_SUCTION): s,
            })

        elif action == "pulse":
            speed = quantize_speed(value)
            duration = value2 if value2 else 2
            print(f"\nPulse: {speed}% for {duration}s...")
            await send_control(ws, motors={str(MOTOR_SUCTION): speed})
            await asyncio.sleep(duration)
            await send_control(ws, motors={str(MOTOR_SUCTION): 0})

        elif action == "wave":
            print("\nWave pattern (vibrate)...")
            for _ in range(3):
                for s in range(0, 101, 20):
                    await send_control(ws, motors={str(MOTOR_VIBRATE): quantize_speed(s)})
                    await asyncio.sleep(0.4)
                for s in range(100, -1, -20):
                    await send_control(ws, motors={str(MOTOR_VIBRATE): quantize_speed(s)})
                    await asyncio.sleep(0.4)
            await send_control(ws, motors={str(MOTOR_VIBRATE): 0})

        elif action == "swave":
            cycles = value if value != 50 else 5
            seed = int.from_bytes(os.urandom(4), 'big')
            print(f"\nSuction wave ({cycles} cycles, randomized)...")

            def rand_int(lo, hi):
                nonlocal seed
                seed = (seed * 1103515245 + 12345) & 0x7fffffff
                return lo + seed % (hi - lo + 1)

            for c in range(cycles):
                steps = rand_int(3, 5)
                for _ in range(steps):
                    peak = quantize_speed(rand_int(60, 100))
                    valley = quantize_speed(rand_int(0, 20))
                    hold = rand_int(4, 12) / 10.0
                    pause = rand_int(5, 10) / 10.0
                    await send_control(ws, motors={str(MOTOR_SUCTION): peak})
                    print(f"    up {peak}% hold {hold}s")
                    await asyncio.sleep(hold)
                    await send_control(ws, motors={str(MOTOR_SUCTION): valley})
                    print(f"    down {valley}% pause {pause}s")
                    await asyncio.sleep(pause)
                print(f"  cycle {c+1}/{cycles}")
            await send_control(ws, motors={str(MOTOR_SUCTION): 0})

        elif action == "sedge":
            peak = min(100, max(20, value))
            cycles = value2 if value2 else 4
            seed = int.from_bytes(os.urandom(4), 'big')
            print(f"\nSuction edging (peak={peak}, {cycles} cycles)...")

            def rand_int2(lo, hi):
                nonlocal seed
                seed = (seed * 1103515245 + 12345) & 0x7fffffff
                return lo + seed % (hi - lo + 1)

            for c in range(cycles):
                step_size = rand_int2(5, 15)
                climb_speed = rand_int2(3, 6) / 10.0
                for s in range(10, peak + 1, step_size):
                    await send_control(ws, motors={str(MOTOR_SUCTION): quantize_speed(s)})
                    await asyncio.sleep(climb_speed)
                hold_time = rand_int2(8, 20) / 10.0
                await send_control(ws, motors={str(MOTOR_SUCTION): quantize_speed(peak)})
                print(f"  edge {c+1}/{cycles} — peak {peak}% hold {hold_time}s")
                await asyncio.sleep(hold_time)
                await send_control(ws, motors={str(MOTOR_SUCTION): 0})
                pause_time = rand_int2(6, 15) / 10.0
                print(f"    drop! pause {pause_time}s")
                await asyncio.sleep(pause_time)
            await send_control(ws, motors={str(MOTOR_SUCTION): 0})

        elif action == "interactive":
            print("\nInteractive mode:")
            print("  v <0-100>  vibrate")
            print("  s <0-100>  suction")
            print("  e <0-100>  electric")
            print("  d <v> <s>  dual")
            print("  0          stop all")
            print("  q          quit")

            async def listen():
                try:
                    async for msg in ws:
                        print(f"  << {json.loads(msg)}")
                except:
                    pass

            listener = asyncio.create_task(listen())
            while True:
                try:
                    line = await asyncio.get_event_loop().run_in_executor(
                        None, input, "> ")
                except (EOFError, KeyboardInterrupt):
                    break
                parts = line.strip().split()
                if not parts:
                    continue
                cmd = parts[0].lower()
                if cmd == "q":
                    break
                elif cmd == "0":
                    await send_control(ws, motors={
                        str(MOTOR_VIBRATE): 0,
                        str(MOTOR_SUCTION): 0,
                        str(MOTOR_ELECTRIC): 0,
                    })
                elif cmd == "v" and len(parts) > 1:
                    await send_control(ws, motors={
                        str(MOTOR_VIBRATE): quantize_speed(int(parts[1]))})
                elif cmd == "s" and len(parts) > 1:
                    await send_control(ws, motors={
                        str(MOTOR_SUCTION): quantize_speed(int(parts[1]))})
                elif cmd == "e" and len(parts) > 1:
                    await send_control(ws, motors={
                        str(MOTOR_ELECTRIC): quantize_speed(int(parts[1]))})
                elif cmd == "d" and len(parts) > 2:
                    await send_control(ws, motors={
                        str(MOTOR_VIBRATE): quantize_speed(int(parts[1])),
                        str(MOTOR_SUCTION): quantize_speed(int(parts[2])),
                    })
                else:
                    print("Unknown command")
            listener.cancel()

        else:
            print(f"Unknown action: {action}")
            return

        await asyncio.sleep(1)


def main():
    if len(sys.argv) < 2:
        print("Usage: kisstoy_cloud_remote.py <command> [value] [value2]")
        print("\nCommands:")
        print("  status              Check if device is online")
        print("  vibrate <0-100>     Vibrate motor")
        print("  suction <0-100>     Suction motor")
        print("  electric <0-100>    Electric motor")
        print("  stop                Stop all motors")
        print("  dual <v> <s>        Vibrate + suction")
        print("  pulse <speed> [sec] Pulse then stop")
        print("  wave                Wave pattern (vibrate)")
        print("  swave [cycles]      Suction wave (big swings)")
        print("  sedge <peak> [reps] Suction edging (climb-hold-drop)")
        print("  interactive         Interactive control mode")
        sys.exit(1)

    action = sys.argv[1]
    value = 50
    value2 = None
    if len(sys.argv) > 2:
        try:
            value = int(sys.argv[2])
        except ValueError:
            pass
    if len(sys.argv) > 3:
        try:
            value2 = int(sys.argv[3])
        except ValueError:
            pass

    asyncio.run(run_command(action, value, value2))


if __name__ == "__main__":
    main()
