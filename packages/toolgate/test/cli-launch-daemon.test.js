// A launch that uses the qmd backend makes sure the shared daemon answers, with or without a prompt (`need` inside an interactive session
// queries it too). Fake `ensure` and fake adapter: no process is started and no port is opened.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli.js";
import { registerBackend, resetBackends } from "../src/router.js";
afterEach(() => resetBackends());
const PORT = "18293";
function launchWith({ config = { baseline: [] }, ensure, argv }) {
  const calls = [];
  const err = [];
  const adapter = { launch: async () => ({ code: 0 }) };
  const deps = {
    cwd: "/project",
    stdout: { write() {} },
    stderr: { write: (s) => err.push(s) },
    env: { TOOLGATE_ADAPTER: "claude-code", QMD_SHARED_PORT: PORT },
    loadConfigFn: () => config,
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {},
    adapters: { "claude-code": () => Promise.resolve(adapter) },
    daemon: { ensure: async (options) => (calls.push(options), ensure ? ensure(options) : { running: true, started: false }) },
  };
  return { calls, err, go: () => run(argv, deps) };
}
const qmd = { baseline: [], router: { backend: "qmd" } };
test("an interactive launch with no prompt makes sure the daemon answers, once, on the managed port", async () => {
  const t = launchWith({ config: qmd, argv: [] });
  assert.equal(await t.go(), 0);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].port, Number(PORT));
});
test("a launch with a prompt does too, once", async () => {
  // The prompt is routed: a backend of its own keeps the test from reaching the qmd CLI.
  registerBackend("qmd", { match: async () => ({ servers: [], reasons: [], skills: [], commands: [], subagents: [], warnings: [] }) });
  const t = launchWith({ config: qmd, argv: ["do the thing"] });
  assert.equal(await t.go(), 0);
  assert.equal(t.calls.length, 1);
});
test("the regex backend, by flag or by config, and --no-route do not start it", async () => {
  for (const [name, t] of [
    ["config regex", launchWith({ config: { baseline: [], router: { backend: "regex" } }, argv: [] })],
    ["no backend set", launchWith({ argv: [] })],
    ["--backend regex", launchWith({ config: qmd, argv: ["--backend", "regex"] })],
    ["--no-route", launchWith({ config: qmd, argv: ["--no-route"] })],
    ["qmdUrl null", launchWith({ config: { baseline: [], router: { backend: "qmd", qmdUrl: null } }, argv: [] })],
  ]) {
    assert.equal(await t.go(), 0, name);
    assert.equal(t.calls.length, 0, name);
  }
});
test("when the daemon cannot be started the launch goes on and says so, and when it started it says that", async () => {
  const failed = launchWith({ config: qmd, argv: [], ensure: async () => ({ running: false, reason: "did not answer" }) });
  assert.equal(await failed.go(), 0);
  assert.match(failed.err.join(""), /^toolgate: qmd daemon unavailable \(did not answer\); routing falls back to the qmd CLI\n/m);
  const started = launchWith({ config: qmd, argv: [], ensure: async () => ({ running: true, started: true }) });
  assert.equal(await started.go(), 0);
  assert.match(started.err.join(""), new RegExp(`toolgate: started the shared qmd daemon on port ${PORT}\\n`));
});
