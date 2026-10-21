// What client.injectRule does for every registered adapter (#268): the two that verified an equivalent carry the rule; the rest
// are pinned, so a new CLI that gains one is a decision and a test change, not a drift.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGenericAdapter } from "../src/adapters/generic.js";
import { defaultRegistry } from "../src/adapters/index.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-lra-")));
  made.push(dir);
  return dir;
};
const idle = { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] };
const argsOf = async (adapter, injectRule) => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    calls.push(args);
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const cwd = tmp();
  await adapter.launch({
    prompt: "do it", spawnFn, readFileFn: () => JSON.stringify({ mcpServers: {} }), writeFileFn: () => {}, mkdirFn: () => {},
    tmpDir: tmp(), projectDir: cwd, cwd, stderr: { write: () => {} }, config: { client: { injectRule } }, state: idle,
  });
  return calls[0];
};

// adapter, whether the launch carries the rule, the rules.kind it is pinned to, and why.
const generic = createGenericAdapter({ bin: "agent", configFile: "c.json", format: "json" });
const ROWS = [
  ["claude-code", true, "projectFile", "--append-system-prompt, verified"],
  ["codex", true, "projectFile", "-c developer_instructions, verified on codex-cli 0.145.0"],
  ["opencode", false, "projectFile", "no CLI equivalent verified yet: it reads AGENTS.md"],
  ["antigravity", false, "projectFile", "no CLI equivalent verified yet: it reads its rules folder"],
  ["karajan", false, "unknown", "runs `kj run`; no CLI equivalent verified yet"],
  ["generic", false, "unknown", "a spec-declared agent; nothing is known of its CLI"],
];

test("the table covers every registered adapter and the generic one", () => {
  assert.deepEqual(ROWS.map(([name]) => name).sort(), [...defaultRegistry.names(), "generic"].sort());
});

for (const [name, carries, kind, why] of ROWS) {
  test(`${name}: ${carries ? "the launch carries the Step 0 rule" : "pinned to no injection, its arguments are unchanged"} (${why})`, async () => {
    const adapter = name === "generic" ? generic : await defaultRegistry.get(name);
    assert.equal(adapter.capability.rules.kind, kind);
    const on = await argsOf(adapter, true);
    const off = await argsOf(adapter, false);
    if (carries) {
      assert.notDeepEqual(on, off);
      assert.ok(on.join("\n").includes("toolgate need"), "the Step 0 text is in the arguments");
    } else {
      assert.deepEqual(on, off);
      assert.equal(adapter.capability.rules.injectFlag, undefined);
      assert.equal(adapter.capability.rules.injectConfigKey, undefined);
    }
    assert.equal(off.join("\n").includes("toolgate need"), false, "off: nothing is added");
  });
}
