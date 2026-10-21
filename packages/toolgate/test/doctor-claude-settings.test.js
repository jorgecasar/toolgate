// `toolgate doctor` and the launch note on the user's own Claude Code settings that change what toolgate prepares. Throwaway project and HOME;
// the real ~/.claude is never read (the home is given to doctor, and the launch gets its own).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { launch } from "../src/adapters/claude-code.js";
import { tierZeroRegistry } from "./support/tierZeroRegistry.js";
import { step0RulesIn } from "../src/claudeSettings.js";
const MCP = { mcpServers: { "chrome-devtools": { command: "x" }, repo: { command: "y" } } };
function project({ files = {}, home = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cs-"));
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cs-home-"));
  for (const [root, map] of [[cwd, { ".mcp.json": MCP, ...files }], [homedir, home]]) {
    for (const [name, content] of Object.entries(map)) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    }
  }
  return { cwd, homedir };
}
async function report(setup) {
  const { cwd, homedir } = project(setup);
  const out = [];
  await run(["doctor", "--json"], {
    cwd,
    env: { TOOLGATE_DEFAULTS: path.join(homedir, "none.json"), PATH: "" },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => {} },
    doctor: { homedir, registry: tierZeroRegistry, execFn: () => { throw new Error("ENOENT"); }, daemon: { status: async () => ({ running: false }) } },
  });
  return JSON.parse(out.join("")).checks;
}
const of = (checks, id) => checks.filter((c) => c.id === id && c.level !== "ok");
const LOCAL = ".claude/settings.local.json";
test("a file that disables a server in .mcp.json gets the exact warning and fix; a server that is not in .mcp.json gets nothing; the user file is read from the home", async () => {
  const checks = await report({
    files: { [LOCAL]: { disabledMcpjsonServers: ["chrome-devtools", "not-in-mcp-json"] } },
    home: { ".claude/settings.json": { disabledMcpjsonServers: ["repo"] } },
  });
  const found = of(checks, "claude.settings");
  assert.deepEqual(found.map((c) => [c.level, c.message, c.hint]), [
    ["warn", "~/.claude/settings.json disables repo (disabledMcpjsonServers); Claude Code rejects it even when toolgate activates it", "remove repo from disabledMcpjsonServers in ~/.claude/settings.json"],
    ["warn", ".claude/settings.local.json disables chrome-devtools (disabledMcpjsonServers); Claude Code rejects it even when toolgate activates it", "remove chrome-devtools from disabledMcpjsonServers in .claude/settings.local.json"],
  ]);
});
test("an enabledMcpjsonServers pin is a warning that names the file and the servers, and says what it does", async () => {
  const checks = await report({ files: { ".claude/settings.json": { enabledMcpjsonServers: ["repo", "x"] } }, home: { ".claude/settings.json": { enabledMcpjsonServers: [] } } });
  const found = of(checks, "mcp.strayPins");
  assert.deepEqual(found.map((c) => [c.message, c.hint]), [
    ["~/.claude/settings.json pins enabledMcpjsonServers: this pin enables them without asking, and a disabledMcpjsonServers entry in any file overrides it; with --strict-mcp-config it loads nothing", "remove the key from that file if toolgate should decide which servers load"],
    [".claude/settings.json pins enabledMcpjsonServers (repo, x): this pin enables them without asking, and a disabledMcpjsonServers entry in any file overrides it; with --strict-mcp-config it loads nothing", "remove the key from that file if toolgate should decide which servers load"],
  ]);
  assert.equal(of(await report({ files: { ".claude/settings.json": { permissions: {} } } }), "mcp.strayPins").length, 0);
});
test("a deny or ask rule that matches the Step 0 command is a warning with its text, and an unrelated rule is not", async () => {
  const checks = await report({
    files: { [LOCAL]: { permissions: { deny: ["Bash(toolgate:*)", "Bash(npm:*)", "Read(*)"], ask: ["Bash"] } } },
    home: { ".claude/settings.json": { permissions: { deny: ["Bash(toolgate need *)"] } } },
  });
  assert.deepEqual(of(checks, "claude.settings").map((c) => [c.message, c.hint]), [
    ["~/.claude/settings.json denies Bash(toolgate need *), which blocks the Step 0 command (toolgate need)", "narrow or remove Bash(toolgate need *) in ~/.claude/settings.json"],
    [".claude/settings.local.json denies Bash(toolgate:*), which blocks the Step 0 command (toolgate need)", "narrow or remove Bash(toolgate:*) in .claude/settings.local.json"],
    [".claude/settings.local.json asks for Bash, so every task prompts before toolgate need runs", "narrow or remove Bash in .claude/settings.local.json"],
  ]);
});
test("the matching table of the Step 0 rules", () => {
  const rules = (list) => step0RulesIn({ permissions: { deny: list } }).map((r) => r.rule);
  assert.deepEqual(rules(["Bash", "Bash(*)", "Bash(toolgate:*)", "Bash(toolgate need *)", "Bash(tool*)", "Bash(toolgate need:*)", "Bash()"]), ["Bash", "Bash(*)", "Bash(toolgate:*)", "Bash(toolgate need *)", "Bash(tool*)", "Bash(toolgate need:*)", "Bash()"]);
  assert.deepEqual(rules(["Bash(npm:*)", "Read(*)", "Bash(toolgate escalate:*)", "Bash(toolgate needs *)", "Bash(git *)", "WebFetch", 3, null, "Bash(toolgate need x y)"]), []);
});
test("the matching is anchored at both ends and keeps the order of the pieces", () => {
  const rules = (list) => step0RulesIn({ permissions: { deny: list } }).map((r) => r.rule);
  assert.deepEqual(rules(["Bash(*gate need x)", "Bash(toolgate need x*)", "Bash(*need*)", "Bash(t*d*x)", "Bash(toolgate *x)", "Bash(*)", "Bash(toolgate need x:*)"]), ["Bash(*gate need x)", "Bash(toolgate need x*)", "Bash(*need*)", "Bash(t*d*x)", "Bash(toolgate *x)", "Bash(*)", "Bash(toolgate need x:*)"]);
  assert.deepEqual(rules(["Bash(oolgate*)", "Bash(*toolgate need)", "Bash(*need*toolgate*)", "Bash(toolgate need x)x", "Bash(*x*x*)", "Bash(toolgate need xx*)", "Bash(*d*d*x)", "Bash(*x*x)", "Bash(toolgate need x*x)"]), []);
});
test("a pattern made of many stars cannot hang doctor: 40 stars and a letter, and 100000 characters, are decided at once", () => {
  const started = Date.now();
  const rules = ["Bash(" + "*".repeat(40) + "z)", "Bash(" + "*a".repeat(30) + "z)", "Bash(" + "*".repeat(100000) + "z)", "Bash(" + "a".repeat(100000) + ")", "Bash(" + "x*".repeat(50000) + ")"];
  assert.deepEqual(step0RulesIn({ permissions: { deny: rules } }), []);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});
