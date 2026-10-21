// An agent that cannot be started (not in the PATH, not executable) makes the launch reject, in every adapter (#303): an `error` event
// without a listener, or a throw inside one, would end toolgate before it could keep the escalations it consumed.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { failureText } from "../src/cli.js";
import { fileURLToPath } from "node:url";
import * as claude from "../src/adapters/claude-code.js";
import * as codex from "../src/adapters/codex.js";
import * as opencode from "../src/adapters/opencode.js";
import * as antigravity from "../src/adapters/antigravity.js";
import * as karajan from "../src/adapters/karajan.js";
import { createGenericAdapter } from "../src/adapters/generic.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-missing-")));
  made.push(dir);
  return dir;
};
const MISSING = "toolgate-no-such-agent-for-tests";
const idle = { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] };
const base = () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  return { dir, io: { config: { baseline: [] }, state: idle, env: { PATH: "", HOME: dir }, projectDir: dir, cwd: dir, tmpDir: dir, mcpJsonPath: path.join(dir, ".mcp.json"), stderr: { write: () => {} }, homedir: dir } };
};

test("claude, on the wrapper path and on the prompt path: the launch rejects, and the settings file goes", { timeout: 10_000 }, async () => {
  const { dir, io } = base();
  await assert.rejects(claude.launch(["hello"], { ...io, claudeBin: MISSING, resume: false }), { code: "ENOENT" });
  await assert.rejects(claude.launch({ ...io, prompt: "hello", claudeBin: MISSING }), { code: "ENOENT" });
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("toolgate-settings")), []);
});

test("opencode: the launch rejects", { timeout: 10_000 }, async () => {
  const { io } = base();
  await assert.rejects(opencode.launch({ ...io, prompt: "hello", opencodeBin: MISSING }), { code: "ENOENT" });
});

test("codex: the launch rejects", { timeout: 10_000 }, async () => {
  const { dir, io } = base();
  await assert.rejects(codex.launch({ ...io, prompt: "hello", codexBin: MISSING, codexConfigPath: path.join(dir, "config.toml"), env: { ...io.env, CODEX_HOME: dir } }), { code: "ENOENT" });
});

test("antigravity: the launch rejects", { timeout: 10_000 }, async () => {
  const { dir, io } = base();
  await assert.rejects(antigravity.launch({ ...io, prompt: "hello", antigravityBin: MISSING, mcpConfigPath: path.join(dir, "mcp_config.json") }), { code: "ENOENT" });
});

test("karajan: the launch rejects", { timeout: 10_000 }, async () => {
  const { io } = base();
  await assert.rejects(karajan.launch({ ...io, prompt: "hello", kjBin: MISSING }), { code: "ENOENT" });
});

test("a generic adapter declared in the config: the launch rejects", { timeout: 10_000 }, async () => {
  const { dir, io } = base();
  const adapter = createGenericAdapter({ name: "mine", bin: MISSING, configFile: "mine/mcp.json", format: "json", serversKey: "mcpServers" });
  await assert.rejects(adapter.launch({ ...io, prompt: "hello", root: dir }), { code: "ENOENT" });
});

test("a program that cannot be run at all (spawn throws) removes what the launch made: claude on both paths, opencode", { timeout: 10_000 }, async () => {
  const bad = () => { throw Object.assign(new Error("spawn ENOEXEC"), { code: "ENOEXEC" }); };
  const { dir, io } = base();
  const removed = [];
  const rmFn = (file) => removed.push(file);
  await assert.rejects(claude.launch(["hello"], { ...io, spawnFn: bad, rmFn, resume: false }), { code: "ENOEXEC" });
  await assert.rejects(claude.launch({ ...io, prompt: "hello", spawnFn: bad, rmFn }), { code: "ENOEXEC" });
  assert.equal(removed.filter((file) => path.basename(file).startsWith("toolgate-settings")).length, 2, "one settings file per path");
  const agents = path.join(dir, ".opencode", "agents");
  const subagents = [{ name: "scout", description: "d", prompt: "p" }];
  await assert.rejects(opencode.launch({ ...io, prompt: "hello", subagents, spawnFn: bad }), { code: "ENOEXEC" });
  assert.deepEqual(fs.existsSync(agents) ? fs.readdirSync(agents) : [], [], "the subagent files are removed");
});

