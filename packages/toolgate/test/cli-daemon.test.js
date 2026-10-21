import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureQmdDaemon, run } from "../src/cli.js";
import { COLD_START_ATTEMPTS } from "../src/daemon.js";
import { registerBackend, resetBackends } from "../src/router.js";

function setup(daemon, env = {}) {
  const out = [];
  const err = [];
  const deps = {
    env,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    daemon,
  };
  return { deps, out: () => out.join(""), err: () => err.join("") };
}

test("daemon status: exits 0 with the url and uptime when running, 1 when not", async () => {
  const running = setup({
    status: async () => ({ running: true, url: "http://localhost:8181/mcp", uptime: 7 }),
  });
  assert.equal(await run(["daemon", "status"], running.deps), 0);
  assert.match(running.out(), /running on http:\/\/localhost:8181\/mcp \(uptime 7s\)/);

  const idle = setup({ status: async () => ({ running: false }) });
  assert.equal(await run(["daemon", "status"], idle.deps), 1);
  assert.match(idle.out(), /not running on port 8181/);
  const hung = setup({ status: async () => ({ running: false, state: "hung" }) });
  assert.equal(await run(["daemon", "status"], hung.deps), 1);
  assert.match(hung.out(), /^toolgate: qmd daemon not answering on port 8181\n$/);
});

test("daemon start: reports started or already running, and fails loudly when it never answers", async () => {
  const seen = [];
  const ensure = (result) => async (opts) => {
    seen.push(opts);
    return result;
  };
  const started = setup({ ensure: ensure({ running: true, started: true, url: "u" }) });
  assert.equal(await run(["daemon", "start", "--port", "9100"], started.deps), 0);
  assert.deepEqual(seen.map(({ env, stderr, ...rest }) => rest), [{ port: 9100, qmdBin: "qmd", attempts: COLD_START_ATTEMPTS }]);
  assert.match(started.out(), /started on u/);

  const already = setup({ ensure: ensure({ running: true, started: false, url: "u" }) });
  assert.equal(await run(["daemon", "start"], already.deps), 0);
  assert.match(already.out(), /already running on u/);

  const failed = setup({ ensure: ensure({ running: false, reason: "never answered" }) });
  assert.equal(await run(["daemon", "start"], failed.deps), 1);
  assert.match(failed.err(), /toolgate daemon: never answered/);
});

test("daemon: the port comes from --port, then QMD_SHARED_PORT, then 8181", async () => {
  const ports = [];
  const daemon = { status: async ({ port }) => (ports.push(port), { running: true, url: "u" }) };
  await run(["daemon", "status"], setup(daemon).deps);
  await run(["daemon", "status"], setup(daemon, { QMD_SHARED_PORT: "9200" }).deps);
  await run(["daemon", "status", "--port", "9300"], setup(daemon, { QMD_SHARED_PORT: "9200" }).deps);
  assert.deepEqual(ports, [8181, 9200, 9300]);
});

test("daemon stop: exits 0 unless qmd could not be run; unknown action is a usage error", async () => {
  const ok = setup({ stop: () => ({ ok: true, message: "Stopped." }) });
  assert.equal(await run(["daemon", "stop"], ok.deps), 0);
  assert.match(ok.out(), /Stopped\./);

  const failed = setup({ stop: () => ({ ok: false, message: "could not stop qmd daemon: ENOENT" }) });
  assert.equal(await run(["daemon", "stop"], failed.deps), 1);
  assert.match(failed.err(), /ENOENT/);

  const usage = setup({});
  assert.equal(await run(["daemon", "bogus"], usage.deps), 1);
  assert.match(usage.err(), /expected start, status, stop or restart/);
});

function ensureSetup(result) {
  const calls = [];
  const lines = [];
  return {
    calls,
    lines,
    stderr: { write: (s) => lines.push(s) },
    ensureFn: async (opts) => (calls.push(opts), result),
  };
}

test("ensureQmdDaemon: only manages a local daemon for the qmd backend", async () => {
  const qmd = { router: { backend: "qmd" } };
  const regex = ensureSetup({ running: true });
  await ensureQmdDaemon({ config: { router: { backend: "regex" } }, env: {}, ...regex });
  await ensureQmdDaemon({ config: {}, env: {}, ...regex });
  await ensureQmdDaemon({ config: { router: { backend: "qmd", qmdUrl: null } }, env: {}, ...regex });
  await ensureQmdDaemon({
    config: { router: { backend: "qmd", qmdUrl: "http://qmd.example.com/mcp" } },
    env: {},
    ...regex,
  });
  assert.deepEqual(regex.calls, []);

  const managed = ensureSetup({ running: true, started: false });
  await ensureQmdDaemon({ config: {}, backend: "qmd", env: { QMD_SHARED_PORT: "9100" }, ...managed });
  await ensureQmdDaemon({ config: qmd, env: {}, ...managed });
  assert.deepEqual(managed.calls.map(({ env, stderr, ...rest }) => rest), [{ port: 9100, qmdBin: "qmd" }, { port: 8181, qmdBin: "qmd" }]);
  assert.deepEqual(managed.lines, []);
});

test("ensureQmdDaemon: says when it started the daemon and warns when it cannot", async () => {
  const config = { router: { backend: "qmd" } };
  const started = ensureSetup({ running: true, started: true });
  await ensureQmdDaemon({ config, env: {}, ...started });
  assert.match(started.lines.join(""), /started the shared qmd daemon on port 8181/);

  const failed = ensureSetup({ running: false, reason: "qmd not found" });
  await ensureQmdDaemon({ config, env: {}, ...failed });
  assert.match(
    failed.lines.join(""),
    /qmd daemon unavailable \(qmd not found\); routing falls back to the qmd CLI/
  );
});

