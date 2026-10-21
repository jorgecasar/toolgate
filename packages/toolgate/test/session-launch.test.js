// The session of a launch (#19 T7): made for the servers toolgate-proxy wraps, kept by a relaunch, refreshed, removed at the end.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRegistry } from "../src/adapters/index.js";
import { run } from "../src/cli.js";
import * as claude from "../src/adapters/claude-code.js";
import { createSession, readSession, sessionsRoot } from "../src/session.js";
import { EventEmitter } from "node:events";
import { isProxied } from "../src/proxied.js";
import { REFRESH_MS, launchEnv, sessionFor, wrappedActive, wrappedServers } from "../src/sessionLaunch.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (label = "sl") => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-${label}-`)));
  made.push(dir);
  return dir;
};
const PROXY = { command: "node", args: ["toolgate-proxy"], env: { TOOLGATE_UPSTREAM_CMD: "x" } };
// A wrapped entry names its server (TOOLGATE_SERVER) for the launcher to put it in a session; the helper sets it as the user's file would.
const named_ = (name, def) => (def?.command === "node" && Array.isArray(def.args) && def.args.includes("toolgate-proxy")) || def?.command === "toolgate-proxy" ? { ...def, env: { ...def.env, TOOLGATE_SERVER: name } } : def;
const mcpJson = (cwd, servers) => fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([name, def]) => [name, named_(name, def)])) }));
const mode = (target) => fs.statSync(target).mode & 0o777;
const idle = { extras: [], toolExtras: {}, pendingRestart: false };
const named = (names) => names.map((server) => ({ server, baseline: [] }));

test("wrappedActive: a wrapped entry that does not set TOOLGATE_SERVER to its own name is not put in a session", () => {
  const cwd = tmp();
  const mcpJsonPath = path.join(cwd, ".mcp.json");
  const entry = (server) => ({ command: "toolgate-proxy", env: { TOOLGATE_UPSTREAM_CMD: "x", ...(server === undefined ? {} : { TOOLGATE_SERVER: server }) } });
  fs.writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { marked: entry("marked"), unmarked: entry(), other: entry("marked"), numeric: entry(5), bare: { command: "toolgate-proxy" } } }));
  const config = { baseline: ["marked", "unmarked", "other", "numeric", "bare"] };
  assert.deepEqual(wrappedActive({ config, state: idle, prompt: "", mcpJsonPath }), ["marked"]);
  assert.deepEqual(wrappedServers({ config, state: idle, prompt: "", mcpJsonPath }), named(["marked"]));
});

test("wrappedActive: the active servers whose entry runs through toolgate-proxy, and nothing for a bad file", () => {
  const cwd = tmp();
  const mcpJsonPath = path.join(cwd, ".mcp.json");
  mcpJson(cwd, { repo: PROXY, plain: { command: "node", args: ["server.js"] }, viaCommand: { command: "toolgate-proxy" }, off: PROXY });
  const config = { baseline: ["repo", "plain", "viaCommand", "ghost"] };
  assert.deepEqual(wrappedActive({ config, state: idle, prompt: "", mcpJsonPath }), ["repo", "viaCommand"]);
  assert.deepEqual(wrappedActive({ config: { baseline: [] }, state: idle, prompt: "", mcpJsonPath }), []);
  for (const content of ["{not json", "[]", '{"mcpServers":null}', '{"mcpServers":[]}']) {
    fs.writeFileSync(mcpJsonPath, content);
    assert.deepEqual(wrappedActive({ config, state: idle, prompt: "", mcpJsonPath }), [], content);
  }
  assert.deepEqual(wrappedActive({ config, state: idle, prompt: "", mcpJsonPath: path.join(cwd, "none.json") }), []);
});

const sandbox = () => {
  const dir = tmp("state");
  return { env: { XDG_STATE_HOME: dir, HOME: dir }, errors: [], stderr: null };
};
const launcher = (extra = {}, capability = { dynamicTools: true }) => {
  const { env } = sandbox();
  const errors = [];
  return { env, errors, session: sessionFor({ capability, agent: "claude-code", stderr: { write: (s) => errors.push(s) }, env, ...extra }) };
};

