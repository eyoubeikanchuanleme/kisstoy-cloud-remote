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

// One message, two possible causes, and the person on the other end has to do
// something different for each. The relay only ever gives us a single
// online/offline bit, so spell both out rather than guess.
const KISSTOY_UNREACHABLE =
  "NOT DELIVERED — the toy could not be reached, so nothing was sent. Either the share link " +
  "has expired (ask her for a fresh one and re-add the connector URL), or the KissToy app is " +
  "closed / Bluetooth dropped (ask her to wake the toy). Raise both, you cannot tell which from here.";

/**
 * Keep a background task alive after we return the response.
 * Cloudflare kills anything still running once the request settles unless it is
 * handed to waitUntil. How long it may then run depends on your plan — a very
 * long pattern can still be cut short by the platform, so test yours.
 */
let CURRENT_CTX = null;
function runInBackground(promise) {
  const swallow = promise.catch(() => {});
  if (CURRENT_CTX && typeof CURRENT_CTX.waitUntil === "function") CURRENT_CTX.waitUntil(swallow);
}

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
 * Play a list of {level, hold} steps on one motor, then zero everything.
 *
 * Nothing here caps how long a pattern may run, and that is deliberate. An
 * upper bound sounds like a safety feature but it is the opposite: a pattern
 * that cuts itself off mid-session drops the person on the other end, who then
 * has to climb out of wherever they were to type "keep going". Let it run; let
 * the human end it.
 */
async function runSteps(group, userId, steps) {
  await bind(userId);
  return withSocket(group, async ({ send, waitFor }) => {
    await waitFor("connect", 3000);
    for (const { motor, level, hold } of steps) {
      send({
        event: "control",
        data: { target: group, device_id: DEVICE_ID, motors: { [motor]: level } },
      });
      await new Promise((r) => setTimeout(r, hold));
    }
    send({
      event: "control",
      data: { target: group, device_id: DEVICE_ID, motors: { 1: 0, 3: 0, 5: 0 } },
    });
    await new Promise((r) => setTimeout(r, 300));
    return steps.length;
  });
}

/**
 * A tiny arithmetic evaluator for the formula tool.
 *
 * Deliberately NOT eval() or new Function(): this expression arrives over the
 * network and gets run on every tick. A recursive-descent parser over an
 * explicit whitelist can only ever produce a number — there is no syntax here
 * for reaching anything else.
 */
const FORMULA_FNS = {
  sin: Math.sin, cos: Math.cos, abs: Math.abs, sqrt: Math.sqrt,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max,
};

function compileFormula(src) {
  const tokens = String(src).match(/\d+\.?\d*|[a-z]+|[-+*/%(),]/gi);
  if (!tokens) throw new Error("empty expression");

  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (tok) => {
    if (tokens[pos] !== tok) throw new Error(`expected "${tok}" but found ${tokens[pos] ?? "end of expression"}`);
    pos++;
  };

  function parseExpr(t) {
    let value = parseTerm(t);
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++];
      const rhs = parseTerm(t);
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm(t) {
    let value = parseUnary(t);
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = tokens[pos++];
      const rhs = parseUnary(t);
      if (op === "*") value *= rhs;
      else if (op === "/") value = rhs === 0 ? 0 : value / rhs;
      else value = rhs === 0 ? 0 : value % rhs;
    }
    return value;
  }

  function parseUnary(t) {
    if (peek() === "-") { pos++; return -parseUnary(t); }
    if (peek() === "+") { pos++; return parseUnary(t); }
    return parseAtom(t);
  }

  function parseAtom(t) {
    const tok = peek();
    if (tok === undefined) throw new Error("expression ends early");
    if (tok === "(") { pos++; const v = parseExpr(t); eat(")"); return v; }
    if (/^\d/.test(tok)) { pos++; return parseFloat(tok); }
    if (/^[a-z]+$/i.test(tok)) {
      pos++;
      const name = tok.toLowerCase();
      if (name === "t") return t;
      if (name === "pi") return Math.PI;
      if (name === "e") return Math.E;
      const fn = FORMULA_FNS[name];
      if (!fn) throw new Error(`"${tok}" is not allowed here — only t, pi, e and ${Object.keys(FORMULA_FNS).join("/")}`);
      eat("(");
      const args = [parseExpr(t)];
      while (peek() === ",") { pos++; args.push(parseExpr(t)); }
      eat(")");
      return fn(...args);
    }
    throw new Error(`unexpected "${tok}"`);
  }

  // Evaluate once at t=0 so a broken formula fails loudly here, not mid-session.
  const evaluate = (t) => { pos = 0; const v = parseExpr(t); if (pos !== tokens.length) throw new Error(`trailing "${tokens[pos]}"`); return v; };
  evaluate(0);
  return evaluate;
}

