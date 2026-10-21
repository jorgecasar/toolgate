// `toolgate --resume [value]` on the task path (the claude-code adapter's own argument description, a fake launch): the id or the search term
// is the flag's value and is forwarded whole; the task is what follows it, if anything does. toolgate never rewrites the arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli.js";
import { agentCli } from "../src/adapters/claude-code.js";
function launchOf(argv) {
  const launches = [];
  const adapter = { agentCli, launch: (options) => (launches.push(options), Promise.resolve({ code: 0 })) };
  const deps = {
    cwd: "/project",
    env: { TOOLGATE_ADAPTER: "claude-code" },
    stdout: { write() {} },
    stderr: { write() {} },
    loadConfigFn: () => ({ baseline: [] }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {},
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  };
  return run(argv, deps).then((code) => ({ code, launch: launches[0] }));
}
test("--resume in its four forms, -r, --resume=v and a flag after it: the value stays with the flag and the task is what follows", async () => {
  const cases = [
    [["--resume"], undefined, ["--resume"]],
    [["--resume", "abc-123"], undefined, ["--resume", "abc-123"]],
    [["--resume", "abc-123", "do it"], "do it", ["--resume", "abc-123"]],
    [["--resume", "do it"], undefined, ["--resume", "do it"]],
    [["-r", "do it"], undefined, ["-r", "do it"]],
    [["-r", "abc-123", "do it"], "do it", ["-r", "abc-123"]],
    [["--resume=abc-123", "do it"], "do it", ["--resume=abc-123"]],
    [["--resume", "--model", "opus", "do it"], "do it", ["--resume", "--model", "opus"]],
  ];
  for (const [argv, prompt, agentArgs] of cases) {
    const { code, launch } = await launchOf(argv);
    assert.equal(code, 0);
    assert.deepEqual([launch.prompt, launch.agentArgs], [prompt, agentArgs], JSON.stringify(argv));
  }
});
