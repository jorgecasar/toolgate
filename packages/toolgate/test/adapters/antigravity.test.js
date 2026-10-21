import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  readServers,
  installedServers,
  buildToolEnv,
  toEnvVarName,
  buildConfigJson,
  launch,
} from "../../src/adapters/antigravity.js";

test("readServers returns server names from mcp_config.json", () => {
  const readFileFn = () => JSON.stringify({ mcpServers: { repo: {}, docs: {} } });
  assert.deepEqual(readServers("mcp_config.json", { readFileFn }), ["repo", "docs"]);
});

test("readServers returns an empty list when config is missing", () => {
  const readFileFn = () => {
    throw new Error("ENOENT");
  };
  assert.deepEqual(readServers("mcp_config.json", { readFileFn }), []);
});

test("readServers returns an empty list when config is malformed", () => {
  const readFileFn = () => "not json";
  assert.deepEqual(readServers("mcp_config.json", { readFileFn }), []);
});

test("toEnvVarName uppercases and sanitizes the server name", () => {
  assert.equal(toEnvVarName("my-server"), "TOOLGATE_MY_SERVER_TOOLS");
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

test("buildConfigJson generates JSON with mcpServers for active servers", () => {
  const toolEnv = { TOOLGATE_REPO_TOOLS: "listPRs,getPR" };
  const json = buildConfigJson(["repo", "docs"], toolEnv);
  const parsed = JSON.parse(json);
  assert.ok(parsed.mcpServers.repo);
  assert.ok(parsed.mcpServers.docs);
  assert.deepEqual(parsed.mcpServers.repo.env, { TOOLGATE_REPO_TOOLS: "listPRs,getPR" });
});

test("buildConfigJson lists servers in UTF-16 code unit order, whatever the input order or locale", () => {
  const servers = ["repo", "Zeta", "docs", "alpha"];
  const keys = Object.keys(JSON.parse(buildConfigJson(servers, {})).mcpServers);
  assert.deepEqual(keys, ["Zeta", "alpha", "docs", "repo"]);
  assert.deepEqual(keys, [...servers].sort());
});

test("buildConfigJson omits env when no tool env var exists", () => {
  const json = buildConfigJson(["repo"], {});
  const parsed = JSON.parse(json);
  assert.ok(parsed.mcpServers.repo);
  assert.equal(parsed.mcpServers.repo.env, undefined);
});

function fakeChild() {
  return new EventEmitter();
}

test("launch writes a temp mcp_config.json, sets tool env vars, and spawns antigravity", async () => {
  const writes = {};
  const writeFileFn = (filePath, contents) => {
    writes[filePath] = contents;
  };
  const spawnCalls = [];
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };

  const readFileFn = () =>
    JSON.stringify({
      mcpServers: { docs: {}, repo: {}, tasks: {} },
    });

  const config = {
    baseline: ["docs"],
    keywords: { repo: ["pull request"] },
    toolBaselines: { repo: ["listPRs", "getPR"] },
  };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };

  const result = await launch({
    prompt: "review this pull request",
    config,
    state,
    readFileFn,
    writeFileFn,
    spawnFn,
    tmpDir: "/tmp",
    pid: 123,
    now: 456,
  });

  const configFile = Object.keys(writes).find((k) => k.endsWith("mcp_config.json"));
  assert.ok(configFile, "temp mcp_config.json was written");
  const parsed = JSON.parse(writes[configFile]);
  assert.ok(parsed.mcpServers.docs);
  assert.ok(parsed.mcpServers.repo);
  assert.equal(parsed.mcpServers.tasks, undefined);
  assert.deepEqual(parsed.mcpServers.repo.env, { TOOLGATE_REPO_TOOLS: "listPRs,getPR" });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, "agy");
  assert.equal(spawnCalls[0].opts.env.TOOLGATE_REPO_TOOLS, "listPRs,getPR");
  assert.ok(spawnCalls[0].opts.env.ANTIGRAVITY_HOME);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
});

test("launch propagates a non-zero exit code from antigravity", async () => {
  const readFileFn = () => JSON.stringify({ mcpServers: {} });
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
    writeFileFn: () => {},
    spawnFn,
    tmpDir: "/tmp",
    pid: 1,
    now: 1,
  });
  assert.equal(result.code, 3);
});

test("launch omits the prompt argument when none is given", async () => {
  const readFileFn = () => JSON.stringify({ mcpServers: {} });
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
    writeFileFn: () => {},
    spawnFn,
    tmpDir: "/tmp",
    pid: 1,
    now: 1,
  });
  assert.deepEqual(spawnCalls[0], []);
});

test("installedServers reads the Antigravity MCP config and is null when it is absent", () => {
  const found = installedServers({ homedir: "/h", readFileFn: () => JSON.stringify({ mcpServers: { repo: {} } }) });
  assert.deepEqual(found, { servers: ["repo"], source: "/h/.gemini/config/mcp_config.json" });
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

test("installedServers is null when the Antigravity config is malformed", () => {
  assert.equal(installedServers({ homedir: "/h", readFileFn: () => "{ truncated" }), null);
});
