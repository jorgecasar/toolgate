// What a launch of Claude Code leaves, merges and says (#242 T2): the settings file goes, the prompt path merges like the wrapper
// path, the user's unreadable --settings is left out with a note, and a TERM is not success.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../src/adapters/claude-code.js";
import { run } from "../src/cli.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cl-")));
  made.push(dir);
  return dir;
};
const idle = { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] };
const DENY = { permissions: { deny: ["Bash(rm:*)"] } };
const NOTE = (file, reason) => `toolgate: your settings ${file} could not be read (${reason}); started with toolgate's permissions only\n`;

// Runs a launch with a fake spawn, a file system in memory for the settings and a recorder for what is removed.
async function go(shape, { agentArgs = [], args = [], files = {}, subagents = [], exit = [0, null], spawnFails = false, onWrite, cwd = "/project", homedir = "/home/none" } = {}) {
  const written = new Map();
  const removed = [];
  const errors = [];
  const calls = [];
  const children = [];
  const readFileFn = (file) => {
    if (written.has(file)) return written.get(file);
    if (file in files) {
      if (files[file] instanceof Error) throw files[file];
      return files[file];
    }
    throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
  };
  const io = {
    config: {},
    state: idle,
    signalSource: new EventEmitter(),
    spawnFn: (cmd, a) => {
      const child = new EventEmitter();
      calls.push(a);
      children.push(child);
      if (!spawnFails) queueMicrotask(() => child.emit("exit", ...exit));
      return child;
    },
    writeFileFn: (file, text, options) => (onWrite?.(file, options), written.set(file, text)),
    readFileFn,
    rmFn: (file) => removed.push(file),
    tmpDir: "/tmp",
    pid: 7,
    now: 9,
    cwd,
    homedir,
    mcpJsonPath: "/project/.mcp.json",
    stderr: { write: (s) => errors.push(s) },
    applied: { settings: DENY, cleanup() {} },
    subagents,
  };
  const started = shape === "wrapper" ? launch(args, { ...io }) : launch({ ...io, prompt: "go", agentArgs });
  let result;
  if (spawnFails) {
    // A failed spawn emits `error`: the files go, and the launch rejects with it.
    children[0].emit("error", new Error("spawn claude ENOENT"));
    result = { error: await started.then(() => assert.fail("it should reject"), (err) => err) };
    assert.match(result.error.message, /ENOENT/);
  } else {
    result = await started;
  }
  const settingsPath = "/tmp/toolgate-settings-7-9.json";
  return { result, calls: calls[0], removed, errors: errors.join(""), settings: written.has(settingsPath) ? JSON.parse(written.get(settingsPath)) : null, settingsPath };
}
const SHAPES = [["wrapper", { args: ["-x"] }], ["prompt", { agentArgs: ["-x"] }]];
const flagsOf = (args, flag) => args.reduce((n, arg) => n + (arg === flag || arg.startsWith(`${flag}=`) ? 1 : 0), 0);

