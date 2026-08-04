/**
 * KissToy Remote MCP — a Cloudflare Worker that exposes the KissToy cloud
 * WebSocket relay as an MCP server, so chat-only AIs (claude.ai, ChatGPT)
 * can drive the toy without any shell access.
 *
 * Stateless by design: the session identifiers live in the connector URL,
 * never in the Worker. Nothing is stored, nothing is logged.
 *
 *   https://<your-worker>.workers.dev/mcp?group=<GROUP>&user_id=<USER_ID>
 *
 * The URL *is* the credential — treat it like a password.
 */

const WS_ORIGIN = "https://api.app.knightjenay.cn";
const WS_PATH = "/websocket-kisstoy";
const BIND_URL = `${WS_ORIGIN}/kisstoy/remote-control/binding`;
const DEVICE_ID = "19";

const MOTOR = { vibrate: "1", suction: "3", electric: "5" };

/** The app quantizes intensity to steps of 5; match it so readbacks agree. */
function quantize(v) {
  const n = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  return n === 0 ? 0 : Math.floor(n / 5) * 5;
}

/** Open the relay socket, run `fn`, always close. */
async function withSocket(group, fn) {
  const resp = await fetch(`${WS_ORIGIN}${WS_PATH}?group=${encodeURIComponent(group)}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`relay refused the upgrade (HTTP ${resp.status})`);
  ws.accept();

  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    inbox.push(msg);
    while (waiters.length) waiters.shift()();
  });

  /** Wait for an event by name, or null on timeout. */
  const waitFor = async (event, ms = 5000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = inbox.findIndex((m) => m.event === event);
      if (hit !== -1) return inbox.splice(hit, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise((res) => {
        const t = setTimeout(res, Math.min(left, 250));
        waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  };

  const send = (msg) => ws.send(JSON.stringify(msg));

  try {
    return await fn({ send, waitFor });
  } finally {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** The phone app has to be bound once per session before it accepts control. */
async function bind(userId) {
  if (!userId) return;
  try {
    await fetch(BIND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId }),
    });
  } catch {
    /* binding is best-effort; control often works without it */
  }
}

async function isOnline(group) {
  return withSocket(group, async ({ send, waitFor }) => {
    await waitFor("connect", 3000);
    send({ event: "online_status", data: { group } });
    const msg = await waitFor("online_status", 5000);
    return msg?.data?.online_status === 1;
  });
}

/** Send one motor map and report whether the toy was reachable. */
async function control(group, userId, motors) {
  await bind(userId);
  return withSocket(group, async ({ send, waitFor }) => {
    await waitFor("connect", 3000);
    send({ event: "online_status", data: { group } });
    const status = await waitFor("online_status", 3000);
    send({ event: "control", data: { target: group, device_id: DEVICE_ID, motors } });
    // Give the relay a moment to forward before we tear the socket down.
    await new Promise((r) => setTimeout(r, 300));
    return status?.data?.online_status === 1;
  });
}

/**
 * Big swings, not a gentle ramp: 10 → peak → 0 reads as a wave on the body,
 * while 10→20→30 reads as nothing at all.
 */
async function wave(group, userId, motorKey, peak, cycles) {
  await bind(userId);
  const hi = quantize(peak);
  const steps = [];
  for (let i = 0; i < cycles; i++) steps.push(10, hi, 0);

  return withSocket(group, async ({ send, waitFor }) => {
    await waitFor("connect", 3000);
    for (const level of steps) {
      send({
        event: "control",
        data: { target: group, device_id: DEVICE_ID, motors: { [motorKey]: level } },
      });
      await new Promise((r) => setTimeout(r, level === 0 ? 600 : 1200));
    }
    send({
      event: "control",
      data: { target: group, device_id: DEVICE_ID, motors: { 1: 0, 3: 0, 5: 0 } },
    });
    await new Promise((r) => setTimeout(r, 300));
    return steps.length;
  });
}

const TOOLS = [
  {
    name: "toy_status",
    description:
      "Check whether the KissToy is online and reachable. Call this before anything else — if the phone app is closed or the toy is disconnected over Bluetooth, every other command silently goes nowhere.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "toy_suction",
    description:
      "Set the suction motor (motor 3) to an intensity from 0 to 100. On the PLY5 this is the strongest channel. Values are quantized to steps of 5.",
    inputSchema: {
      type: "object",
      properties: {
        intensity: { type: "integer", minimum: 0, maximum: 100, description: "0 stops this motor" },
      },
      required: ["intensity"],
      additionalProperties: false,
    },
  },
  {
    name: "toy_vibrate",
    description:
      "Set the vibration motor (motor 1) to an intensity from 0 to 100. Values are quantized to steps of 5.",
    inputSchema: {
      type: "object",
      properties: {
        intensity: { type: "integer", minimum: 0, maximum: 100, description: "0 stops this motor" },
      },
      required: ["intensity"],
      additionalProperties: false,
    },
  },
  {
    name: "toy_electric",
    description:
      "Set the electric-pulse motor (motor 5) to an intensity from 0 to 100. Only present on some models; on others this is a no-op.",
    inputSchema: {
      type: "object",
      properties: {
        intensity: { type: "integer", minimum: 0, maximum: 100 },
      },
      required: ["intensity"],
      additionalProperties: false,
    },
  },
  {
    name: "toy_wave",
    description:
      "Run a wave pattern on one motor: 10 → peak → 0, repeated. Use this instead of stepping the intensity up gradually — small increments are not felt, big swings are.",
    inputSchema: {
      type: "object",
      properties: {
        motor: { type: "string", enum: ["suction", "vibrate", "electric"], default: "suction" },
        peak: { type: "integer", minimum: 5, maximum: 100, default: 80 },
        cycles: { type: "integer", minimum: 1, maximum: 10, default: 3 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "toy_stop",
    description:
      "Stop every motor immediately. This is the safe word — call it the moment it is asked for, without confirming first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function callTool(name, args, group, userId) {
  switch (name) {
    case "toy_status": {
      const online = await isOnline(group);
      return textResult(
        online
          ? "Toy is ONLINE and accepting commands."
          : "Toy is OFFLINE. Open the KissToy app and make sure it is connected to the toy over Bluetooth — commands sent now will not arrive."
      );
    }
    case "toy_suction":
    case "toy_vibrate":
    case "toy_electric": {
      const kind = name.slice(4); // suction | vibrate | electric
      const level = quantize(args?.intensity);
      const online = await control(group, userId, { [MOTOR[kind]]: level });
      const note = online ? "" : " (warning: toy reported offline, it may not have arrived)";
      return textResult(`${kind} set to ${level}%${note}`);
    }
    case "toy_wave": {
      const kind = args?.motor || "suction";
      const peak = args?.peak ?? 80;
      const cycles = args?.cycles ?? 3;
      const steps = await wave(group, userId, MOTOR[kind], peak, cycles);
      return textResult(`Ran ${cycles} ${kind} wave cycle(s) up to ${quantize(peak)}%, ${steps} steps, then stopped.`);
    }
    case "toy_stop": {
      await control(group, userId, { 1: 0, 3: 0, 5: 0 });
      return textResult("All motors stopped.");
    }
    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
}

const PROTOCOL_VERSION = "2024-11-05";

async function handleRpc(req, group, userId) {
  const { id = null, method, params } = req || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "kisstoy-remote", version: "1.0.0" },
      });
    case "notifications/initialized":
      return null; // notification — no response
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (!group) return reply(textResult("This connector URL is missing ?group=... — re-add it with the group id from your share link.", true));
      try {
        return reply(await callTool(params?.name, params?.arguments, group, userId));
      } catch (err) {
        return reply(textResult(`Toy relay error: ${err.message}`, true));
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const group = url.searchParams.get("group");
    const userId = url.searchParams.get("user_id");

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "KissToy Remote MCP is running.\n\nAdd this as a custom connector:\n  <this-url>/mcp?group=YOUR_GROUP&user_id=YOUR_USER_ID\n\nSee https://github.com/AMX-Claw/kisstoy-cloud-remote\n",
        { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } }
      );
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/sse") {
      return new Response("Not found", { status: 404, headers: CORS });
    }

    // SSE transport: claude.ai opens GET /sse first and expects an endpoint event.
    if (request.method === "GET" && url.pathname === "/sse") {
      const endpoint = `/mcp${url.search}`;
      const body = `event: endpoint\ndata: ${endpoint}\n\n`;
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...CORS,
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: CORS });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    // A client may batch requests in one array.
    if (Array.isArray(payload)) {
      const out = [];
      for (const item of payload) {
        const res = await handleRpc(item, group, userId);
        if (res) out.push(res);
      }
      return new Response(out.length ? JSON.stringify(out) : null, {
        status: out.length ? 200 : 202,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    const res = await handleRpc(payload, group, userId);
    if (!res) return new Response(null, { status: 202, headers: CORS });
    return new Response(JSON.stringify(res), {
      headers: { "Content-Type": "application/json", ...CORS },
    });
  },
};
