// A launch that fails keeps the pending escalations for the next one (#303), on the task path and on the wrapper path.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRegistry } from "../src/adapters/index.js";
import { run } from "../src/cli.js";
import * as claude from "../src/adapters/claude-code.js";
import { sessionsRoot } from "../src/session.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (label) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-${label}-`)));
  made.push(dir);
  return dir;
};
const PENDING = { extras: ["docs"], toolExtras: { docs: ["a"] }, subagentExtras: ["s"], pendingRestart: true };
const LINE = (what) => `toolgate: the agent did not start cleanly (${what}); the pending escalations are kept for the next launch\n`;

// `outcome` decides what the fake launch does: a result, a thrown error, or `during` to escalate in the session before it ends.
const MISSING = "toolgate-no-such-agent-for-tests";
function setup({ outcome, during, real = false, seed = PENDING } = {}) {
  const cwd = tmp("cwd");
  // A server wrapped by toolgate-proxy and named, so that each launch makes a session file.
  fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { command: "toolgate-proxy", env: { TOOLGATE_SERVER: "repo" } } } }));
  const disk = structuredClone(seed);
  const fake = async () => {
    if (during) Object.assign(disk, during);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const adapter = {
    ...claude,
    supportsResume: false,
    // `real` runs the claude adapter against an agent that is not there, as a missing install does.
    launch: real ? (first, second) => (Array.isArray(first) ? claude.launch(first, { ...second, claudeBin: MISSING }) : claude.launch({ ...first, claudeBin: MISSING })) : fake,
  };
  const adapters = createRegistry({ "claude-code": () => Promise.resolve(adapter) }, { validate: false, aliases: { claude: "claude-code" } });
  const errors = [];
  const deps = {
    cwd,
    env: { XDG_STATE_HOME: tmp("xdg"), HOME: tmp("home") },
    adapters,
    stderr: { write: (s) => errors.push(s) },
    stdout: { write: () => {} },
    loadConfigFn: () => ({ baseline: ["repo"] }),
    loadStateFn: () => structuredClone(disk),
    saveStateFn: (_, state) => Object.assign(disk, structuredClone(state)),
  };
  const sessionFiles = () => (fs.existsSync(sessionsRoot({ env: deps.env })) ? fs.readdirSync(sessionsRoot({ env: deps.env })) : []);
  return { deps, disk, errors, sessionFiles };
}
const paths = {
  task: (deps) => run(["--no-route", "--adapter", "claude", "hola"], deps),
  wrapper: (deps) => run(["--no-route", "claude", "hola"], deps),
};
const IDLE = { extras: [], toolExtras: {}, subagentExtras: [], pendingRestart: false };
const fields = (state) => ({ extras: state.extras, toolExtras: state.toolExtras, subagentExtras: state.subagentExtras, pendingRestart: state.pendingRestart });

for (const [name, go] of Object.entries(paths)) {
  const failures = [
    ["an exit with code 1", { code: 1 }, LINE("exit 1")],
    ["a signal", { code: 143, signal: "SIGTERM" }, LINE("signal SIGTERM")],
    ["a code that is null", { code: null }, LINE("signal unknown")],
    ["a launch that throws", new Error("no claude\u001b[31m"), LINE("no claude\\u001b[31m")],
  ];
  for (const [what, outcome, line] of failures) {
    test(`${name} path: ${what} keeps the pending escalations and says so`, { timeout: 10_000 }, async () => {
      const { deps, disk, errors } = setup({ outcome });
      if (outcome instanceof Error) await assert.rejects(go(deps), /no claude/);
      else await go(deps);
      assert.deepEqual(fields(disk), PENDING);
      assert.deepEqual(errors.filter((line_) => line_.includes("did not start cleanly")), [line]);
    });
  }
  test(`${name} path: a clean exit consumes them, as before`, { timeout: 10_000 }, async () => {
    const { deps, disk, errors } = setup({ outcome: { code: 0 } });
    assert.equal(await go(deps), 0);
    assert.deepEqual(fields(disk), IDLE);
    assert.deepEqual(errors.filter((line) => line.includes("did not start cleanly")), []);
  });
  test(`${name} path: a result without a code is a clean exit`, { timeout: 10_000 }, async () => {
    const { deps, disk } = setup({ outcome: {} });
    assert.equal(await go(deps), 0);
    assert.deepEqual(fields(disk), IDLE);
  });
}

