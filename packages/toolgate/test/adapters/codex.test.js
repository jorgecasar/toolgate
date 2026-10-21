import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readServers,
  installedServers,
  buildToolEnv,
  toEnvVarName,
  serverOverrides,
  applyServers,
  launch,
} from "../../src/adapters/codex.js";

test("readServers returns server names from a TOML config", () => {
  const readFileFn = () => `
[mcp_servers.repo]
command = "node"

[mcp_servers.docs]
command = "npx"
`;
  assert.deepEqual(readServers("config.toml", { readFileFn }), ["repo", "docs"]);
});

test("readServers gives a quoted key without its quotes", () => {
  assert.deepEqual(readServers("c", { readFileFn: () => '[mcp_servers."my.srv"]\n[mcp_servers.\'b\']\n' }), ["my.srv", "b"]);
});

test("readServers sees a header with a comment, CRLF, spaces or a BOM, and not a sub-table", () => {
  const toml = "\uFEFF[mcp_servers.a] # note\r\ncommand = \"x\"\r\n  [ mcp_servers . b ]\n[mcp_servers.a.env]\nK = \"v\"\n[mcp_servers.\"c.d\".env]\n[mcp_servers.\"c.d\"]\n[mcp_servers.repo.http_headers]\n[[mcp_servers.z]]\n[mcp_servers.e]# x\n";
  assert.deepEqual(readServers("c", { readFileFn: () => toml }), ["a", "b", "c.d", "e"]);
});

test("a server whose header has a comment is turned off, and a sub-table raises no note", async () => {
  const { call, errors } = await run({ prompt: "go", env: {}, config: { baseline: [] }, readFileFn: () => "[mcp_servers.x] # note\r\n[mcp_servers.x.env]\r\n" });
  assert.deepEqual(call.args, ["-c", "mcp_servers.x.enabled=false", "go"]);
  assert.deepEqual(errors, []);
});

test("readServers ignores non-mcp sections", () => {
  const readFileFn = () => `
[model]
name = "gpt-5"

[mcp_servers.repo]
command = "node"
`;
  assert.deepEqual(readServers("config.toml", { readFileFn }), ["repo"]);
});

test("readServers returns an empty list when config is missing", () => {
  const readFileFn = () => {
    throw new Error("ENOENT");
  };
  assert.deepEqual(readServers("config.toml", { readFileFn }), []);
});

test("readServers returns an empty list when config is malformed", () => {
  const readFileFn = () => "not {{{ toml";
  assert.deepEqual(readServers("config.toml", { readFileFn }), []);
});

test("toEnvVarName uppercases and sanitizes the server name", () => {
  assert.equal(toEnvVarName("repo-server"), "TOOLGATE_REPO_SERVER_TOOLS");
});

test("buildToolEnv exports a CSV env var only for active servers with a tool baseline", () => {
  const config = { toolBaselines: { repo: ["listPRs", "getPR"] } };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };
  const env = buildToolEnv(config, state, new Set(["repo", "docs"]));
  assert.deepEqual(env, { TOOLGATE_REPO_TOOLS: "listPRs,getPR" });
});

test("buildToolEnv includes escalated tools once pendingRestart is set", () => {
  const config = { toolBaselines: { repo: ["listPRs"] } };
  const state = { extras: [], toolExtras: { repo: ["mergePullRequest"] }, pendingRestart: true };
  const env = buildToolEnv(config, state, new Set(["repo"]));
  assert.deepEqual(env, { TOOLGATE_REPO_TOOLS: "listPRs,mergePullRequest" });
});

test("buildToolEnv skips servers that are not active", () => {
  const config = { toolBaselines: { repo: ["listPRs"] } };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };
  const env = buildToolEnv(config, state, new Set(["docs"]));
  assert.deepEqual(env, {});
});

function fakeChild() {
  return new EventEmitter();
}

const idle = { extras: [], toolExtras: {}, pendingRestart: false };
const CONFIG = `
[mcp_servers.alpha]
command = "a"

[mcp_servers.beta]
command = "b"

[mcp_servers."my.srv"]
command = "m"
`;

async function run(options = {}) {
  const calls = [];
  const errors = [];
  const spawnFn = (cmd, args, opts) => {
    const child = fakeChild();
    calls.push({ cmd, args, opts });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const result = await launch({ spawnFn, readFileFn: () => CONFIG, state: idle, stderr: { write: (s) => errors.push(s) }, ...options });
  return { call: calls[0], errors, result };
}

test("launch turns off the defined servers that are not active, narrows the active ones, and runs on the user's own home", async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("toolgate-codex-"));
  const env = { PATH: "/bin", CODEX_HOME: "/own/codex" };
  const { call, errors, result } = await run({
    prompt: "go",
    env,
    config: { baseline: ["alpha"], toolBaselines: { alpha: ["x", 'q"t'] } },
  });
  assert.deepEqual(call.args, [
    "-c", 'mcp_servers.alpha.enabled_tools=["x", "q\\"t"]',
    "-c", "mcp_servers.beta.enabled=false",
    "go",
  ]);
  assert.equal(call.opts.env.CODEX_HOME, "/own/codex", "the user's own home, unchanged");
  assert.equal(call.opts.env.TOOLGATE_ALPHA_TOOLS, 'x,q"t');
  assert.deepEqual(errors, [
    "toolgate: Codex cannot be told about my.srv from the command line (its name has characters other than letters, digits, - and _); it runs as configured\n",
  ]);
  assert.deepEqual(Object.keys(result), ["code", "signal"]);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("toolgate-codex-")), before, "no folder in TMPDIR");
});