test("a settings file that is a symbolic link is said under claude.settings and not read; a folder, a too large file or not an object are said by mcp.strayPins; a missing one says nothing", async () => {
  const { cwd, homedir } = project({ files: { ".claude/settings.json": "[]" } });
  fs.mkdirSync(path.join(cwd, ".claude", "settings.local.json"));
  fs.writeFileSync(path.join(homedir, "real.json"), JSON.stringify({ disabledMcpjsonServers: ["repo"], enabledMcpjsonServers: ["repo"] }));
  fs.mkdirSync(path.join(homedir, ".claude"), { recursive: true });
  fs.symlinkSync(path.join(homedir, "real.json"), path.join(homedir, ".claude", "settings.json"));
  const out = [];
  await run(["doctor", "--json"], { cwd, env: { TOOLGATE_DEFAULTS: path.join(homedir, "none.json"), PATH: "" }, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, doctor: { homedir, registry: tierZeroRegistry, execFn: () => { throw new Error("ENOENT"); }, daemon: { status: async () => ({ running: false }) } } });
  const checks = JSON.parse(out.join("")).checks;
  assert.deepEqual(of(checks, "claude.settings").map((c) => c.message), ["~/.claude/settings.json is a symbolic link; toolgate does not read it, so its settings were not checked"], "the link is not followed: its disable says nothing");
  assert.deepEqual(of(checks, "mcp.strayPins").map((c) => c.message), [
    ".claude/settings.json does not hold a JSON object",
    ".claude/settings.local.json is a symlink or not a file, and is not read",
  ]);
  const big = project({ files: { ".claude/settings.json": JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }) } });
  const out2 = [];
  await run(["doctor", "--json"], { cwd: big.cwd, env: { TOOLGATE_DEFAULTS: path.join(big.homedir, "none.json"), PATH: "" }, stdout: { write: (s) => out2.push(s) }, stderr: { write: () => {} }, doctor: { homedir: big.homedir, registry: tierZeroRegistry, execFn: () => { throw new Error("ENOENT"); }, daemon: { status: async () => ({ running: false }) } } });
  assert.match(of(JSON.parse(out2.join("")).checks, "mcp.strayPins")[0].message, /\.claude\/settings\.json is larger than 1048576 bytes, and is not read/);
  assert.equal(of(await report({}), "mcp.strayPins").length, 0, "a missing file says nothing");
});
test("one finding per file and name, however often a list repeats it, and one per file when two files name the same server", async () => {
  const checks = await report({
    files: { [LOCAL]: { disabledMcpjsonServers: ["repo", "repo", "repo"], permissions: { deny: ["Bash", "Bash"] }, enabledMcpjsonServers: ["a", "a"] } },
    home: { ".claude/settings.json": { disabledMcpjsonServers: ["repo"] } },
  });
  assert.deepEqual(of(checks, "claude.settings").map((c) => c.message), [
    "~/.claude/settings.json disables repo (disabledMcpjsonServers); Claude Code rejects it even when toolgate activates it",
    ".claude/settings.local.json disables repo (disabledMcpjsonServers); Claude Code rejects it even when toolgate activates it",
    ".claude/settings.local.json denies Bash, which blocks the Step 0 command (toolgate need)",
  ]);
  assert.match(of(checks, "mcp.strayPins")[0].message, /pins enabledMcpjsonServers \(a\):/);
});
test("a server name with an escape is printed safely", async () => {
  const bad = "chrome\u001b[31m";
  const { cwd, homedir } = project({ files: { ".mcp.json": { mcpServers: { [bad]: { command: "x" } } }, [LOCAL]: { disabledMcpjsonServers: [bad] } } });
  const out = [];
  await run(["doctor", "--json"], { cwd, env: { TOOLGATE_DEFAULTS: path.join(homedir, "none.json"), PATH: "" }, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, doctor: { homedir, registry: tierZeroRegistry, execFn: () => { throw new Error("ENOENT"); }, daemon: { status: async () => ({ running: false }) } } });
  const found = of(JSON.parse(out.join("")).checks, "claude.settings");
  assert.equal(found.length, 1);
  assert.doesNotMatch(`${found[0].message} ${found[0].hint}`, /\u001b/);
});
test("an env block that sets TOOLGATE_* or QMD_SHARED_PORT is a warning; another variable is not", async () => {
  const checks = await report({
    files: { [LOCAL]: { env: { TOOLGATE_SESSION_STATE: "a", FOO: "b", QMD_SHARED_PORT: "1" } } },
    home: { ".claude/settings.json": { env: { TOOLGATE_REPO_TOOLS: "x" } } },
  });
  assert.deepEqual(of(checks, "claude.settings").map((c) => [c.message, c.hint]), [
    ["~/.claude/settings.json sets TOOLGATE_REPO_TOOLS in env, which overrides the value toolgate passes at launch to MCP servers", "remove TOOLGATE_REPO_TOOLS from env in ~/.claude/settings.json"],
    [".claude/settings.local.json sets TOOLGATE_SESSION_STATE in env, which overrides the value toolgate passes at launch to MCP servers", "remove TOOLGATE_SESSION_STATE from env in .claude/settings.local.json"],
    [".claude/settings.local.json sets QMD_SHARED_PORT in env, which overrides the value toolgate passes at launch to MCP servers", "remove QMD_SHARED_PORT from env in .claude/settings.local.json"],
  ]);
  assert.equal(of(await report({ files: { [LOCAL]: { env: { FOO: "1" } } } }), "claude.settings").length, 0);
});
test("names and values in these files are printed safely, and a file that is not readable says nothing here", async () => {
  const checks = await report({ files: { [LOCAL]: { permissions: { deny: ["Bash(toolgate\u001b[31m:*)"] }, env: { "TOOLGATE_\u001b[31mX": "1" } }, ".claude/settings.json": "{ no" } });
  for (const c of of(checks, "claude.settings")) assert.doesNotMatch(`${c.message} ${c.hint}`, /\u001b/);
  assert.equal(of(checks, "claude.settings").length, 1, "the rule with an escape does not match; the env name does");
  assert.ok(of(checks, "mcp.strayPins").some((c) => /is not valid JSON/.test(c.message)));
});
// The launch note: a fake claude that records nothing but is started; only stderr matters.
async function launchNote({ active, settings, home, raw = false, quiet = false }) {
  const { cwd, homedir } = project({ files: settings ? { [LOCAL]: settings } : {}, home: home ?? {} });
  const err = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
  const options = { mcpJsonPath: path.join(cwd, ".mcp.json"), config: { baseline: active }, state: { extras: [], toolExtras: {}, pendingRestart: false }, cwd, homedir, stderr: { write: (s) => err.push(s) }, spawnFn, writeFileFn: () => {}, rmFn: () => {}, tmpDir: cwd, env: {} };
  // The task path (`toolgate "<task>"`) and the wrapper path (`toolgate claude …`, the agent's own arguments) both say it.
  await (raw ? launch(["-p", "x"], options) : launch({ prompt: "x", quiet, ...options }));
  return err.join("");
}
test("a launch says it once for an active server that a settings file disables, and nothing for an inactive one", async () => {
  const active = await launchNote({ active: ["chrome-devtools"], settings: { disabledMcpjsonServers: ["chrome-devtools"] } });
  assert.match(active, /^toolgate: chrome-devtools is active but \.claude\/settings\.local\.json disables it \(disabledMcpjsonServers\), so Claude Code will not load it$/m);
  const wrapper = await launchNote({ active: ["chrome-devtools"], settings: { disabledMcpjsonServers: ["chrome-devtools"] }, raw: true });
  assert.match(wrapper, /^toolgate: chrome-devtools is active but \.claude\/settings\.local\.json disables it/m);
  // `--quiet` drops progress, not warnings: the note explains why a server the user asked for is missing.
  const quiet = await launchNote({ active: ["chrome-devtools"], settings: { disabledMcpjsonServers: ["chrome-devtools", "chrome-devtools"] }, quiet: true });
  assert.equal(quiet.match(/disables it/g)?.length, 1, "once, not once per repeat");
  const inactive = await launchNote({ active: ["repo"], settings: { disabledMcpjsonServers: ["chrome-devtools"] } });
  assert.doesNotMatch(inactive, /disables it/);
  const none = await launchNote({ active: ["chrome-devtools"] });
  assert.doesNotMatch(none, /disables it/);
});