// What the agent escalated during the session and what was consumed for it are both kept: nothing is dropped.
for (const [what, during, merged] of [
  ["a server", { extras: ["new"], pendingRestart: true }, { extras: ["new", "docs"], toolExtras: PENDING.toolExtras, subagentExtras: ["s"], pendingRestart: true }],
  ["a tool of a server", { toolExtras: { docs: ["b"], other: ["c"] }, pendingRestart: true }, { extras: ["docs"], toolExtras: { docs: ["b", "a"], other: ["c"] }, subagentExtras: ["s"], pendingRestart: true }],
  ["a subagent", { subagentExtras: ["t"], pendingRestart: true }, { extras: ["docs"], toolExtras: PENDING.toolExtras, subagentExtras: ["t", "s"], pendingRestart: true }],
]) {
  test(`wrapper path: a launch that exits 1 after the agent escalated ${what} keeps both, and says so`, { timeout: 10_000 }, async () => {
    const { deps, disk, errors } = setup({ outcome: { code: 1 }, during: { ...IDLE, ...during } });
    assert.equal(await paths.wrapper(deps), 1);
    assert.deepEqual(fields(disk), merged);
    assert.equal(errors.filter((line) => line.includes("did not start cleanly")).length, 1);
    assert.equal(errors.filter((line) => line.includes("servers were escalated during the session")).length, 1, "the note about the new escalation stays");
  });
}

test("wrapper path: the agent that escalated and exited 0 leaves its escalation pending and the consumed ones gone", { timeout: 10_000 }, async () => {
  const { deps, disk } = setup({ outcome: { code: 0 }, during: { ...IDLE, extras: ["new"], pendingRestart: true } });
  assert.equal(await paths.wrapper(deps), 0);
  assert.deepEqual(fields(disk), { ...IDLE, extras: ["new"], pendingRestart: true });
});

// The task path consumes after the agent ends: only what it took, so what was escalated meanwhile is not lost.
for (const [what, during, left] of [
  ["a server", { extras: ["docs", "new"], pendingRestart: true }, { ...IDLE, extras: ["new"], pendingRestart: true }],
  ["a tool", { toolExtras: { docs: ["a", "b"] }, pendingRestart: true }, { ...IDLE, toolExtras: { docs: ["b"] }, pendingRestart: true }],
  ["a subagent", { subagentExtras: ["s", "t"], pendingRestart: true }, { ...IDLE, subagentExtras: ["t"], pendingRestart: true }],
  ["nothing", {}, IDLE],
]) {
  test(`task path: a clean exit after the agent escalated ${what} keeps only what is new`, { timeout: 10_000 }, async () => {
    const { deps, disk } = setup({ outcome: { code: 0 }, during: { ...PENDING, ...during } });
    assert.equal(await paths.task(deps), 0);
    assert.deepEqual(fields(disk), left);
  });
}

test("wrapper path: a failed launch with nothing pending writes nothing and does not talk", { timeout: 10_000 }, async () => {
  const { deps, disk, errors } = setup({ outcome: { code: 1 } });
  Object.assign(disk, IDLE);
  let saves = 0;
  const save = deps.saveStateFn;
  deps.saveStateFn = (...args) => { saves++; save(...args); };
  assert.equal(await paths.wrapper(deps), 1);
  assert.equal(saves, 0);
  assert.deepEqual(errors.filter((line) => line.includes("did not start cleanly")), []);
});

test("wrapper path: a failed launch is not followed by the 'servers were escalated' note of the restored state", { timeout: 10_000 }, async () => {
  const { deps, errors } = setup({ outcome: { code: 1 } });
  await paths.wrapper(deps);
  assert.deepEqual(errors.filter((line) => line.includes("were escalated")), []);
});

test("a failed launch leaves no session file behind, however many times it fails", { timeout: 10_000 }, async () => {
  for (const [name, go] of Object.entries(paths)) {
    const { deps, sessionFiles } = setup({ outcome: { code: 1 } });
    for (let i = 0; i < 3; i++) await go(deps);
    assert.deepEqual(sessionFiles(), [], name);
    const thrown = setup({ outcome: new Error("boom") });
    for (let i = 0; i < 3; i++) await assert.rejects(go(thrown.deps), /boom/);
    assert.deepEqual(thrown.sessionFiles(), [], `${name}, a launch that throws`);
  }
});

test("an agent that is not there (the real adapter, a missing binary) keeps the escalations, on both paths, and leaves no session file", { timeout: 10_000 }, async () => {
  for (const [name, go] of Object.entries(paths)) {
    const { deps, disk, errors, sessionFiles } = setup({ real: true });
    await assert.rejects(go(deps), { code: "ENOENT" });
    assert.deepEqual(fields(disk), PENDING, name);
    assert.equal(errors.filter((line) => line === LINE("spawn toolgate-no-such-agent-for-tests ENOENT")).length, 1, name);
    assert.deepEqual(sessionFiles(), [], name);
  }
});