test("the settings file of a launch is removed when the agent ends, and when it cannot start, on both paths", async () => {
  for (const [shape, extra] of SHAPES) {
    const ended = await go(shape, extra);
    assert.ok(ended.removed.includes(ended.settingsPath), `${shape}: removed after the agent ends`);
    const failed = await go(shape, { ...extra, spawnFails: true });
    assert.ok(failed.removed.includes(failed.settingsPath), `${shape}: removed after a failed spawn`);
  }
});
test("a user's --settings is folded into toolgate's on the prompt path as on the wrapper path: one --settings, both sets of keys", async () => {
  const files = { "/mine.json": JSON.stringify({ model: "opus", permissions: { allow: ["Read"], deny: ["Bash(curl:*)"] } }) };
  for (const [shape, extra] of [["wrapper", { args: ["--settings", "/mine.json"] }], ["prompt", { agentArgs: ["--settings", "/mine.json"] }], ["prompt", { agentArgs: ["--settings=/mine.json"] }]]) {
    const r = await go(shape, { ...extra, files });
    assert.equal(flagsOf(r.calls, "--settings"), 1, `${shape}: Claude takes the last --settings, so there must be one`);
    assert.equal(r.calls[r.calls.indexOf("--settings") + 1], r.settingsPath);
    assert.equal(r.settings.model, "opus", "their keys are kept");
    assert.ok(r.settings.permissions.deny.includes("Bash(rm:*)"), "toolgate's deny is kept");
    assert.ok(r.settings.permissions.deny.includes("Bash(curl:*)"), "and so is theirs");
    assert.equal(r.errors, "");
  }
});
test("a user's --agents is merged with toolgate's on the prompt path as on the wrapper path: one --agents, both sets", async () => {
  const subagents = [{ name: "ours", description: "d", prompt: "p" }];
  for (const [shape, extra] of [["wrapper", { args: ["--agents", '{"mine":{"description":"m","prompt":"p"}}'] }], ["prompt", { agentArgs: ["--agents", '{"mine":{"description":"m","prompt":"p"}}'] }]]) {
    const r = await go(shape, { ...extra, subagents });
    assert.equal(flagsOf(r.calls, "--agents"), 1, shape);
    assert.deepEqual(Object.keys(JSON.parse(r.calls[r.calls.indexOf("--agents") + 1])).sort(), ["mine", "ours"], shape);
  }
});
test("a --settings that cannot be read, is not valid JSON or is not an object is left out: toolgate's settings go on alone, one note, the content never printed", async () => {
  const secret = "TOP-SECRET-VALUE";
  const cases = [
    ["not found", {}, "/missing.json"],
    ["permission denied", { "/denied.json": Object.assign(new Error("EACCES"), { code: "EACCES" }) }, "/denied.json"],
    ["not valid JSON", { "/bad.json": `{ "k": "${secret}" ` }, "/bad.json"],
    ["not a JSON object", { "/list.json": JSON.stringify([secret]) }, "/list.json"],
    ["not a JSON object", { "/null.json": "null" }, "/null.json"],
  ];
  for (const [shape, key] of [["wrapper", "args"], ["prompt", "agentArgs"]]) {
    for (const [reason, files, file] of cases) {
      for (const spelled of [["--settings", file], [`--settings=${file}`]]) {
        const r = await go(shape, { [key]: ["-x", ...spelled], files });
        assert.equal(flagsOf(r.calls, "--settings"), 1, `${shape} ${reason}: only toolgate's --settings reaches Claude`);
        assert.deepEqual(r.settings.permissions.deny, ["Bash(rm:*)"], "toolgate's deny rules are in the file Claude reads");
        assert.equal(r.errors, NOTE(file, reason), `${shape} ${reason}`);
        assert.ok(!JSON.stringify(r.calls).includes(secret) && !r.errors.includes(secret), "the content is never printed or passed");
        assert.ok(r.calls.includes("-x"), "their other arguments are kept");
      }
    }
    const inline = await go(shape, { [key]: ["--settings", `{ "k": "${secret}"`] });
    assert.equal(inline.errors, NOTE("inline JSON", "not valid JSON"), "an inline value is not echoed");
    const two = await go(shape, { [key]: ["--settings", "/missing.json", "--settings", "/also-missing.json"] });
    assert.equal(two.errors, NOTE("/missing.json", "not found"), "once per launch");
    const hostile = await go(shape, { [key]: ["--settings", "/x\u001b[31m‮.json"] });
    assert.doesNotMatch(hostile.errors, /\u001b|‮/, "the path goes through printable()");
    assert.equal((await go(shape, { [key]: ["--settings"] })).errors, NOTE("--settings", "not found"), "a flag with no value");
  }
});
test("a settings file the user can read, or none, says nothing", async () => {
  for (const [shape, key] of [["wrapper", "args"], ["prompt", "agentArgs"]]) {
    assert.equal((await go(shape, { [key]: ["-x"] })).errors, "");
    assert.equal((await go(shape, { [key]: ["--settings", "/ok.json"], files: { "/ok.json": "{}" } })).errors, "");
  }
});
test("on the prompt path a TERM that ended the agent is exit 143 like the wrapper; its own exit code is kept", async () => {
  assert.equal((await go("prompt", { exit: [null, "SIGTERM"] })).result.code, 143);
  assert.equal((await go("wrapper", { exit: [null, "SIGTERM"] })).result.code, 143);
  assert.equal((await go("prompt", { exit: [3, null] })).result.code, 3);
  assert.equal((await go("prompt", { exit: [0, null] })).result.code, 0);
  const adapter = { launch: () => Promise.resolve({ code: 143 }) };
  const exit = await run(["--no-route", "go"], { cwd: "/project", stdout: { write() {} }, stderr: { write() {} }, env: {}, loadConfigFn: () => ({ defaultAgent: "claude-code" }), loadStateFn: () => idle, saveStateFn() {}, adapters: { "claude-code": () => Promise.resolve(adapter) } });
  assert.equal(exit, 143, "toolgate itself exits with it");
});