test("open: one file in a 700 folder with the wrapped servers, its path as TOOLGATE_SESSION_STATE; nothing without wrapped servers", () => {
  const { env, errors, session } = launcher();
  assert.equal(session.open([]), null);
  assert.equal(fs.existsSync(sessionsRoot({ env })), false, "no folder without a server");
  const sessionEnv = session.open(named(["repo", "docs"]));
  const file = sessionEnv.TOOLGATE_SESSION_STATE;
  assert.equal(path.dirname(file), sessionsRoot({ env }));
  assert.equal(mode(path.dirname(file)), 0o700);
  assert.equal(mode(file), 0o600);
  assert.deepEqual(Object.keys(readSession(file, { env }).servers), ["repo", "docs"]);
  assert.deepEqual(errors, []);
});

test("an agent without dynamicTools gets no file and one note, however many launches", () => {
  const { env, errors, session } = launcher({}, { dynamicTools: "unknown" });
  assert.equal(session.open(named(["repo"])), null);
  assert.equal(session.open(named(["repo"])), null);
  assert.deepEqual(errors, ["toolgate: claude-code does not declare dynamicTools; tools are revealed only by a restart\n"]);
  assert.equal(fs.existsSync(sessionsRoot({ env })), false);
  const quiet = launcher({}, { dynamicTools: false });
  assert.equal(quiet.session.open([]), null);
  assert.deepEqual(quiet.errors, [], "nothing wrapped, nothing to say");
});

test("a refused sessions folder is said with its text and the launch goes on without a session", () => {
  const { env, errors, session } = launcher();
  fs.mkdirSync(path.join(env.XDG_STATE_HOME, "toolgate"), { recursive: true });
  fs.mkdirSync(sessionsRoot({ env }), { mode: 0o755 });
  fs.chmodSync(sessionsRoot({ env }), 0o755);
  assert.equal(session.open(named(["repo"])), null);
  assert.match(errors.join(""), /^toolgate: .* is not a private file of yours; its tools are revealed only by a restart this session\n$/);
});

test("a relaunch keeps the same file, adds an entry for a newly wrapped server, and touches it", () => {
  const { env, session } = launcher();
  const first = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  fs.utimesSync(first, old, old);
  const second = session.open(named(["repo", "docs"])).TOOLGATE_SESSION_STATE;
  assert.equal(second, first);
  assert.deepEqual(Object.keys(readSession(first, { env }).servers), ["repo", "docs"]);
  assert.ok(Date.now() - fs.statSync(first).mtimeMs < 60000, "alive again");
  assert.deepEqual(readSession(first, { env }).servers.repo, { enabled: [], baseline: [], instructionsShown: false });
  fs.rmSync(first);
  const third = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  assert.notEqual(third, first, "a file that is gone is made again");
});

test("a relaunch with nothing new still touches the file", () => {
  const { session } = launcher();
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);
  assert.equal(session.open(named(["repo"])).TOOLGATE_SESSION_STATE, file);
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 60000);
});

test("a revealed tool survives the relaunch", () => {
  const { env, session } = launcher();
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  fs.writeFileSync(file, JSON.stringify({ version: 1, servers: { repo: { enabled: ["a"], baseline: ["b"], instructionsShown: true } } }), { mode: 0o600 });
  session.open([{ server: "repo", baseline: ["b"] }]);
  assert.deepEqual(readSession(file, { env }).servers.repo, { enabled: ["a"], baseline: ["b"], instructionsShown: true });
});

test("the file is touched every hour while the agent runs, with an unref'd timer, and the timer stops", () => {
  const timers = [];
  const cleared = [];
  const fake = { setIntervalFn: (fn, ms) => (timers.push({ fn, ms, unref: false }), { unref() { timers.at(-1).unref = true; } }), clearIntervalFn: (t) => cleared.push(t) };
  const { session } = launcher(fake);
  assert.equal(typeof session.watch(), "function");
  assert.equal(timers.length, 0, "no file, no timer");
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  const stop = session.watch();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, REFRESH_MS);
  assert.equal(REFRESH_MS, 3600000);
  assert.equal(timers[0].unref, true);
  const old = new Date(Date.now() - 6 * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);
  timers[0].fn();
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 60000, "the tick refreshed the mtime");
  stop();
  assert.equal(cleared.length, 1);
});

test("the sweep runs at the start: an old session file of this user goes, a young one stays", () => {
  const { env, session } = launcher();
  const oldOne = createSession(["x"], { env });
  const young = createSession(["x"], { env });
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(oldOne.file, old, old);
  session.open(named(["repo"]));
  assert.equal(fs.existsSync(oldOne.file), false);
  assert.equal(fs.existsSync(young.file), true);
});