test("wrapper path: a state.json the agent replaced by a folder does not change the exit code of the agent", { timeout: 10_000 }, async () => {
  const { deps, errors } = setup({ outcome: { code: 2 } });
  let calls = 0;
  deps.saveStateFn = () => {
    // the first save is the consumption before the launch; the restore after it fails like writing over a folder
    if (calls++ > 0) throw Object.assign(new Error("EISDIR: illegal operation on a directory, open 'state.json'"), { code: "EISDIR" });
  };
  assert.equal(await paths.wrapper(deps), 2);
  // one line: why the agent failed, and that the escalations could not be kept (never "are kept")
  assert.deepEqual(errors.filter((line) => line.includes("did not start cleanly")), ["toolgate: the agent did not start cleanly (exit 2); the pending escalations could not be kept (EISDIR: illegal operation on a directory, open 'state.json'), they are lost for the next launch\n"]);
});

test("wrapper path: a state that cannot be read after the failure is replaced by what was consumed", { timeout: 10_000 }, async () => {
  const { deps, disk } = setup({ outcome: { code: 1 } });
  let loads = 0;
  const load = deps.loadStateFn;
  deps.loadStateFn = (...args) => {
    // the first load is before the launch; the reads after it fail
    if (loads++ > 0) throw new Error("EISDIR");
    return load(...args);
  };
  assert.equal(await paths.wrapper(deps), 1);
  assert.deepEqual(fields(disk), PENDING);
});

test("a signal name with control characters is escaped in the line", { timeout: 10_000 }, async () => {
  const { deps, errors } = setup({ outcome: { code: 143, signal: "SIG\u001b[31mX" } });
  await paths.task(deps);
  assert.deepEqual(errors.filter((line) => line.includes("did not start cleanly")), [LINE("signal SIG\\u001b[31mX")]);
});

test("a pending restart with nothing named in it is kept by a failed launch too, on both paths", { timeout: 10_000 }, async () => {
  for (const [name, go] of Object.entries(paths)) {
    const { deps, disk } = setup({ outcome: { code: 1 }, seed: { ...IDLE, pendingRestart: true } });
    await go(deps);
    assert.deepEqual(fields(disk), { ...IDLE, pendingRestart: true }, name);
  }
});

test("a tool list under a name from the prototype is merged and consumed as any other", { timeout: 10_000 }, async () => {
  const seed = { ...IDLE, toolExtras: JSON.parse('{"__proto__":["a"],"constructor":["b"]}'), pendingRestart: true };
  const failed = setup({ outcome: { code: 1 }, seed, during: { ...IDLE, toolExtras: JSON.parse('{"__proto__":["c"]}'), pendingRestart: true } });
  await paths.wrapper(failed.deps);
  assert.deepEqual(Object.entries(failed.disk.toolExtras).sort(), [["__proto__", ["c", "a"]], ["constructor", ["b"]]]);
  assert.equal(Object.getPrototypeOf(failed.disk.toolExtras), Object.prototype, "the prototype is not touched");
  const ok = setup({ outcome: { code: 0 }, seed });
  await paths.task(ok.deps);
  assert.deepEqual(fields(ok.disk), IDLE);
});

test("consuming what a launch took stays linear: 100000 tool names of one server take well under a second", async () => {
  const { withoutEscalations } = await import("../src/config.js");
  const names = Array.from({ length: 100000 }, (_, i) => `t${i}`);
  const started = Date.now();
  const left = withoutEscalations({ ...IDLE, toolExtras: { docs: [...names, "new"] }, pendingRestart: true }, { ...IDLE, toolExtras: { docs: names } });
  assert.deepEqual(left.toolExtras, { docs: ["new"] });
  // a synchronous loop cannot be cut by a test timeout, so the time is checked after it (the quadratic form took 8.5 s)
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("the reason a restore failed is escaped and cut, in the line that says the escalations were not kept", async () => {
  const { deps, errors } = setup({ outcome: { code: 1 } });
  let calls = 0;
  deps.saveStateFn = () => {
    if (calls++ > 0) throw new Error(`bad\u001b[31m\u202e${"x".repeat(100000)}`);
  };
  await paths.wrapper(deps);
  const [line] = errors.filter((entry) => entry.includes("could not be kept"));
  assert.ok(line.includes("bad\\u001b[31m\\u202e"), "escaped");
  assert.ok(!line.includes("\u001b") && !line.includes("\u202e"));
  assert.ok(line.length < 600, `${line.length} characters`);
});
