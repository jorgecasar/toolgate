// The router probes a local daemon (GET /health, 1 s) before it queries, and says in `warnings` (the channel the Step 0 rule relays) when it
// is down or hung. Fakes only: the fetch and the qmd CLI are stubs, and no port is opened, so nothing here reaches the user's daemon.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { formatNeed, resolveNeed } from "../src/need.js";
import { createQmdBackend, registerBackend, resetBackends, route } from "../src/router.js";
beforeEach(() => resetBackends());
const config = { skills: { collection: "skills" }, baseline: ["docs"], keywords: {}, serverMeta: {} };
const PORT = 18291;
const MCP = `http://localhost:${PORT}/mcp`;
const DOWN = `the qmd daemon is not running on port ${PORT}; skills are found by keyword only until it runs: toolgate daemon start`;
const HUNG = `the qmd daemon on port ${PORT} is not answering; skills are found by keyword only until it is restarted: toolgate daemon restart`;
const answer = (body) => ({ ok: true, status: 200, headers: new Map([["content-type", "application/json"], ["mcp-session-id", "s"]]), text: async () => JSON.stringify(body), json: async () => body });
// A fetch recording every URL: /health answers with `health`, anything else is the MCP daemon answering with `mcp`.
function fake({ health, mcp }) {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith("/health")) return health(url, init);
    return mcp(url, init);
  };
  return { fetchFn, urls };
}
const mcpOk = (_url, init) => {
  const body = JSON.parse(init.body);
  return answer({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/call" ? { structuredContent: { results: [] } } : {} });
};
const healthy = () => answer({ status: "ok", uptime: 1 });
// Pending until the signal fires, with a timer of its own that keeps the event loop alive (the timeout of an AbortSignal does not; on Linux the loop would empty first).
const timedOut = (_url, init) =>
  new Promise((_resolve, reject) => {
    const keepAlive = setInterval(() => {}, 20);
    init.signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      reject(init.signal.reason);
    });
  });
function backendOf(fetchFn, extra = {}) {
  const cli = [];
  registerBackend("qmd", createQmdBackend({ fetchFn, execFn: (bin, args) => (cli.push(args), "[]"), ...extra }));
  return cli;
}
const run = (cfg = config) => route("summarize project context", cfg, { backend: "qmd" });
test("a refused connection says the daemon is not running, with the exact text and the command, and the query falls back to the CLI without trying the MCP URL", async () => {
  const { fetchFn, urls } = fake({ health: () => Promise.reject(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })), mcp: mcpOk });
  const cli = backendOf(fetchFn, { daemonUrl: MCP });
  const result = await run();
  assert.deepEqual(result.warnings, [DOWN]);
  assert.equal(cli.length, 1, "the CLI answered");
  assert.deepEqual(urls, [`http://localhost:${PORT}/health`]);
  assert.match(result.reason, /QMD daemon unavailable \(not running\); falling back to CLI search/);
});
test("a probe that times out says the daemon is not answering, and costs about one second, not more", async () => {
  const { fetchFn } = fake({ health: timedOut, mcp: mcpOk });
  const cli = backendOf(fetchFn, { daemonUrl: MCP });
  const started = Date.now();
  const result = await run();
  const took = Date.now() - started;
  assert.deepEqual(result.warnings, [HUNG]);
  assert.equal(cli.length, 1);
  assert.ok(took >= 900 && took < 2500, `took ${took} ms`);
});
test("the probe does not follow a redirect, and a 3xx is hung", async () => {
  const inits = [];
  const { fetchFn, urls } = fake({ health: (_url, init) => (inits.push(init.redirect), { ok: false, status: 302, json: async () => ({}) }), mcp: mcpOk });
  backendOf(fetchFn, { daemonUrl: MCP });
  assert.deepEqual((await run()).warnings, [HUNG]);
  assert.deepEqual(inits, ["manual"]);
  assert.deepEqual(urls, [`http://localhost:${PORT}/health`]);
});
test("a /health that answers without 2xx is hung too", async () => {
  const { fetchFn } = fake({ health: () => ({ ok: false, status: 503, json: async () => ({}) }), mcp: mcpOk });
  backendOf(fetchFn, { daemonUrl: MCP });
  assert.deepEqual((await run()).warnings, [HUNG]);
});
test("a 2xx probe followed by an MCP failure says hung, and falls back to the CLI", async () => {
  const { fetchFn } = fake({ health: healthy, mcp: () => Promise.reject(new Error("MCP timed out")) });
  const cli = backendOf(fetchFn, { daemonUrl: MCP });
  const result = await run();
  assert.deepEqual(result.warnings, [HUNG]);
  assert.equal(cli.length, 1);
  assert.match(result.reason, /QMD daemon unavailable \(MCP timed out\)/);
});
test("a daemon that is up and fresh adds no warning and is not asked twice", async () => {
  const { fetchFn } = fake({ health: healthy, mcp: mcpOk });
  const cli = backendOf(fetchFn, { daemonUrl: MCP });
  assert.deepEqual((await run()).warnings, []);
  assert.equal(cli.length, 0, "the CLI was not needed");
});
test("a remote qmdUrl that fails gets the one warning with the origin and no command, and is not probed", async () => {
  const { fetchFn, urls } = fake({ health: healthy, mcp: () => Promise.reject(new Error("boom")) });
  const cli = backendOf(fetchFn);
  const result = await run({ ...config, router: { qmdUrl: "https://qmd.example.com:9000/mcp?token=secret" } });
  assert.deepEqual(result.warnings, ["the qmd server at https://qmd.example.com:9000 is not answering; skills are found by keyword only"]);
  assert.equal(cli.length, 1);
  assert.ok(urls.every((url) => !url.endsWith("/health")), "toolgate does not probe a server it does not manage");
});
test("qmdUrl null says nothing and asks nobody", async () => {
  const { fetchFn, urls } = fake({ health: healthy, mcp: mcpOk });
  const cli = backendOf(fetchFn);
  assert.deepEqual((await run({ ...config, router: { qmdUrl: null } })).warnings, []);
  assert.deepEqual(urls, []);
  assert.equal(cli.length, 1);
});
test("router.qmdUrl pointing at a local port is probed on that port", async () => {
  const { fetchFn, urls } = fake({ health: () => Promise.reject(new Error("ECONNREFUSED")), mcp: mcpOk });
  backendOf(fetchFn);
  const result = await run({ ...config, router: { qmdUrl: "http://127.0.0.1:18292/mcp" } });
  assert.deepEqual(result.warnings, [DOWN.replaceAll(String(PORT), "18292")]);
  assert.deepEqual(urls, ["http://localhost:18292/health"]);
});
test("need carries the warning in the JSON and in the text", async () => {
  const { fetchFn } = fake({ health: () => Promise.reject(new Error("ECONNREFUSED")), mcp: mcpOk });
  backendOf(fetchFn, { daemonUrl: MCP });
  const result = await run();
  const { result: needed } = resolveNeed(result, { state: { extras: [], toolExtras: {}, pendingRestart: false } });
  assert.deepEqual(needed.warnings, [DOWN]);
  assert.match(formatNeed(needed), new RegExp(`^warning: ${DOWN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});