// The real thing: toolgate is killed with SIGKILL while its agent goes on, and a second launch must not take what the agent reads.
test("a second launch never deletes the files of a first whose toolgate was SIGKILLed while its agent runs", { timeout: 60000, skip: process.platform === "win32" }, async () => {
  const root = tmp();
  const sandbox = { HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "cfg"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), TMPDIR: path.join(root, "t") };
  for (const dir of [...Object.values(sandbox), path.join(root, "bin"), path.join(root, "project", ".git")]) fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(root, "agent.pid");
  fs.writeFileSync(path.join(root, "bin", "claude"), `#!/bin/sh\nif [ -n "$FAKE_SLEEP" ]; then echo $$ > "${marker}"; exec sleep 60; fi\nexit 0\n`, { mode: 0o755 });
  const env = { ...sandbox, PATH: `${path.join(root, "bin")}:/usr/bin:/bin:${path.dirname(process.execPath)}`, QMD_SHARED_PORT: "39555" };
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "toolgate.js");
  const cwd = path.join(root, "project");
  const first = spawn(process.execPath, [bin, "claude", "-x"], { cwd, env: { ...env, FAKE_SLEEP: "1" }, stdio: "ignore" });
  const until = async (done) => {
    for (const deadline = Date.now() + 15000; Date.now() < deadline && !done(); ) await new Promise((resolve) => setTimeout(resolve, 50));
    return done();
  };
  const agentPid = () => (fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0);
  const names = () => fs.readdirSync(sandbox.TMPDIR).filter((n) => n.startsWith("toolgate-"));
  try {
    assert.ok(await until(() => agentPid() > 0 && names().some((n) => n.startsWith("toolgate-settings-"))), "the first launch is running its agent");
    const before = names();
    first.kill("SIGKILL");
    await new Promise((resolve) => first.once("exit", resolve));
    const second = spawnSync(process.execPath, [bin, "claude", "-y"], { cwd, env, encoding: "utf8", timeout: 30000 });
    assert.equal(second.status, 0, second.stderr);
    for (const name of before) assert.ok(names().includes(name), `${name}: the agent of the first launch is alive and reads it`);
  } finally {
    first.kill("SIGKILL");
    if (agentPid()) try { process.kill(agentPid(), "SIGKILL"); } catch { /* gone */ }
  }
});
test("the settings file is written for its owner only (mode 600), whichever path and whether or not --settings was merged", async () => {
  for (const [shape, key] of [["wrapper", "args"], ["prompt", "agentArgs"]]) {
    for (const extra of [[], ["--settings", "/ok.json"]]) {
      const modes = [];
      const r = await go(shape, { [key]: extra, files: { "/ok.json": "{}" }, onWrite: (file, options) => modes.push([file, options?.mode]) });
      assert.ok(modes.filter(([file]) => file === r.settingsPath).length >= 1);
      for (const [file, mode] of modes.filter(([f]) => f === r.settingsPath)) assert.equal(mode, 0o600, `${shape} ${extra.length ? "merged" : "plain"}: ${file}`);
    }
  }
});