test("close removes the file and its instructions files; a pending restart keeps it for the sweep", () => {
  const { env, session } = launcher();
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  const instructions = file.replace(/\.json$/, ".repo.instructions.txt");
  fs.writeFileSync(instructions, "x", { mode: 0o600 });
  session.close({ pending: true });
  assert.equal(fs.existsSync(file), true);
  session.close();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(instructions), false);
  assert.deepEqual(fs.readdirSync(sessionsRoot({ env })), []);
  launcher().session.close();
});

// The launch loop of cli.js with a fake agent, as in supervisor.test.js: each launch is recorded with what the file looked like then.
function setup({ servers = { repo: PROXY }, baseline = ["repo"], capability = claude.capability, escalate = (n) => n === 0, maxRestarts } = {}) {
  const cwd = tmp("cwd");
  mcpJson(cwd, servers);
  const env = { XDG_STATE_HOME: tmp("xdg"), HOME: tmp("home") };
  const calls = [];
  const disk = { ...idle };
  const adapter = {
    ...claude,
    capability,
    supportsResume: true,
    launch: async (first, second) => {
      const options = Array.isArray(first) ? second : first;
      const file = options.env?.TOOLGATE_SESSION_STATE;
      const n = calls.length;
      calls.push({ options, file, existsDuring: file ? fs.existsSync(file) : null, resume: options.resume });
      if (escalate(n)) Object.assign(disk, { extras: ["docs"], pendingRestart: true });
      return { code: 0 };
    },
  };
  const adapters = createRegistry({ "claude-code": () => Promise.resolve(adapter) }, { validate: false, aliases: { claude: "claude-code" } });
  const errors = [];
  const deps = {
    cwd,
    env,
    adapters,
    maxRestarts,
    stderr: { write: (s) => errors.push(s) },
    stdout: { write: () => {} },
    loadConfigFn: () => ({ baseline }),
    loadStateFn: () => structuredClone(disk),
    saveStateFn: (_, state) => Object.assign(disk, state),
  };
  return { deps, calls, errors, disk, env };
}

test("the wrapper path: the agent gets the path, a relaunch gets the same one, and the end removes it", async () => {
  const { deps, calls, env } = setup();
  assert.equal(await run(["--no-route", "claude"], deps), 0);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].file.startsWith(sessionsRoot({ env })));
  assert.equal(calls[1].file, calls[0].file, "the same file after the relaunch");
  assert.equal(calls[1].resume, true);
  assert.deepEqual(calls.map((call) => call.existsDuring), [true, true]);
  assert.equal(fs.existsSync(calls[0].file), false, "gone at the end");
  assert.deepEqual(fs.readdirSync(sessionsRoot({ env })), []);
});

test("no wrapped active server: no env, no folder, and the active set is the one of today", async () => {
  const { deps, calls, env } = setup({ servers: { repo: { command: "node" } } });
  await run(["--no-route", "claude"], deps);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.options.env.TOOLGATE_SESSION_STATE, undefined);
  assert.equal(fs.existsSync(path.join(env.XDG_STATE_HOME, "toolgate")), false);
});

test("an agent that does not declare dynamicTools: no file, the note once across the relaunch", async () => {
  const { deps, calls, errors, env } = setup({ capability: { ...claude.capability, dynamicTools: "unknown" } });
  await run(["--no-route", "claude"], deps);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, undefined);
  assert.equal(errors.filter((line) => line.includes("does not declare dynamicTools")).length, 1);
  assert.equal(fs.existsSync(path.join(env.XDG_STATE_HOME, "toolgate")), false);
});

test("a relaunch that cannot happen because of a pending restart keeps the file for the sweep", async () => {
  const { deps, calls, env } = setup({ escalate: () => true, maxRestarts: 1 });
  await run(["--no-route", "claude"], deps);
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(calls[0].file), true, "the restart is still pending: the file stays");
  assert.deepEqual(fs.readdirSync(sessionsRoot({ env })), [path.basename(calls[0].file)]);
});

test("the prompt path: the same env during the launch, removed after it", async () => {
  const { deps, calls, env } = setup({ escalate: () => false });
  assert.equal(await run(["--no-route", "--adapter", "claude", "hola"], deps), 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].file.startsWith(sessionsRoot({ env })));
  assert.equal(calls[0].existsDuring, true);
  assert.equal(fs.existsSync(calls[0].file), false);
});

