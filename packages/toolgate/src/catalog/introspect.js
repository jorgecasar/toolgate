// A minimal MCP client: `initialize`, then `tools/list`, against one server, with limits. Everything it reads is untrusted.
import { spawn } from "node:child_process";
import { MAX_DESCRIPTION, MAX_MESSAGE_BYTES, MAX_TOOLS, SAFE_TOOL, oneLine, redact } from "./sanitize.js";

export const DEFAULT_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = "2025-06-18";
const KILL_GRACE_MS = 500;
const OAUTH = /oauth|unauthori[sz]ed|authenticat|forbidden|401|403/i;

const initializeParams = () => ({ protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "toolgate", version: "0" } });

/** The tools of a `tools/list` result that are safe to write, capped; `dropped` counts the ones that were not. */
export function takeTools(raw, seen = new Set(), result = { tools: [], dropped: 0 }) {
  for (const tool of Array.isArray(raw) ? raw : []) {
    const name = tool !== null && typeof tool === "object" ? tool.name : undefined;
    if (typeof name !== "string" || !SAFE_TOOL.test(name) || seen.has(name) || result.tools.length >= MAX_TOOLS) {
      result.dropped++;
      continue;
    }
    seen.add(name);
    result.tools.push({ name, description: oneLine(tool.description, MAX_DESCRIPTION) });
  }
  return result;
}

const skipped = (reason, auth = "none") => ({ status: "skipped", reason, auth });
// Only the front of the text is shown (300 characters), so only the front is scrubbed: a server cannot make the scrub long.
const failed = (reason) => ({ status: "error", reason: oneLine(redact(String(reason).slice(0, 2000)), 300) });

function finish({ tools, dropped }, initialize) {
  const instructions = initialize?.instructions;
  return { status: "ok", auth: "none", tools, droppedTools: dropped, instructionsChars: typeof instructions === "string" ? instructions.length : 0 };
}

// The children that are running now. If toolgate is interrupted (Ctrl-C, a signal, an exit) they are killed with their whole
// group: a server must not outlive the build that started it.
const running = new Set();
let guarded = false;
function killAll(signal = "SIGKILL") {
  for (const child of running) {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  }
}
function guard() {
  if (guarded) return;
  guarded = true;
  process.on("exit", () => killAll());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      killAll();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// TERM to the group, a short wait for the server to leave, then KILL to the whole group: also what the server left behind
// (a child that ignores TERM, a daemon it forked). Nothing is left running when this returns.
async function killGroup(child) {
  const send = (signal) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  };
  const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("close", resolve));
  send("SIGTERM");
  await Promise.race([closed, sleep(KILL_GRACE_MS)]);
  send("SIGKILL");
  await Promise.race([closed, sleep(KILL_GRACE_MS)]);
}

/**
 * Starts the server, lists its tools and stops it (the whole process group). The environment is only what the definition
 * declares plus PATH and HOME; nothing else of toolgate's own is passed on.
 */
export async function introspectStdio(def, { env = process.env, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, spawnFn = spawn } = {}) {
  const childEnv = { ...(env.PATH ? { PATH: env.PATH } : {}), ...(env.HOME ? { HOME: env.HOME } : {}), ...def.env };
  let child;
  try {
    child = spawnFn(def.command, def.args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
  } catch (err) {
    return failed(`could not start: ${err.message}`);
  }
  guard();
  running.add(child);
  const pending = new Map();
  let buffer = "";
  let broken = null;
  const fail = (message) => {
    broken ??= message;
    for (const entry of pending.values()) entry.reject(new Error(broken));
    pending.clear();
  };
  child.on("error", (err) => fail(`could not start: ${err.message}`));
  child.on("close", () => fail("the server stopped before it answered"));
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_MESSAGE_BYTES * 2 && !buffer.includes("\n")) return fail("output too large");
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.length > MAX_MESSAGE_BYTES) return fail("output too large");
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message === null || typeof message !== "object" || message.id === undefined) continue;
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      entry.resolve(message);
    }
  });
  let nextId = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    if (broken) return reject(new Error(broken));
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  const ask = (method, params) => Promise.race([request(method, params), deadline]);
  try {
    const init = await ask("initialize", initializeParams());
    if (init.error) return OAUTH.test(String(init.error.message)) ? skipped("needs OAuth or a login", "oauth") : failed(`initialize: ${init.error.message}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const result = { tools: [], dropped: 0 };
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const reply = await ask("tools/list", cursor ? { cursor } : {});
      if (reply.error) return OAUTH.test(String(reply.error.message)) ? skipped("needs OAuth or a login", "oauth") : failed(`tools/list: ${reply.error.message}`);
      takeTools(reply.result?.tools, seen, result);
      cursor = reply.result?.nextCursor;
      if (typeof cursor !== "string" || cursor === "" || result.tools.length >= MAX_TOOLS) break;
    }
    return finish(result, init.result);
  } catch (err) {
    return failed(broken ?? err.message);
  } finally {
    clearTimeout(timer);
    await killGroup(child);
    running.delete(child);
  }
}

async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_MESSAGE_BYTES) {
      await reader.cancel();
      throw new Error("output too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

// A reply is JSON, or a server-sent event stream whose first `data:` line is the message.
function messageOf(text, contentType) {
  if (/text\/event-stream/.test(contentType ?? "")) {
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return data ? JSON.parse(data.slice(5)) : null;
  }
  return text.trim() ? JSON.parse(text) : null;
}

/** The same, against an http server. No redirect is followed and no browser is opened: a login is reported, not done. */
export async function introspectHttp(def, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let session;
  let nextId = 0;
  const post = async (body) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION, ...def.headers, ...(session ? { "mcp-session-id": session } : {}) };
    const response = await fetchFn(def.url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal });
    if (response.status === 401 || response.status === 403) return { oauth: true };
    if (!response.ok) throw new Error(`http ${response.status}`);
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    return { message: messageOf(await readCapped(response), response.headers.get("content-type")) };
  };
  try {
    const init = await post({ jsonrpc: "2.0", id: ++nextId, method: "initialize", params: initializeParams() });
    if (init.oauth) return skipped("needs OAuth or a login", "oauth");
    if (init.message?.error) return OAUTH.test(String(init.message.error.message)) ? skipped("needs OAuth or a login", "oauth") : failed(`initialize: ${init.message.error.message}`);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const result = { tools: [], dropped: 0 };
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const reply = await post({ jsonrpc: "2.0", id: ++nextId, method: "tools/list", params: cursor ? { cursor } : {} });
      if (reply.oauth) return skipped("needs OAuth or a login", "oauth");
      if (reply.message?.error) return failed(`tools/list: ${reply.message.error.message}`);
      takeTools(reply.message?.result?.tools, seen, result);
      cursor = reply.message?.result?.nextCursor;
      if (typeof cursor !== "string" || cursor === "" || result.tools.length >= MAX_TOOLS) break;
    }
    return finish(result, init.message?.result);
  } catch (err) {
    return failed(err.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : err.message);
  }
}

export const introspect = (def, options) => (def.transport === "http" ? introspectHttp(def, options) : introspectStdio(def, options));
