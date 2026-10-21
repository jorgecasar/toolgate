// `toolgate claude …` (the agent's name first) makes sure the shared qmd daemon answers when the backend is qmd, with or without a prompt, as
// `toolgate <task>` does; not on the relaunch that resumes the conversation after an escalation. Fake `ensure` and a fake launch: no process, no port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/adapters/index.js";
import { run } from "../src/cli.js";
import * as claude from "../src/adapters/claude-code.js";
import { registerBackend, resetBackends } from "../src/router.js";
const PORT = "18294";
function wrapperWith({ config = { baseline: [], router: { backend: "qmd" } }, argv, escalateOnce = false, ensure }) {
  const ensures = [];
  const launches = [];
  let pending = false;
  const adapter = { ...claude, launch: async (args, options) => (launches.push({ args, resume: options.resume }), (pending = escalateOnce && launches.length === 1), { code: 0 }) };
  const err = [];
  const deps = {
    cwd: "/project",
    env: { QMD_SHARED_PORT: PORT },
    adapters: createRegistry({ "claude-code": () => Promise.resolve(adapter) }, { validate: false, aliases: { claude: "claude-code" } }),
    stderr: { write: (s) => err.push(s) },
    stdout: { write() {} },
    loadConfigFn: () => config,
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: pending }),
    saveStateFn: () => {},
    daemon: { ensure: async (options) => (ensures.push(options), ensure ? ensure(options) : { running: true, started: false }) },
  };
  return { ensures, launches, err, go: () => run(argv, deps) };
}
test("toolgate claude with no prompt makes sure the daemon answers, once, on the managed port", async () => {
  const t = wrapperWith({ argv: ["claude"] });
  assert.equal(await t.go(), 0);
  assert.equal(t.ensures.length, 1);
  assert.equal(t.ensures[0].port, Number(PORT));
});
test("with a prompt, and with the user's own --resume, it does too, once", async () => {
  resetBackends();
  registerBackend("qmd", { match: async () => ({ servers: [], reasons: [], skills: [], commands: [], subagents: [], warnings: [] }) });
  try {
    for (const argv of [["claude", "do it"], ["claude", "--resume", "abc-123"], ["claude", "--resume", "abc-123", "do it"]]) {
      const t = wrapperWith({ argv });
      assert.equal(await t.go(), 0, JSON.stringify(argv));
      assert.equal(t.ensures.length, 1, JSON.stringify(argv));
    }
  } finally {
    resetBackends();
  }
});
test("--no-route, the regex backend and qmdUrl null do not start it", async () => {
  for (const [name, t] of [
    ["--no-route", wrapperWith({ argv: ["--no-route", "claude"] })],
    ["regex", wrapperWith({ config: { baseline: [], router: { backend: "regex" } }, argv: ["claude"] })],
    ["no backend set", wrapperWith({ config: { baseline: [] }, argv: ["claude"] })],
    ["--backend regex", wrapperWith({ argv: ["--backend", "regex", "claude"] })],
    ["qmdUrl null", wrapperWith({ config: { baseline: [], router: { backend: "qmd", qmdUrl: null } }, argv: ["claude"] })],
  ]) {
    assert.equal(await t.go(), 0, name);
    assert.equal(t.ensures.length, 0, name);
  }
});
test("the relaunch that resumes the conversation after an escalation does not ask again, and a failed ensure goes on with its line", async () => {
  const t = wrapperWith({ argv: ["claude"], escalateOnce: true });
  assert.equal(await t.go(), 0);
  assert.deepEqual(t.launches.map((l) => l.resume), [false, true], "it did relaunch");
  assert.equal(t.ensures.length, 1);
  const failed = wrapperWith({ argv: ["claude"], ensure: async () => ({ running: false, reason: "did not answer" }) });
  assert.equal(await failed.go(), 0);
  assert.match(failed.err.join(""), /^toolgate: qmd daemon unavailable \(did not answer\); routing falls back to the qmd CLI\n/m);
});