test("the prompt path with a pending restart keeps the file, and without wrapped servers makes none", async () => {
  const pending = setup({ escalate: () => true });
  await run(["--no-route", "--adapter", "claude", "hola"], pending.deps);
  assert.equal(fs.existsSync(pending.calls[0].file), true);
  const none = setup({ servers: {}, escalate: () => false });
  await run(["--no-route", "--adapter", "claude", "hola"], none.deps);
  assert.equal(none.calls[0].options.env.TOOLGATE_SESSION_STATE, undefined);
});

test("a .mcp.json entry with fields of the wrong type is not proxied and does not throw", () => {
  const entries = [{ command: "node", args: "toolgate-proxy" }, { command: "node", args: { a: 1 } }, { command: ["toolgate-proxy"] }, { env: "TOOLGATE_UPSTREAM_CMD" }, { args: [1, null, {}] }, "text", null, 7, []];
  for (const entry of entries) assert.equal(isProxied(entry), false, JSON.stringify(entry));
  assert.equal(isProxied({ command: "node", args: [1, "toolgate-proxy"] }), true, "a text among the others still counts");
  const cwd = tmp();
  mcpJson(cwd, Object.fromEntries(entries.map((entry, i) => [`s${i}`, entry])));
  const config = { baseline: entries.map((_, i) => `s${i}`) };
  assert.deepEqual(wrappedActive({ config, state: idle, prompt: "", mcpJsonPath: path.join(cwd, ".mcp.json") }), []);
  fs.writeFileSync(path.join(cwd, ".mcp.json"), '{"mcpServers":{"__proto__":{"command":"toolgate-proxy"},"repo":{"command":"toolgate-proxy","env":{"TOOLGATE_SERVER":"repo"}}}}');
  assert.ok(wrappedActive({ config: { baseline: ["repo", "__proto__"] }, state: idle, prompt: "", mcpJsonPath: path.join(cwd, ".mcp.json") }).includes("repo"), "an own key named __proto__ does not break it");
});

test("launchEnv: the session's path when there is one, and none inherited from an outer toolgate when there is not", () => {
  const base = { PATH: "/bin", TOOLGATE_SESSION_STATE: "/outer/session.json" };
  assert.deepEqual(launchEnv({ TOOLGATE_SESSION_STATE: "/mine.json" }, base), { PATH: "/bin", TOOLGATE_SESSION_STATE: "/mine.json" });
  assert.deepEqual(launchEnv(null, base), { PATH: "/bin" });
  assert.equal(base.TOOLGATE_SESSION_STATE, "/outer/session.json", "the input is not changed");
});

test("nested: an inherited TOOLGATE_SESSION_STATE does not reach the agent when this launch has no session", async () => {
  const outer = process.env.TOOLGATE_SESSION_STATE;
  process.env.TOOLGATE_SESSION_STATE = "/outer/session.json";
  try {
    const { deps, calls } = setup({ servers: { repo: { command: "node" } }, escalate: () => false });
    await run(["--no-route", "claude"], deps);
    assert.equal(calls[0].options.env.TOOLGATE_SESSION_STATE, undefined);
    const withSession = setup({ escalate: () => false });
    await run(["--no-route", "claude"], withSession.deps);
    assert.ok(withSession.calls[0].options.env.TOOLGATE_SESSION_STATE.startsWith(sessionsRoot({ env: withSession.env })));
  } finally {
    if (outer === undefined) delete process.env.TOOLGATE_SESSION_STATE;
    else process.env.TOOLGATE_SESSION_STATE = outer;
  }
});

test("the hourly touch also refreshes the instructions files of the session", () => {
  const { env, session } = launcher();
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  const instructions = file.replace(/\.json$/, ".repo.instructions.txt");
  fs.writeFileSync(instructions, "x", { mode: 0o600 });
  const old = new Date(Date.now() - 6 * 24 * 3600 * 1000);
  fs.utimesSync(instructions, old, old);
  session.open(named(["repo"]));
  assert.ok(Date.now() - fs.statSync(instructions).mtimeMs < 60000);
  assert.equal(fs.existsSync(path.join(sessionsRoot({ env }), "stranger.txt")), false);
});

test("an agent that cannot start (ENOENT) leaves no session file once toolgate exits", () => {
  const fakeProcess = new EventEmitter();
  const { session, env } = launcher({ processRef: fakeProcess });
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  assert.equal(fs.existsSync(file), true);
  fakeProcess.emit("exit");
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(sessionsRoot({ env })), []);
});

