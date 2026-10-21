import { test } from "node:test";
import assert from "node:assert/strict";
import { readServers, buildToolEnv, toEnvVarName, computeProxyEnv } from "../../src/adapters/karajan.js";

test("readServers returns server names from .mcp.json", () => {
  const readFileFn = () => JSON.stringify({ mcpServers: { repo: {}, docs: {} } });
  assert.deepEqual(readServers(".mcp.json", { readFileFn }), ["repo", "docs"]);
});

test("readServers returns an empty list when .mcp.json is missing", () => {
  const readFileFn = () => {
    throw new Error("ENOENT");
  };
  assert.deepEqual(readServers(".mcp.json", { readFileFn }), []);
});

test("readServers returns an empty list when .mcp.json is malformed", () => {
  const readFileFn = () => "not json";
  assert.deepEqual(readServers(".mcp.json", { readFileFn }), []);
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

test("computeProxyEnv returns active servers and tool env for a role", () => {
  const config = {
    baseline: ["docs"],
    keywords: { repo: ["pull request", "pr"] },
    toolBaselines: { repo: ["listPRs", "getPR"] },
  };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };

  const result = computeProxyEnv({ role: "handle pull request review", config, state });
  assert.ok(result.activeServers.includes("docs"));
  assert.ok(result.activeServers.includes("repo"));
  assert.equal(result.toolEnv.TOOLGATE_REPO_TOOLS, "listPRs,getPR");
  assert.equal(result.proxyEnv.TOOLGATE_REPO_TOOLS, "listPRs,getPR");
});

test("computeProxyEnv returns only baseline servers for an unrelated role", () => {
  const config = {
    baseline: ["docs"],
    keywords: { repo: ["pull request"] },
    toolBaselines: { repo: ["listPRs"] },
  };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };

  const result = computeProxyEnv({ role: "write unit tests", config, state });
  assert.deepEqual(result.activeServers, ["docs"]);
  assert.deepEqual(result.toolEnv, {});
});

test("computeProxyEnv includes escalated servers when pendingRestart is set", () => {
  const config = { baseline: ["docs"], toolBaselines: {} };
  const state = { extras: ["repo"], toolExtras: {}, pendingRestart: true };

  const result = computeProxyEnv({ role: "any task", config, state });
  assert.ok(result.activeServers.includes("docs"));
  assert.ok(result.activeServers.includes("repo"));
});