test("launch with the qmd backend ensures the daemon once and still launches; no-route skips it", async () => {
  const launches = [];
  const adapter = { launch: async (args) => (launches.push(args), { code: 0 }) };
  const ensures = [];
  const make = () => ({
    ...setup({ ensure: async (opts) => (ensures.push(opts), { running: false, reason: "down" }) }).deps,
    cwd: "/project",
    env: { TOOLGATE_ADAPTER: "claude-code" },
    loadConfigFn: () => ({ router: { backend: "qmd", qmdUrl: "http://localhost:9100/mcp" } }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {},
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });

  registerBackend("qmd", { match: () => ({ servers: [], skills: [], reason: "stub" }) });
  try {
    assert.equal(await run(["--no-route", "do it"], make()), 0);
    assert.deepEqual(ensures, []);

    assert.equal(await run(["do it"], make()), 0);
    assert.deepEqual(ensures.map(({ env, stderr, ...rest }) => rest), [{ port: 9100, qmdBin: "qmd" }]);
    assert.equal(launches.length, 2);
  } finally {
    resetBackends();
  }
});

test("daemon restart: stops it and starts it again, and reports either step failing", async () => {
  const steps = [];
  const down = async () => ({ running: false });
  const ok = setup({
    status: down,
    stop: () => (steps.push("stop"), { ok: true, message: "Stopped." }),
    ensure: async ({ port }) => (steps.push(`start ${port}`), { running: true, started: true, url: "http://localhost:8181/mcp" }),
  });
  assert.equal(await run(["daemon", "restart", "--port", "9100"], ok.deps), 0);
  assert.deepEqual(steps, ["stop", "start 9100"]);
  assert.match(ok.out(), /qmd daemon restarted on http:\/\/localhost:8181\/mcp/);

  const cannotStop = setup({ stop: () => ({ ok: false, message: "could not stop qmd daemon: ENOENT" }), ensure: async () => assert.fail("must not start") });
  assert.equal(await run(["daemon", "restart"], cannotStop.deps), 1);
  assert.match(cannotStop.err(), /ENOENT/);

  const neverAnswers = setup({ status: down, stop: () => ({ ok: true, message: "Stopped." }), ensure: async () => ({ running: false, reason: "did not answer" }) });
  assert.equal(await run(["daemon", "restart"], neverAnswers.deps), 1);
  assert.match(neverAnswers.err(), /did not answer/);
});

test("daemon restart: a process toolgate did not start holding the port exits 1 with its pid and the command to run", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-managed-"));
  fs.mkdirSync(path.join(cache, "qmd"));
  fs.writeFileSync(path.join(cache, "qmd", "mcp.pid"), "1\n");
  process.on("exit", () => fs.rmSync(cache, { recursive: true, force: true }));
  const stuck = setup({
    stop: () => ({ ok: true, message: "stopped" }),
    status: async () => ({ running: true, url: "u" }),
    ensure: async () => assert.fail("no start over a foreign process"),
    sleep: async () => {},
    holder: () => ({ pid: 4242, foreign: true }),
  }, { XDG_CACHE_HOME: cache });
  assert.equal(await run(["daemon", "restart"], stuck.deps), 1);
  assert.match(stuck.err(), /^toolgate daemon: port 8181 is held by pid 4242, which toolgate did not start; stop it with "(kill 4242|taskkill \/PID 4242)" and run "toolgate daemon start"\n$/);
  assert.equal(stuck.out(), "");
});
test("daemon status: a foreign process on the port adds its pid and exits 0; its own daemon and an unknown holder add nothing", async () => {
  const status = (holder) => setup({ status: async () => ({ running: true, url: "http://localhost:8181/mcp", uptime: 7 }), holder: () => holder });
  const foreign = status({ pid: 4242, foreign: true });
  assert.equal(await run(["daemon", "status"], foreign.deps), 0);
  assert.equal(foreign.out(), "toolgate: qmd daemon running on http://localhost:8181/mcp (uptime 7s) (pid 4242, not started by toolgate)\n");
  for (const holder of [{ pid: 4242, foreign: false }, { pid: null, foreign: null }]) {
    const own = status(holder);
    assert.equal(await run(["daemon", "status"], own.deps), 0);
    assert.equal(own.out(), "toolgate: qmd daemon running on http://localhost:8181/mcp (uptime 7s)\n");
  }
});

test("daemon start and status use the port of qmd.port, the environment and --port, in that order of weakness", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-qmdport-"));
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  const user = path.join(cwd, "user.json");
  fs.writeFileSync(user, JSON.stringify({ qmd: { port: 18282 } }));
  const seen = [];
  const daemon = { status: async (opts) => (seen.push(opts.port), { running: false }), ensure: async () => ({ running: false }), stop: async () => ({}), holder: () => null };
  const statusPort = async (env, extra = []) => {
    seen.length = 0;
    const t = setup(daemon, { TOOLGATE_DEFAULTS: user, ...env });
    await run(["daemon", "status", ...extra], { ...t.deps, cwd });
    return seen[0];
  };
  assert.equal(await statusPort({}), 18282, "the key");
  assert.equal(await statusPort({ QMD_SHARED_PORT: "18283" }), 18283, "the environment");
  assert.equal(await statusPort({ QMD_SHARED_PORT: "18283" }, ["--port", "18284"]), 18284, "the flag");
  fs.writeFileSync(user, "{}");
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), JSON.stringify({ qmd: { port: 18282 } }));
  assert.equal(await statusPort({}), 8181, "a project file does not choose the port");
});