// The user's own settings that turn toolgate's guards off: respected, said in one line before the agent starts.
const LINE = (list) => `toolgate: your Claude Code settings turn off toolgate's guards for this session: ${list}\n`;
function home(files) {
  const cwd = tmp();
  const homedir = tmp();
  for (const [where, map] of [[cwd, files.project ?? {}], [homedir, files.user ?? {}]]) {
    for (const [name, data] of Object.entries(map)) {
      fs.mkdirSync(path.dirname(path.join(where, name)), { recursive: true });
      fs.writeFileSync(path.join(where, name), JSON.stringify(data));
    }
  }
  return { cwd, homedir };
}
test("each guard-off setting in each of the three Claude Code files gives the exact line, once, on both paths", async () => {
  const cases = [
    [{ user: { ".claude/settings.json": { disableAllHooks: true } } }, "disableAllHooks in ~/.claude/settings.json"],
    [{ project: { ".claude/settings.json": { disableAllHooks: true } } }, "disableAllHooks in .claude/settings.json"],
    [{ project: { ".claude/settings.local.json": { disableAllHooks: true } } }, "disableAllHooks in .claude/settings.local.json"],
    [{ user: { ".claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } } } }, "permissions.defaultMode bypassPermissions in ~/.claude/settings.json"],
    [{ project: { ".claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } } } }, "permissions.defaultMode bypassPermissions in .claude/settings.json"],
    [{ project: { ".claude/settings.local.json": { permissions: { defaultMode: "bypassPermissions" } } } }, "permissions.defaultMode bypassPermissions in .claude/settings.local.json"],
  ];
  for (const [files, list] of cases) {
    for (const [shape, key] of [["wrapper", "args"], ["prompt", "agentArgs"]]) {
      const r = await go(shape, { [key]: ["-x"], ...home(files) });
      assert.equal(r.errors, LINE(list), `${shape}: ${list}`);
    }
  }
});
test("other values, symlinked or unreadable files and nothing at all say nothing; the agent starts with the same arguments either way", async () => {
  const quiet = home({ project: { ".claude/settings.json": { disableAllHooks: false, permissions: { defaultMode: "default" } } }, user: { ".claude/settings.json": { disableAllHooks: "yes" } } });
  const loud = home({ project: { ".claude/settings.json": { disableAllHooks: true } } });
  for (const [shape, key] of [["wrapper", "args"], ["prompt", "agentArgs"]]) {
    const a = await go(shape, { [key]: ["-x"], ...quiet });
    assert.equal(a.errors, "");
    const b = await go(shape, { [key]: ["-x"], ...loud });
    assert.deepEqual(b.calls, a.calls, `${shape}: the launch is unchanged, only the line is added`);
    assert.deepEqual(b.settings, a.settings);
  }
  const linked = home({});
  fs.mkdirSync(path.join(linked.cwd, ".claude"));
  fs.writeFileSync(path.join(linked.cwd, "real.json"), JSON.stringify({ disableAllHooks: true }));
  fs.symlinkSync(path.join(linked.cwd, "real.json"), path.join(linked.cwd, ".claude/settings.json"));
  fs.writeFileSync(path.join(linked.cwd, ".claude/settings.local.json"), "{ nope");
  assert.equal((await go("prompt", { agentArgs: ["-x"], ...linked })).errors, "");
});
test("two sources make one line listing both, in the order files then forwarded settings then flags", async () => {
  const both = home({ project: { ".claude/settings.json": { disableAllHooks: true }, ".claude/settings.local.json": { permissions: { defaultMode: "bypassPermissions" } } } });
  for (const [shape, key] of [["wrapper", "args"], ["prompt", "agentArgs"]]) {
    const r = await go(shape, { [key]: ["--settings", "/mine.json", "--dangerously-skip-permissions", "-x"], files: { "/mine.json": JSON.stringify({ disableAllHooks: true }) }, ...both });
    assert.equal(r.errors, LINE("disableAllHooks in .claude/settings.json, permissions.defaultMode bypassPermissions in .claude/settings.local.json, disableAllHooks in /mine.json, permissions.defaultMode bypassPermissions in the --dangerously-skip-permissions flag"), shape);
  }
});
test("the same setting from the same place is listed once, even when the file is forwarded twice", async () => {
  for (const [shape, key] of [["wrapper", "args"], ["prompt", "agentArgs"]]) {
    const r = await go(shape, { [key]: ["--settings", "/mine.json", "--settings=/mine.json"], files: { "/mine.json": JSON.stringify({ disableAllHooks: true }) } });
    assert.equal(r.errors, LINE("disableAllHooks in /mine.json"), shape);
  }
});
test("the flags that skip the prompts give the line, but only before a --; an unreadable --settings keeps the T2 note and no guard line", async () => {
  for (const [args, list] of [
    [["--dangerously-skip-permissions"], "the --dangerously-skip-permissions flag"],
    [["--permission-mode", "bypassPermissions"], "the --permission-mode flag"],
    [["--permission-mode=bypassPermissions"], "the --permission-mode flag"],
  ]) {
    for (const [shape, key] of [["wrapper", "args"], ["prompt", "agentArgs"]]) {
      const r = await go(shape, { [key]: args });
      assert.equal(r.errors, LINE(`permissions.defaultMode bypassPermissions in ${list}`), `${shape}: ${args.join(" ")}`);
    }
  }
  for (const args of [["--permission-mode", "plan"], ["--permission-mode"], ["--", "--dangerously-skip-permissions"], ["-p", "--", "--permission-mode", "bypassPermissions"]]) {
    assert.equal((await go("wrapper", { args })).errors, "", args.join(" "));
  }
  const unreadable = await go("prompt", { agentArgs: ["--settings", "/missing.json"] });
  assert.equal(unreadable.errors, NOTE("/missing.json", "not found"));
});
test("the line is printable: a hostile path of a forwarded --settings never reaches the terminal raw", async () => {
  const r = await go("prompt", { agentArgs: ["--settings", "/x\u001b[31m\u202e.json"], files: { "/x\u001b[31m\u202e.json": JSON.stringify({ disableAllHooks: true }) } });
  assert.match(r.errors, /^toolgate: your Claude Code settings turn off toolgate's guards for this session: disableAllHooks in \/x/);
  assert.doesNotMatch(r.errors, /\u001b|\u202e/);
  assert.equal(r.errors.split("\n").length, 2, "one line");
});
