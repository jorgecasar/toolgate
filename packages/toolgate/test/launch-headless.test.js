import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { run } from "../src/cli.js";

const state = { extras: [], toolExtras: {}, pendingRestart: false };

// Runs an adapter's launch with a fake spawn and returns what it was spawned with.
async function spawned(name, options) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter();
    calls.push({ cmd, args, opts });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const adapter = await import(`../src/adapters/${name}.js`);
  const io = { spawnFn, writeFileFn() {}, rmFn() {}, readFileFn: () => "{}", tmpDir: "/tmp", pid: 1, now: 1, cwd: "/project", homedir: "/home/none", stderr: { write() {} } };
  await adapter.launch({ config: {}, state, mcpJsonPath: "/project/.mcp.json", ...io, ...options });
  return calls[0];
}

const PROMPT = "review this pull request";

test("each agent gets its own non-interactive form for a prompt, and the interactive one otherwise", async () => {
  const tail = (call, n) => call.args.slice(-n);
  assert.deepEqual(tail(await spawned("claude-code", { prompt: PROMPT, headless: true }), 2), ["-p", PROMPT]);
  assert.deepEqual(tail(await spawned("claude-code", { prompt: PROMPT }), 1), [PROMPT]);
  assert.ok(!(await spawned("claude-code", { prompt: PROMPT })).args.includes("-p"));
  assert.deepEqual((await spawned("codex", { prompt: PROMPT, headless: true })).args, ["exec", PROMPT]);
  assert.deepEqual((await spawned("codex", { prompt: PROMPT })).args, [PROMPT]);
  assert.deepEqual((await spawned("opencode", { prompt: PROMPT, headless: true })).args, ["run", PROMPT]);
  assert.deepEqual((await spawned("opencode", { prompt: PROMPT })).args, ["--prompt", PROMPT]);
  assert.deepEqual((await spawned("antigravity", { prompt: PROMPT, headless: true })).args, [`--print=${PROMPT}`]);
  assert.deepEqual((await spawned("antigravity", { prompt: PROMPT })).args, [PROMPT]);
  assert.deepEqual((await spawned("karajan", { prompt: PROMPT, headless: true })).args, ["run", PROMPT]);
  // Without a prompt there is nothing to run headless.
  assert.deepEqual((await spawned("codex", { headless: true })).args, []);
});

test("the agent's own flags are forwarded before the prompt, untouched", async () => {
  assert.deepEqual((await spawned("codex", { prompt: PROMPT, headless: true, agentArgs: ["--model", "x"] })).args, ["exec", "--model", "x", PROMPT]);
  const claude = await spawned("claude-code", { prompt: PROMPT, agentArgs: ["-p"] });
  assert.deepEqual(claude.args.slice(-2), ["-p", PROMPT]);
});

test("--quiet drops the agent's stdout and nothing else", async () => {
  for (const name of ["claude-code", "codex", "opencode", "antigravity", "karajan"]) {
    assert.deepEqual((await spawned(name, { prompt: PROMPT, headless: true, quiet: true })).opts.stdio, ["inherit", "ignore", "inherit"], name);
    assert.equal((await spawned(name, { prompt: PROMPT, headless: true })).opts.stdio, "inherit", name);
  }
});

async function cli(argv, { code = 0 } = {}) {
  const launches = [];
  const adapter = { launch: (options) => (launches.push(options), Promise.resolve({ code })) };
  const stderr = [];
  const exit = await run(argv, {
    cwd: "/project",
    stdout: { write() {} },
    stderr: { write: (s) => stderr.push(s) },
    env: {},
    loadConfigFn: () => ({ defaultAgent: "claude-code" }),
    loadStateFn: () => state,
    saveStateFn() {},
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  return { exit, launch: launches[0], stderr: stderr.join("") };
}

test("a prompt runs interactively by default and without interaction only with --yes", async () => {
  const plain = await cli(["--no-route", PROMPT]);
  assert.equal(plain.launch.prompt, PROMPT);
  assert.equal(plain.launch.headless, false);
  const yes = await cli(["--no-route", "--yes", PROMPT]);
  assert.equal(yes.launch.headless, true);
  assert.equal((await cli(["--no-route", "--yes"])).launch.headless, false, "no prompt: nothing to run headless");
});

test("--adapter X <prompt> keeps the prompt whatever flag of the agent comes before it, and what follows -- reaches the agent", async () => {
  const printed = await cli(["--no-route", "--adapter", "claude-code", "-p", PROMPT]);
  assert.equal(printed.launch.prompt, PROMPT, "-p is not the prompt");
  assert.deepEqual(printed.launch.agentArgs, ["-p"]);
  const rest = await cli(["--no-route", PROMPT, "--", "--model", "x"]);
  assert.equal(rest.launch.prompt, PROMPT);
  assert.deepEqual(rest.launch.agentArgs, ["--model", "x"]);
});

test("--policy after -- is the agent's flag, not the removed toolgate one: it reaches the agent and nothing is refused", async () => {
  const after = await cli(["--no-route", PROMPT, "--", "--policy", "x"]);
  assert.equal(after.exit, 0);
  assert.equal(after.launch.prompt, PROMPT);
  assert.deepEqual(after.launch.agentArgs, ["--policy", "x"]);
});
test("--quiet and -q reach the launch; the exit code is the agent's either way", async () => {
  for (const flag of ["--quiet", "-q"]) {
    const quiet = await cli(["--no-route", "--yes", flag, PROMPT], { code: 3 });
    assert.equal(quiet.launch.quiet, true);
    assert.equal(quiet.exit, 3);
  }
  const loud = await cli(["--no-route", "--yes", PROMPT], { code: 3 });
  assert.equal(loud.launch.quiet, false);
  assert.equal(loud.exit, 3);
});