test("a hostile .mcp.json whose args nest 200000 levels does not crash the launcher", () => {
  const cwd = tmp();
  const deep = "[".repeat(200000) + "]".repeat(200000);
  fs.writeFileSync(path.join(cwd, ".mcp.json"), `{"mcpServers":{"repo":{"command":"node","args":${deep}},"ok":{"command":"toolgate-proxy","env":{"TOOLGATE_SERVER":"ok"}}}}`);
  assert.deepEqual(wrappedActive({ config: { baseline: ["repo", "ok"] }, state: idle, prompt: "", mcpJsonPath: path.join(cwd, ".mcp.json") }), ["ok"]);
});

test("every normal close removes the exit listener: many launches leave none and no warning", () => {
  const fakeProcess = new EventEmitter();
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on("warning", onWarning);
  for (let i = 0; i < 30; i++) {
    const { session } = launcher({ processRef: fakeProcess });
    session.open(named(["repo"]));
    session.close();
  }
  assert.equal(fakeProcess.listenerCount("exit"), 0);
  process.removeListener("warning", onWarning);
  assert.deepEqual(warnings, []);
});

test("an exit listener is removed when the restart is pending, and a normal close leaves none to act", () => {
  const fakeProcess = new EventEmitter();
  const { session } = launcher({ processRef: fakeProcess });
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  assert.equal(fakeProcess.listenerCount("exit"), 1);
  session.close({ pending: true });
  assert.equal(fakeProcess.listenerCount("exit"), 0);
  fakeProcess.emit("exit");
  assert.equal(fs.existsSync(file), true, "pending: kept past the exit too");
});

test("a state file that cannot be read at the end does not keep the session file", async () => {
  const { deps, calls } = setup({ escalate: () => false });
  let reads = 0;
  const load = deps.loadStateFn;
  deps.loadStateFn = (p) => {
    reads += 1;
    if (reads > 1) throw new Error("unreadable");
    return load(p);
  };
  await run(["--no-route", "--adapter", "claude", "hola"], deps).catch(() => {});
  assert.equal(fs.existsSync(calls[0].file), false);
});

test("a launch that throws removes the session file in the prompt path", async () => {
  const { deps, calls } = setup({ escalate: () => false });
  const adapter = await deps.adapters.get("claude");
  const original = adapter.launch;
  adapter.launch = async (...args) => {
    await original(...args);
    throw new Error("spawn failed");
  };
  await assert.rejects(() => run(["--no-route", "--adapter", "claude", "hola"], deps), /spawn failed/);
  assert.equal(fs.existsSync(calls[0].file), false);
});

test("the prompt path: an earlier pending restart does not keep the file, a new one does", async () => {
  const earlier = setup({ escalate: () => false });
  Object.assign(earlier.disk, { extras: ["docs"], pendingRestart: true });
  await run(["--no-route", "--adapter", "claude", "hola"], earlier.deps);
  assert.equal(fs.existsSync(earlier.calls[0].file), false, "consumed before the launch: nothing pending");
});

// The hourly refresh through both launch paths: a fake clock is injected as deps.setIntervalFn / clearIntervalFn.
function fakeClock() {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    setIntervalFn: (fn, ms) => {
      const timer = { fn, ms, unref: false, unrefFn() { timer.unref = true; } };
      timers.push(timer);
      return { unref: () => timer.unrefFn() };
    },
    clearIntervalFn: () => cleared.push(true),
  };
}
for (const [label, argv] of [["wrapper", ["--no-route", "claude"]], ["prompt", ["--no-route", "--adapter", "claude", "hola"]]]) {
  test(`the ${label} path refreshes the session file every hour while the agent runs, and stops when it ends`, async () => {
    const clock = fakeClock();
    const { deps, calls } = setup({ escalate: () => false });
    deps.setIntervalFn = clock.setIntervalFn;
    deps.clearIntervalFn = clock.clearIntervalFn;
    let during;
    const adapter = await deps.adapters.get("claude");
    const original = adapter.launch;
    adapter.launch = async (...args) => {
      during = { timers: clock.timers.length, cleared: clock.cleared.length };
      const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
      const file = (Array.isArray(args[0]) ? args[1] : args[0]).env.TOOLGATE_SESSION_STATE;
      fs.utimesSync(file, old, old);
      clock.timers[0].fn();
      during.touched = Date.now() - fs.statSync(file).mtimeMs < 60000;
      return original(...args);
    };
    await run(argv, deps);
    assert.deepEqual(during, { timers: 1, cleared: 0, touched: true });
    assert.equal(clock.timers[0].ms, 3600000);
    assert.equal(clock.timers[0].unref, true);
    assert.equal(clock.cleared.length, 1, "stopped when the launch ended");
    assert.equal(calls.length, 1);
  });
}

