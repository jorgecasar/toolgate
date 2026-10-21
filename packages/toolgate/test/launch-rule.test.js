// client.injectRule: the Step 0 text goes in as the agent's appended system prompt for this launch, and nowhere else (#135).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { launch as launchClaude } from "../src/adapters/claude-code.js";
import { defaultRegistry } from "../src/adapters/index.js";
import { validateCapability } from "../src/capability.js";
import { applyChange } from "../src/configFile.js";
import { mergeConfigLayers } from "../src/config.js";
import { BUILTIN_RULE_TEMPLATE } from "../src/ruleText.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-lr-")));
  made.push(dir);
  return dir;
};
const idle = { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] };
const FLAG = "--append-system-prompt";
const run = async (first, { config = {}, cwd = tmp() } = {}) => {
  const calls = [];
  const errors = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    calls.push(args);
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const io = { spawnFn, readFileFn: () => JSON.stringify({ mcpServers: {} }), writeFileFn: () => {}, tmpDir: "/tmp", config, state: idle, cwd, stderr: { write: (s) => errors.push(s) } };
  if (Array.isArray(first)) await launchClaude(first, io);
  else await launchClaude({ ...first, ...io });
  return { args: calls[0], errors: errors.join("") };
};
const after_ = (args) => args[args.indexOf(FLAG) + 1];

test("the capability declares the flag, and a bad one is refused", () => {
  const claude = defaultRegistry.get("claude-code");
  return Promise.resolve(claude).then((adapter) => {
    assert.equal(adapter.capability.rules.injectFlag, FLAG);
    assert.deepEqual(validateCapability(adapter.capability), []);
    const bad = (rules) => validateCapability(Object.freeze({ ...adapter.capability, rules: Object.freeze(rules) })).join(" ");
    assert.match(bad({ kind: "projectFile", path: "x", injectFlag: "append" }), /injectFlag/);
    assert.match(bad({ kind: "none", injectFlag: FLAG }), /injectFlag/);
  });
});

test("with client.injectRule the built-in Step 0 text is appended before the prompt; without it, nothing", async () => {
  const text = fs.readFileSync(BUILTIN_RULE_TEMPLATE, "utf8");
  const on = await run({ prompt: "do it" }, { config: { client: { injectRule: true } } });
  assert.equal(after_(on.args), text);
  assert.equal(on.args.at(-1), "do it", "the prompt stays last");
  assert.deepEqual(on.args.slice(0, 2), ["--settings", on.args[1]]);
  assert.equal(on.args[2], FLAG, "right after --settings, before everything else");
  assert.equal((await run({ prompt: "do it" })).args.includes(FLAG), false);
  assert.equal((await run({ prompt: "do it" }, { config: { client: { injectRule: false } } })).args.includes(FLAG), false);
  const passthrough = await run(["-p", "go"], { config: { client: { injectRule: true } } });
  assert.equal(after_(passthrough.args), text);
});

test("a -- of the user's makes everything after it text: the flag goes before it, and a flag after it is not theirs", async () => {
  const config = { client: { injectRule: true } };
  const text = fs.readFileSync(BUILTIN_RULE_TEMPLATE, "utf8");
  const sep = await run(["-p", "--", "do"], { config });
  assert.equal(after_(sep.args), text);
  assert.ok(sep.args.indexOf(FLAG) < sep.args.indexOf("--"), "before the --");
  assert.deepEqual(sep.args.slice(sep.args.indexOf("--")), ["--", "do"], "their text is untouched");
  const after = await run(["-p", "hi", "--", FLAG, "mine"], { config });
  assert.equal(after_(after.args), text, "theirs is only text after the --, so the rule is still injected");
  assert.equal(after.errors, "");
  assert.deepEqual(after.args.slice(after.args.indexOf("--")), ["--", FLAG, "mine"]);
});

test("rule.template is what is injected; a project one never is", async () => {
  const cwd = tmp();
  const mine = path.join(cwd, "mine.md");
  fs.writeFileSync(mine, "MY RULE");
  const trusted = mergeConfigLayers([{ client: { injectRule: true }, rule: { template: mine } }, null, null], [{ name: "user" }, { name: "project" }, { name: "local" }]);
  assert.equal(after_((await run({ prompt: "x" }, { config: trusted, cwd })).args), "MY RULE");
  fs.writeFileSync(path.join(cwd, "evil.md"), "EVIL RULE");
  const hostile = mergeConfigLayers([null, { client: { injectRule: true }, rule: { template: path.join(cwd, "evil.md") } }, null], [{ name: "user" }, { name: "project" }, { name: "local" }]);
  const sent = after_((await run({ prompt: "x" }, { config: hostile, cwd })).args);
  assert.notEqual(sent, "EVIL RULE");
  assert.match(sent, /toolgate need/);
});

test("the user's own --append-system-prompt wins and is not merged; an unreadable template warns and launches without it", async () => {
  const config = { client: { injectRule: true } };
  const mine = await run(["--append-system-prompt", "MINE", "-p", "go"], { config });
  assert.deepEqual(mine.args.filter((arg) => arg === FLAG), [FLAG], "only theirs");
  assert.ok(mine.args.includes("MINE"));
  assert.match(mine.errors, /you passed --append-system-prompt yourself/);
  assert.match((await run(["--append-system-prompt=MINE", "-p", "go"], { config })).errors, /yourself/);
  const cwd = tmp();
  const broken = await run({ prompt: "x" }, { config: { client: { injectRule: true }, rule: { template: path.join(cwd, "nope.md") } }, cwd });
  assert.equal(broken.args.includes(FLAG), false);
  assert.match(broken.errors, /not a readable file; launching without the Step 0 rule/);
  assert.equal(broken.args.at(-1), "x");
});

test("client.injectRule is a boolean key for any layer", () => {
  assert.equal(applyChange({}, { action: "set", key: "client.injectRule", value: true, layer: "project" }), true);
  assert.throws(() => applyChange({}, { action: "set", key: "client.injectRule", value: "yes", layer: "user" }), /boolean|true or false/i);
});
// A FIFO read in this process would block it: the launch runs in a child process with a deadline.
test("a rule.template that is a FIFO or /dev/null is not injected: the launch warns and goes on, and does not hang", { skip: process.platform === "win32" }, () => {
  const cwd = tmp();
  const fifo = path.join(cwd, "rule.fifo");
  execFileSync("mkfifo", [fifo]);
  const adapter = new URL("../src/adapters/claude-code.js", import.meta.url).href;
  for (const template of [fifo, "/dev/null"]) {
    const code = `
      import { EventEmitter } from "node:events";
      import { launch } from ${JSON.stringify(adapter)};
      const calls = [];
      const spawnFn = (cmd, args) => { const child = new EventEmitter(); calls.push(args); queueMicrotask(() => child.emit("exit", 0, null)); return child; };
      const errors = [];
      await launch({ prompt: "x", spawnFn, readFileFn: () => "{}", writeFileFn: () => {}, tmpDir: "/tmp", config: { client: { injectRule: true }, rule: { template: ${JSON.stringify(template)} } }, state: { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }, cwd: ${JSON.stringify(cwd)}, stderr: { write: (s) => errors.push(s) } });
      console.log(JSON.stringify({ injected: calls[0].includes("--append-system-prompt"), errors: errors.join("") }));
    `;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
    assert.equal(out.error, undefined, `${template}: the launch did not finish in time`);
    assert.equal(out.status, 0, out.stderr);
    const result = JSON.parse(out.stdout);
    assert.equal(result.injected, false, template);
    assert.match(result.errors, /not a readable file; launching without the Step 0 rule/, template);
  }
});