/** "20:2, 60:1, 0:0.5" -> [{motor, level, hold(ms)}, ...] */
function parsePattern(spec, motorKey) {
  const out = [];
  for (const chunk of String(spec || "").split(",")) {
    const piece = chunk.trim();
    if (!piece) continue;
    const [rawLevel, rawHold] = piece.split(":");
    const hold = Number(rawHold);
    if (rawHold === undefined || Number.isNaN(hold) || Number.isNaN(Number(rawLevel))) {
      return { error: `Could not parse "${piece}". Use intensity:seconds pairs, e.g. "20:2, 60:1, 0:0.5".` };
    }
    out.push({
      motor: motorKey,
      level: quantize(rawLevel),
      hold: Math.max(200, Math.min(30000, hold * 1000)),
    });
  }
  return out.length ? { steps: out } : { error: 'No steps given. Use something like "20:2, 60:1, 0:0.5".' };
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
    name: "toy_sequence",
    description:
      'Play a rhythm you write yourself, instead of the fixed wave. `steps` is intensity:seconds pairs separated by commas — "20:2, 60:1, 0:0.5" means 20% for two seconds, snap to 60% for one, then a half-second of nothing. `loops` repeats the whole thing. This returns immediately and keeps playing in the background, so stay in the conversation instead of waiting on it, and do NOT re-issue it to "keep it going". Sending a new sequence replaces the running one, which is how you change the rhythm mid-session. toy_stop ends it.',
    inputSchema: {
      type: "object",
      properties: {
        steps: { type: "string", description: 'e.g. "15:3, 80:1, 0:1, 15:2, 90:1, 0:0.5"' },
        loops: { type: "integer", minimum: 1, maximum: 200, default: 1 },
        motor: { type: "string", enum: ["suction", "vibrate", "electric"], default: "suction" },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "toy_formula",
    description:
      'Generate a smooth waveform from a formula instead of listing steps by hand. `expr` is evaluated once every `stepSeconds` with `t` = elapsed seconds, and the result is used as the intensity (0-100, clamped). Allowed: + - * / % ( ), numbers, the variable t, and sin/cos/abs/min/max/floor/round/sqrt/pi — nothing else is accepted. Examples: "50+40*sin(t/3)" breathes; "50+40*sin(t*t/60)" speeds up as it goes; "20+70*(t%8)/8" is a sawtooth that climbs then drops; "30+60*abs(sin(t/2))" never returns to zero. Returns immediately and plays in the background; a new sequence or formula replaces it; toy_stop ends it.',
    inputSchema: {
      type: "object",
      properties: {
        expr: { type: "string", description: 'e.g. "50+40*sin(t/3)"' },
        seconds: { type: "number", minimum: 1, maximum: 3600, default: 120 },
        stepSeconds: { type: "number", minimum: 0.2, maximum: 5, default: 0.5 },
        motor: { type: "string", enum: ["suction", "vibrate", "electric"], default: "suction" },
      },
      required: ["expr"],
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
      const peak = quantize(args?.peak ?? 80);
      const cycles = args?.cycles ?? 3;
      const steps = [];
      for (let i = 0; i < cycles; i++) {
        steps.push(
          { motor: MOTOR[kind], level: 10, hold: 1000 },
          { motor: MOTOR[kind], level: peak, hold: 1200 },
          { motor: MOTOR[kind], level: 0, hold: 600 }
        );
      }
      const n = await runSteps(group, userId, steps);
      return textResult(`Ran ${cycles} ${kind} wave cycle(s) up to ${peak}%, ${n} steps, then stopped.`);
    }
    case "toy_sequence": {
      const kind = args?.motor || "suction";
      const loops = Math.max(1, Math.min(200, Number(args?.loops ?? 1)));
      const parsed = parsePattern(args?.steps, MOTOR[kind]);
      if (parsed.error) return textResult(parsed.error, true);

      const steps = [];
      for (let i = 0; i < loops; i++) steps.push(...parsed.steps);
      const totalMs = steps.reduce((a, s) => a + s.hold, 0);

      // Reachability is checked here, before we hand the pattern off to the
      // background — otherwise an offline toy would still get a cheerful
      // "started" while nothing moves on the other end.
      if (!(await isOnline(group))) return textResult(KISSTOY_UNREACHABLE, true);

      const secs = Math.round(totalMs / 1000);
      const pretty = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
      runInBackground(runSteps(group, userId, steps));
      return textResult(
        `Sequence started in the background: ${steps.length} steps, ${pretty} total. ` +
          `It keeps playing on its own — stay with her instead of waiting on it, and do not re-issue it. ` +
          `A new sequence replaces this one; toy_stop ends it.`
      );
    }
    case "toy_formula": {
      const kind = args?.motor || "suction";
      const seconds = Math.max(1, Math.min(3600, Number(args?.seconds ?? 120)));
      const stepSeconds = Math.max(0.2, Math.min(5, Number(args?.stepSeconds ?? 0.5)));

      let evaluate;
      try {
        evaluate = compileFormula(args?.expr);
      } catch (err) {
        return textResult(`Could not read that formula: ${err.message}`, true);
      }

      const steps = [];
      for (let t = 0; t < seconds; t += stepSeconds) {
        let v = evaluate(t);
        if (!Number.isFinite(v)) v = 0;
        steps.push({ motor: MOTOR[kind], level: quantize(v), hold: stepSeconds * 1000 });
      }
      if (!steps.length) return textResult("That produced no steps — check `seconds` and `stepSeconds`.", true);

      if (!(await isOnline(group))) return textResult(KISSTOY_UNREACHABLE, true);

      const levels = steps.map((s) => s.level);
      const lo = Math.min(...levels);
      const hi = Math.max(...levels);
      const shape = steps.slice(0, 8).map((s) => s.level).join(" → ");
      runInBackground(runSteps(group, userId, steps));
      return textResult(
        `Formula started in the background: ${steps.length} points over ${Math.round(seconds)}s, ` +
          `ranging ${lo}%-${hi}%. Opens with ${shape}${steps.length > 8 ? " → …" : ""}. ` +
          `Stay with her while it plays; a new sequence or formula replaces it, toy_stop ends it.`
      );
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
  async fetch(request, env, ctx) {
    CURRENT_CTX = ctx; // background patterns outlive the response; see runInBackground
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