test("wrappedServers: each wrapped active server with the baseline its proxy is started with", () => {
  const cwd = tmp();
  mcpJson(cwd, { repo: PROXY, docs: PROXY, plain: { command: "node" } });
  const config = { baseline: ["repo", "docs", "plain"], toolBaselines: { repo: ["list", "get"], plain: ["x"] } };
  const mcpJsonPath = path.join(cwd, ".mcp.json");
  assert.deepEqual(wrappedServers({ config, state: idle, prompt: "", mcpJsonPath }), [{ server: "docs", baseline: [] }, { server: "repo", baseline: ["list", "get"] }]);
  const escalated = { extras: [], toolExtras: { repo: ["merge"] }, pendingRestart: true };
  assert.deepEqual(wrappedServers({ config, state: escalated, prompt: "", mcpJsonPath }).find((entry) => entry.server === "repo").baseline, ["list", "get", "merge"], "the same list the adapter passes the proxy");
  assert.deepEqual(wrappedServers({ config: { baseline: ["constructor"], toolBaselines: {} }, state: idle, prompt: "", mcpJsonPath }), []);
});

test("open writes each baseline and the project folder; a relaunch updates a baseline and keeps what was revealed", () => {
  const { env, session } = launcher({ projectDir: "/work/proj" });
  const file = session.open([{ server: "repo", baseline: ["list"] }]).TOOLGATE_SESSION_STATE;
  assert.deepEqual(readSession(file, { env }), { version: 1, projectDir: "/work/proj", agent: "claude-code", servers: { repo: { enabled: [], baseline: ["list"], instructionsShown: false } } });
  fs.writeFileSync(file, JSON.stringify({ version: 1, projectDir: "/work/proj", servers: { repo: { enabled: ["a"], baseline: ["list"], instructionsShown: true } } }), { mode: 0o600 });
  session.open([{ server: "repo", baseline: ["list", "merge"] }, { server: "docs", baseline: [] }]);
  assert.deepEqual(readSession(file, { env }).servers, {
    repo: { enabled: ["a"], baseline: ["list", "merge"], instructionsShown: true },
    docs: { enabled: [], baseline: [], instructionsShown: false },
  });
});

test("a relaunch rewrites a baseline that changed even when it has the same length", () => {
  const { env, session } = launcher();
  const file = session.open([{ server: "repo", baseline: ["a", "b"] }]).TOOLGATE_SESSION_STATE;
  session.open([{ server: "repo", baseline: ["a", "c"] }]);
  assert.deepEqual(readSession(file, { env }).servers.repo.baseline, ["a", "c"]);
});