// libuv runs an executable without a shebang with /bin/sh on Linux, where there is nothing to reject; macOS answers ENOEXEC.
test("a real file that is executable but not a program rejects the launch and leaves no settings file", { timeout: 10_000, skip: process.platform === "darwin" ? false : "only macOS refuses an executable that is not a program (Linux runs it with /bin/sh)" }, async () => {
  const { dir, io } = base();
  const junk = path.join(dir, "junk-agent");
  fs.writeFileSync(junk, Buffer.from([0, 1, 2, 3, 4, 5]), { mode: 0o755 });
  await assert.rejects(claude.launch({ ...io, prompt: "hello", claudeBin: junk }));
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("toolgate-settings")), []);
});

test("toolgate with an agent that is not installed says why on one line and exits 1, without a stack", { timeout: 20_000 }, () => {
  const { dir } = base();
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "toolgate.js");
  const out = spawnSync(process.execPath, [bin, "--no-route", "claude", "hello"], { cwd: dir, encoding: "utf8", env: { PATH: "", HOME: dir, XDG_STATE_HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, QMD_SHARED_PORT: "18999" } });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /^toolgate: spawn claude ENOENT$/m);
  assert.doesNotMatch(out.stderr, /\n\s+at /);
});

test("a cleanup that throws does not hide why the agent did not start: claude on both paths, opencode", { timeout: 10_000 }, async () => {
  const { dir, io } = base();
  const rmFn = () => { throw new Error("cleanup failed"); };
  const bad = () => { throw Object.assign(new Error("spawn ENOEXEC"), { code: "ENOEXEC" }); };
  await assert.rejects(claude.launch(["hello"], { ...io, spawnFn: bad, rmFn, resume: false }), { code: "ENOEXEC" });
  await assert.rejects(claude.launch({ ...io, prompt: "hello", spawnFn: bad, rmFn }), { code: "ENOEXEC" });
  // and the same when the agent is not there: the `error` event runs the cleanup
  await assert.rejects(claude.launch(["hello"], { ...io, claudeBin: MISSING, rmFn, resume: false }), { code: "ENOENT" });
  await assert.rejects(claude.launch({ ...io, prompt: "hello", claudeBin: MISSING, rmFn }), { code: "ENOENT" });
  const subagents = [{ name: "scout", description: "d", prompt: "p" }];
  fs.mkdirSync(path.join(dir, ".opencode", "agents"), { recursive: true });
  await assert.rejects(opencode.launch({ ...io, prompt: "hello", subagents, spawnFn: bad, writeFileFn: fs.writeFileSync, tmpDir: dir }), { code: "ENOEXEC" });
});

test("failureText: a system error is its reason on one line, escaped and cut; any other error keeps its stack", () => {
  const system = failureText(Object.assign(new Error(`spawn x\u001b[31m\u202e ENOENT${"y".repeat(100000)}`), { code: "ENOENT" }));
  assert.match(system, /^toolgate: spawn x\\u001b\[31m\\u202e ENOENT/);
  assert.equal(system.split("\n").length, 2, "one line");
  assert.ok(system.length < 600);
  const bug = failureText(new TypeError("Cannot read properties of undefined (reading 'on')"));
  assert.match(bug, /TypeError: Cannot read properties[\s\S]*\n\s+at /);
  const hostile = new TypeError("bug\u001b[31m\u202e");
  hostile.stack = `TypeError: bug\u001b[31m\u202e\n    at here\u001b[0m (file.js:1:1)`;
  const text = failureText(hostile);
  assert.ok(!text.includes("\u001b") && !text.includes("\u202e"), "escaped in a stack too");
  assert.ok(text.split("\n").length >= 3, "the stack keeps its lines");
  assert.match(failureText("plain text"), /^toolgate: plain text\n$/);
  assert.match(failureText(Object.assign(new Error("odd"), { code: "not-a-system-code" })), /\n\s+at /, "only E* codes count as system errors");
});

test("opencode: a subagent file that cannot be removed does not hide why the agent did not start", { timeout: 10_000, skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs a folder that its owner cannot write to" : false }, async () => {
  const { dir, io } = base();
  const agents = path.join(dir, ".opencode", "agents");
  const subagents = [{ name: "scout", description: "d", prompt: "p" }];
  // the files are written before the spawn; the folder is closed to writing, so removing them fails, and then the spawn throws
  const spawnFn = () => {
    fs.chmodSync(agents, 0o500);
    throw Object.assign(new Error("spawn ENOEXEC"), { code: "ENOEXEC" });
  };
  try {
    await assert.rejects(opencode.launch({ ...io, prompt: "hello", subagents, spawnFn }), { code: "ENOEXEC" });
  } finally {
    fs.chmodSync(agents, 0o700);
  }
});
