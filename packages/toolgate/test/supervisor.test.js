import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/adapters/index.js";
import { run } from "../src/cli.js";
import * as claude from "../src/adapters/claude-code.js";

// A fake agent: each launch is recorded, and `escalate(n)` says whether run n escalates a server.
function setup({ escalate = (n) => n === 0, code = 0, supportsResume = true, maxRestarts } = {}) {
  const calls = [];
  const disk = { extras: [], toolExtras: {}, pendingRestart: false };
  const adapter = {
    ...claude,
    supportsResume,
    launch: async (args, options) => {
      const n = calls.length;
      calls.push({ args, options });
      if (escalate(n)) Object.assign(disk, { extras: ["docs"], pendingRestart: true });
      return { code };
    },
  };
  const adapters = createRegistry({ "claude-code": () => Promise.resolve(adapter) }, { validate: false, aliases: { claude: "claude-code" } });
  const errors = [];
  const deps = {
    cwd: "/tmp/none",
    env: {},
    adapters,
    maxRestarts,
    stderr: { write: (s) => errors.push(s) },
    stdout: { write: () => {} },
    loadConfigFn: () => ({}),
    loadStateFn: () => structuredClone(disk),
    saveStateFn: (_, state) => Object.assign(disk, state),
  };
  return { deps, calls, errors, disk };
}

test("an escalation during the session relaunches the agent with the conversation resumed", async () => {
  const { deps, calls, errors } = setup();
  assert.equal(await run(["--no-route", "claude", "--model", "haiku", "hola"], deps), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.resume, false);
  assert.equal(calls[1].options.resume, true);
  assert.deepEqual(calls[0].args, ["--model", "haiku", "hola"]);
  assert.deepEqual(calls[1].args, ["--model", "haiku"]); // the first message is not sent again
  assert.deepEqual(calls[1].options.state.extras, ["docs"]);
  assert.match(errors.join(""), /relaunching/);
});

test("the escalation is consumed by the relaunch, so a session without new ones ends the loop", async () => {
  const { deps, calls, disk } = setup();
  await run(["--no-route", "claude"], deps);
  assert.equal(calls.length, 2);
  assert.equal(disk.pendingRestart, false);
});

test("a loop of escalations stops at the maximum and prints the command", async () => {
  const { deps, calls, errors } = setup({ escalate: () => true, maxRestarts: 2 });
  assert.equal(await run(["--no-route", "claude"], deps), 0);
  assert.equal(calls.length, 3);
  assert.match(errors.join(""), /stopped after 2 restarts.*`toolgate claude --continue`/);
});

test("without resume support the command is printed and nothing is relaunched", async () => {
  const { deps, calls, errors } = setup({ supportsResume: false });
  await run(["--no-route", "claude"], deps);
  assert.equal(calls.length, 1);
  assert.match(errors.join(""), /`toolgate claude`/);
});

test("a session that did not exit cleanly is not relaunched", async () => {
  const { deps, calls } = setup({ code: 130 });
  assert.equal(await run(["--no-route", "claude"], deps), 130);
  assert.equal(calls.length, 1);
});

test("print mode is never relaunched: it would run the prompt again", async () => {
  const { deps, calls, errors } = setup();
  await run(["--no-route", "claude", "-p", "hola"], deps);
  assert.equal(calls.length, 1);
  assert.match(errors.join(""), /take effect on the next launch/);
});