test("the launch writes the baselines of the config and the project folder into the session file", async () => {
  const { deps, calls, env } = setup({ escalate: () => false });
  deps.loadConfigFn = () => ({ baseline: ["repo"], toolBaselines: { repo: ["list", "get"] } });
  const adapter = await deps.adapters.get("claude");
  const original = adapter.launch;
  let seen;
  adapter.launch = async (...args) => {
    const options = Array.isArray(args[0]) ? args[1] : args[0];
    seen = readSession(options.env.TOOLGATE_SESSION_STATE, { env });
    return original(...args);
  };
  await run(["--no-route", "claude"], deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(seen.servers.repo, { enabled: [], baseline: ["list", "get"], instructionsShown: false });
  assert.equal(seen.projectDir, deps.cwd);
});

test("an invalid baseline entry is left out and said with its server and why; the other servers keep their session", () => {
  const { env, errors, session } = launcher();
  const long = "x".repeat(200);
  const file = session.open([{ server: "repo", baseline: ["list", "bad name", "a/b", long] }, { server: "docs", baseline: ["read"] }, { server: "../evil", baseline: [] }]).TOOLGATE_SESSION_STATE;
  const state = readSession(file, { env });
  assert.deepEqual(Object.keys(state.servers), ["repo", "docs"]);
  assert.deepEqual(state.servers.repo.baseline, ["list"]);
  assert.deepEqual(state.servers.docs.baseline, ["read"]);
  const said = errors.join("");
  assert.match(said, /the baseline of repo has 3 entries[^\n]*"bad name", "a\/b", "x{40}"; toolgate tools does not list them, but the proxy still offers them\n/);
  assert.match(said, /the server \.\.\/evil has a name that is not a plain server name/);
  assert.doesNotMatch(said, /docs/);
});

test("past 1024 baseline entries the rest are left out and said; a hostile name is shown through printable", () => {
  const { env, errors, session } = launcher();
  const many = Array.from({ length: 1030 }, (_, i) => `t${i}`);
  const file = session.open([{ server: "repo", baseline: [...many, "\u202eevil\u001b[31m"] }]).TOOLGATE_SESSION_STATE;
  assert.equal(readSession(file, { env }).servers.repo.baseline.length, 1024);
  assert.match(errors.join(""), /the baseline of repo has 7 entries/);
  assert.doesNotMatch(errors.join(""), /\u202e|\u001b/);
});

test("a relaunch with an invalid baseline entry says so too, and keeps the file and the other servers", () => {
  const { env, errors, session } = launcher();
  const file = session.open([{ server: "repo", baseline: ["list"] }, { server: "docs", baseline: [] }]).TOOLGATE_SESSION_STATE;
  errors.length = 0;
  session.open([{ server: "repo", baseline: ["list", "bad name"] }, { server: "docs", baseline: ["read"] }]);
  assert.match(errors.join(""), /the baseline of repo has 1 entries/);
  assert.deepEqual(readSession(file, { env }).servers.repo.baseline, ["list"]);
  assert.deepEqual(readSession(file, { env }).servers.docs.baseline, ["read"]);
});

test("a relaunch drops the entry (and what it had revealed) of a server that is no longer wrapped", () => {
  const { env, session } = launcher();
  const file = session.open(named(["repo", "docs"])).TOOLGATE_SESSION_STATE;
  fs.writeFileSync(file, JSON.stringify({ version: 1, servers: { repo: { enabled: ["a"], baseline: [], instructionsShown: false }, docs: { enabled: ["b"], baseline: [], instructionsShown: true } } }), { mode: 0o600 });
  session.open(named(["repo"]));
  assert.deepEqual(readSession(file, { env }).servers, { repo: { enabled: ["a"], baseline: [], instructionsShown: false } });
  session.open([]);
  assert.deepEqual(readSession(file, { env }).servers, {}, "nothing wrapped any more: an empty session, still there");
});

test("a relaunch whose write is refused says why", () => {
  const { env, errors, session } = launcher();
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  fs.writeFileSync(file.replace(/\.json$/, ".lock"), "other\n", { mode: 0o600 });
  errors.length = 0;
  session.open(named(["repo", "docs"]));
  assert.ok(env);
  assert.match(errors.join(""), /could not be written \(/);
});

test("wrappedServers does not take a name from the prototype as having a baseline", () => {
  const cwd = tmp();
  mcpJson(cwd, { constructor: PROXY, toString: PROXY });
  const result = wrappedServers({ config: { baseline: ["constructor", "toString"], toolBaselines: {} }, state: idle, prompt: "", mcpJsonPath: path.join(cwd, ".mcp.json") });
  assert.deepEqual(result, [{ server: "constructor", baseline: [] }, { server: "toString", baseline: [] }]);
});

test("the prompt path writes the baselines and the project folder as the wrapper path does", async () => {
  const { deps, calls, env } = setup({ escalate: () => false });
  deps.loadConfigFn = () => ({ baseline: ["repo"], toolBaselines: { repo: ["list"] } });
  const adapter = await deps.adapters.get("claude");
  const original = adapter.launch;
  let seen;
  adapter.launch = async (...args) => {
    const options = Array.isArray(args[0]) ? args[1] : args[0];
    seen = readSession(options.env.TOOLGATE_SESSION_STATE, { env });
    return original(...args);
  };
  await run(["--no-route", "--adapter", "claude", "hola"], deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(seen.servers.repo, { enabled: [], baseline: ["list"], instructionsShown: false });
  assert.equal(seen.projectDir, deps.cwd);
});

test("the dropped-names message says toolgate tools does not list them but the proxy still offers them", () => {
  const { errors, session } = launcher();
  session.open([{ server: "repo", baseline: ["list", "bad name"] }]);
  assert.match(errors.join(""), /"bad name"; toolgate tools does not list them, but the proxy still offers them\n$/);
});

test("nothing about baselines or server names is said for an agent that does not take a session", () => {
  const { errors, session } = launcher({}, { dynamicTools: "unknown" });
  session.open([{ server: "repo", baseline: ["bad name"] }, { server: "../evil", baseline: [] }]);
  assert.deepEqual(errors, ["toolgate: claude-code does not declare dynamicTools; tools are revealed only by a restart\n"], "only the capability note");
});

test("a hostile server name and tool name are shown through printable, cut to 40 characters", () => {
  const { errors, session } = launcher();
  session.open([{ server: "repo", baseline: ["\u202eevil\u001b[31m", "y".repeat(100) + " x"] }, { server: "\u202e../x\n", baseline: [] }]);
  const said = errors.join("");
  assert.doesNotMatch(said, /[\u202e\u001b]/);
  assert.match(said, /the server \\u202e\.\.\/x\\n has a name|the server .*x.* has a name/);
  assert.ok(!said.includes("y".repeat(41)), "cut to 40");
});

test("tool names of 128 characters are kept and of 129 are left out", () => {
  const { env, session } = launcher();
  const file = session.open([{ server: "repo", baseline: ["a".repeat(128), "b".repeat(129)] }]).TOOLGATE_SESSION_STATE;
  assert.deepEqual(readSession(file, { env }).servers.repo.baseline, ["a".repeat(128)]);
});

test("a project folder that cannot be stored is left out, said once, and the session stands", () => {
  for (const bad of ["/work/a\nb", "/work/\u202eevil", "/work/../x", "relative"]) {
    const { env, errors, session } = launcher({ projectDir: bad });
    const file = session.open(named(["repo", "docs"])).TOOLGATE_SESSION_STATE;
    const state = readSession(file, { env });
    assert.deepEqual(Object.keys(state.servers), ["repo", "docs"], bad);
    assert.equal("projectDir" in state, false, bad);
    session.open(named(["repo", "docs"]));
    assert.equal(errors.filter((line) => line.includes("cannot be stored in the session")).length, 1, "said once");
    assert.doesNotMatch(errors.join(""), /[\u202e]/);
  }
  const quiet = launcher({ projectDir: "/work/a\nb" }, { dynamicTools: "unknown" });
  quiet.session.open(named(["repo"]));
  assert.ok(!quiet.errors.join("").includes("cannot be stored"));
  const fine = launcher({ projectDir: "/work/proj" });
  fine.session.open(named(["repo"]));
  assert.deepEqual(fine.errors, []);
});

test("a relaunch whose write is refused keeps the previous file, gives no env, and says so", () => {
  const { env, errors, session } = launcher();
  const file = session.open([{ server: "repo", baseline: ["list"] }]).TOOLGATE_SESSION_STATE;
  fs.writeFileSync(file.replace(/\.json$/, ".lock"), "other\n", { mode: 0o600 });
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);
  errors.length = 0;
  const result = session.open([{ server: "repo", baseline: ["list", "get"] }, { server: "docs", baseline: [] }]);
  assert.equal(result, null, "no env: the agent starts without the new session");
  assert.deepEqual(readSession(file, { env }).servers, { repo: { enabled: [], baseline: ["list"], instructionsShown: false } }, "the previous file is as it was");
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 60000, "and still alive");
  assert.match(errors.join(""), /could not be written \(the session file is busy\)[^\n]*\ntoolgate: the agent starts without a dynamic session this time; its tools are revealed only by a restart\n$/);
  fs.rmSync(file.replace(/\.json$/, ".lock"));
  assert.ok(session.open([{ server: "repo", baseline: ["list", "get"] }]), "the next launch writes again");
});

test("a relaunch refused by the cap of 256 servers keeps the previous file and says so", () => {
  const { env, errors, session } = launcher();
  const file = session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  errors.length = 0;
  assert.equal(session.open(named(Array.from({ length: 257 }, (_, i) => `s${i}`))), null);
  assert.deepEqual(Object.keys(readSession(file, { env }).servers), ["repo"]);
  assert.match(errors.join(""), /starts without a dynamic session this time/);
});

test("the session stores the adapter name of the agent; a name that cannot be stored is left out and the session is made without it", () => {
  const stored = launcher();
  const file = stored.session.open(named(["repo"])).TOOLGATE_SESSION_STATE;
  assert.equal(readSession(file, { env: stored.env }).agent, "claude-code");
  const odd = launcher({ agent: "my agent\u001b[31m" });
  const oddFile = odd.session.open(named(["repo"]))?.TOOLGATE_SESSION_STATE;
  assert.ok(oddFile, "a session is made");
  assert.equal("agent" in readSession(oddFile, { env: odd.env }), false);
});