test("launch leaves CODEX_HOME alone when it is not set, and reads ~/.codex then", async () => {
  const read = [];
  const { call } = await run({ prompt: "go", env: { PATH: "/bin" }, config: { baseline: [] }, readFileFn: (file) => (read.push(file), "") });
  assert.equal("CODEX_HOME" in call.opts.env, false);
  assert.deepEqual(read, [path.join(os.homedir(), ".codex", "config.toml")]);
  const own = [];
  await run({ prompt: "go", env: { CODEX_HOME: "/own/codex" }, config: { baseline: [] }, readFileFn: (file) => (own.push(file), "") });
  assert.deepEqual(own, ["/own/codex/config.toml"]);
});

test("an active server the config does not define, and a name with a dot, get no -c", async () => {
  const { call } = await run({ prompt: "go", env: {}, config: { baseline: ["alpha", "ghost", "my.srv"], toolBaselines: { ghost: ["t"], "my.srv": ["t"] } } });
  assert.deepEqual(call.args, ["-c", "mcp_servers.beta.enabled=false", "go"]);
});

test("the overrides come after exec, before the rule arguments and the user's, which win; the prompt is last", async () => {
  const config = { baseline: ["alpha"], client: { injectRule: true } };
  const { call } = await run({ prompt: "go", headless: true, env: {}, config, agentArgs: ["-c", "mcp_servers.beta.enabled=true", "--model", "m"], projectDir: os.tmpdir() });
  const at = (needle) => call.args.indexOf(needle);
  assert.equal(call.args[0], "exec");
  assert.equal(call.args[1], "-c");
  assert.equal(call.args[2], "mcp_servers.beta.enabled=false");
  assert.ok(call.args[4].startsWith("developer_instructions="), "the rule arguments right after");
  assert.ok(at("mcp_servers.beta.enabled=false") < at("mcp_servers.beta.enabled=true"), "theirs is later");
  assert.deepEqual(call.args.slice(-3), ["--model", "m", "go"]);
});

test("a name is printed through printable, and one note per name", async () => {
  const { errors } = await run({ prompt: "go", env: {}, config: { baseline: [] }, readFileFn: () => '[mcp_servers."a\u001b[31m.b"]\n[mcp_servers.x_y]\n[mcp_servers.x_y]\n' });
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /\u001b/);
  assert.match(errors[0], /about "?a\\u001b\[31m\.b"? from/, "written out, not sent raw");
});

test("serverOverrides and applyServers return the same arguments; an undefined or unreadable config gives nothing", () => {
  const toolEnv = { TOOLGATE_ALPHA_TOOLS: "x" };
  const out = serverOverrides(["beta", "alpha", "alpha"], new Set(["alpha"]), toolEnv);
  assert.deepEqual(out.args, ["-c", 'mcp_servers.alpha.enabled_tools=["x"]', "-c", "mcp_servers.beta.enabled=false"]);
  assert.deepEqual(applyServers(new Set(["alpha"]), toolEnv, ["beta", "alpha"]), out.args);
  assert.deepEqual(serverOverrides([], new Set(["alpha"]), toolEnv), { args: [], notes: [] });
});

test("launch propagates a non-zero exit code from codex", async () => {
  const readFileFn = () => "";
  const child = fakeChild();
  const spawnFn = () => {
    queueMicrotask(() => child.emit("exit", 3, null));
    return child;
  };
  const result = await launch({
    prompt: "hi",
    config: { baseline: [] },
    state: { extras: [], toolExtras: {}, pendingRestart: false },
    readFileFn,
    spawnFn,
  });
  assert.equal(result.code, 3);
});

test("launch omits the prompt argument when none is given", async () => {
  const readFileFn = () => "";
  const child = fakeChild();
  const spawnCalls = [];
  const spawnFn = (cmd, args) => {
    spawnCalls.push(args);
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  await launch({
    config: { baseline: [] },
    state: { extras: [], toolExtras: {}, pendingRestart: false },
    readFileFn,
    spawnFn,
  });
  assert.deepEqual(spawnCalls[0], []);
});

test("installedServers reads the Codex config and is null when it is absent", () => {
  const readFileFn = (file) => {
    if (file === "/h/.codex/config.toml") return "[mcp_servers.repo]\ncommand = \"x\"\n";
    if (file === "/p/.codex/config.toml") return "[mcp_servers.local]\ncommand = \"y\"\n";
    throw new Error("ENOENT");
  };
  const found = installedServers({ cwd: "/p", homedir: "/h", readFileFn });
  assert.deepEqual(found, { servers: ["repo", "local"], source: "/h/.codex/config.toml, /p/.codex/config.toml" });
  assert.equal(
    installedServers({
      homedir: "/h",
      readFileFn: () => {
        throw new Error("ENOENT");
      },
    }),
    null
  );
});
