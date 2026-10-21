// The catalog's MCP client: what it lists, and the limits it keeps against a server it does not trust.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { introspect, introspectHttp, introspectStdio } from "../src/catalog/introspect.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/catalog-server.js", import.meta.url));
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cat-"));
  made.push(dir);
  return dir;
};
const stdio = (mode, env = {}) => ({ transport: "stdio", command: process.execPath, args: [FIXTURE], env: { MODE: mode, ...env } });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Under load a process starts late and dies late: wait for what the test needs instead of a fixed pause or a tight timeout.
const waitUntil = async (done, ms = 5000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline && !done(); ) await new Promise((resolve) => setTimeout(resolve, 25));
  return done();
};
const pidsOf = async (pidFile) => {
  await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().split(" ").length >= 2);
  return fs.readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
};
const goneWithin = (pid) => waitUntil(() => !alive(pid));

test("a stdio server is started, listed and stopped: tools, descriptions and the size of its instructions", async () => {
  const result = await introspectStdio(stdio("ok"), { timeoutMs: 10000 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tools, [{ name: "alpha", description: "First tool" }, { name: "beta", description: "Second tool" }]);
  assert.equal(result.instructionsChars, "Use me well.".length);
  assert.equal(result.auth, "none");
});

test("a server that does not answer is stopped at the timeout, and so is everything it started", async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "pids");
  const result = await introspectStdio(stdio("hang", { PID_FILE: pidFile }), { timeoutMs: 2000 });
  assert.equal(result.status, "error");
  assert.match(result.reason, /no answer within/);
  const [server, grandchild] = await pidsOf(pidFile);
  assert.equal(await goneWithin(server), true, "the server is gone");
  assert.equal(await goneWithin(grandchild), true, "the process it started is gone too");
});

test("what the server left behind is stopped too: a child that ignores TERM, and a daemon of a server that already exited", async () => {
  for (const mode of ["stubborn", "daemon"]) {
    const pidFile = path.join(tmp(), "pids");
    const result = await introspectStdio(stdio(mode, { PID_FILE: pidFile }), { timeoutMs: mode === "daemon" ? 10000 : 2000 });
    assert.equal(result.status, mode === "daemon" ? "ok" : "error", mode);
    const [server, grandchild] = await pidsOf(pidFile);
    assert.equal(await goneWithin(server), true, `${mode}: the server is gone`);
    assert.equal(await goneWithin(grandchild), true, `${mode}: what it left behind is gone`);
  }
});

test("a message over the size limit is an error, not memory", async () => {
  const result = await introspectStdio(stdio("big"), { timeoutMs: 10000 });
  assert.equal(result.status, "error");
  assert.match(result.reason, /output too large/);
  const line = await introspectStdio(stdio("bigline"), { timeoutMs: 10000 });
  assert.match(line.reason, /output too large/, "one complete line over the limit");
});

test("the environment is only what the definition declares plus PATH and HOME", async () => {
  const hidden = await introspectStdio(stdio("env"), { env: { PATH: process.env.PATH, HOME: "/h", SECRET_PROBE: "leaked" }, timeoutMs: 10000 });
  assert.equal(hidden.tools[0].description, "secret=absent");
  const declared = await introspectStdio(stdio("env", { SECRET_PROBE: "given" }), { env: { PATH: process.env.PATH }, timeoutMs: 10000 });
  assert.equal(declared.tools[0].description, "secret=given");
});

test("a server that wants a login is skipped as OAuth, and a command that cannot start is an error", async () => {
  assert.deepEqual(await introspectStdio(stdio("oauth"), { timeoutMs: 10000 }), { status: "skipped", reason: "needs OAuth or a login", auth: "oauth" });
  const missing = await introspectStdio({ transport: "stdio", command: "/nonexistent/server", args: [], env: {} }, { timeoutMs: 5000 });
  assert.equal(missing.status, "error");
});

test("hostile names and descriptions: unsafe or repeated names are dropped, text is one line and cut, controls are gone, and tools are capped", async () => {
  const hostile = await introspectStdio(stdio("hostile"), { timeoutMs: 10000 });
  assert.deepEqual(hostile.tools.map((t) => t.name), ["good", "long"]);
  assert.equal(hostile.droppedTools, 2);
  assert.doesNotMatch(hostile.tools[0].description, /[\n‮\u0007]/);
  assert.equal(hostile.tools[1].description.length, 4096);
  const many = await introspectStdio(stdio("many"), { timeoutMs: 10000 });
  assert.equal(many.tools.length, 500);
  assert.equal(many.droppedTools, 100);
});

test("a url with credentials is refused, and no reason repeats them", async () => {
  const leaking = async (url) => {
    throw new Error(`Request cannot be constructed from a URL that includes credentials: ${url}`);
  };
  const result = await introspectHttp({ transport: "http", url: "https://user:pw@x.test/mcp", headers: {} }, { fetchFn: (url) => leaking(url) });
  assert.equal(result.status, "error");
  assert.doesNotMatch(result.reason, /user|pw/);
});

test("an http server: JSON and event-stream replies, the session id is kept, a 401 is OAuth, nothing is followed", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, session: init.headers["mcp-session-id"], redirect: init.redirect });
    if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { instructions: "abc" } }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "remote", description: "Remote" }] } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const result = await introspectHttp({ transport: "http", url: "https://mcp.example.test/mcp", headers: { authorization: "Bearer t" } }, { fetchFn });
  assert.deepEqual([result.status, result.tools, result.instructionsChars], ["ok", [{ name: "remote", description: "Remote" }], 3]);
  assert.deepEqual(calls.map((c) => [c.method, c.session, c.redirect]), [["initialize", undefined, "error"], ["notifications/initialized", "s1", "error"], ["tools/list", "s1", "error"]]);
  const login = await introspect({ transport: "http", url: "https://mcp.example.test/mcp", headers: {} }, { fetchFn: async () => new Response("", { status: 401 }) });
  assert.deepEqual(login, { status: "skipped", reason: "needs OAuth or a login", auth: "oauth" });
  const big = await introspectHttp({ transport: "http", url: "https://mcp.example.test/mcp", headers: {} }, { fetchFn: async () => new Response("x".repeat(2 * 1024 * 1024), { status: 200, headers: { "content-type": "application/json" } }) });
  assert.match(big.reason, /output too large/);
});
