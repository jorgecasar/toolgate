import { test } from "node:test";
import assert from "node:assert/strict";
import { computeActiveServers, computeActiveTools } from "../src/activeSet.js";

const baseConfig = {
  baseline: ["docs"],
  keywords: {
    repo: ["pull request", "\\bPR\\b", "branch", "merge"],
    tasks: ["\\bticket\\b", "sprint", "backlog"],
  },
  toolBaselines: {
    repo: ["listPRs", "getPR", "getPRComments", "comment", "approve", "createPR"],
  },
};

const idleState = { extras: [], toolExtras: {}, pendingRestart: false };

test("baseline servers are always active", () => {
  const active = computeActiveServers(baseConfig, idleState, "hello world");
  assert.deepEqual([...active], ["docs"]);
});

test("self-match: a server name appearing as a word in the prompt activates it", () => {
  const active = computeActiveServers(baseConfig, idleState, "please check the repo for issues");
  assert.ok(active.has("repo"));
});

test("self-match requires a whole word, not a substring", () => {
  const active = computeActiveServers(baseConfig, idleState, "reporting on things");
  assert.ok(!active.has("repo"));
});

test("keyword patterns activate their server", () => {
  const active = computeActiveServers(baseConfig, idleState, "please review this pull request");
  assert.ok(active.has("repo"));
});

test("keyword patterns are case-insensitive and support regex word boundaries", () => {
  const active = computeActiveServers(baseConfig, idleState, "is this PR ready?");
  assert.ok(active.has("repo"));
});

test("unrelated prompts do not activate keyword-matched servers", () => {
  const active = computeActiveServers(baseConfig, idleState, "what is the weather today");
  assert.deepEqual([...active], ["docs"]);
});

test("extras are ignored unless pendingRestart is set", () => {
  const state = { extras: ["karajan"], toolExtras: {}, pendingRestart: false };
  const active = computeActiveServers(baseConfig, state, "hello world");
  assert.ok(!active.has("karajan"));
});

test("extras are applied when pendingRestart is set", () => {
  const state = { extras: ["karajan"], toolExtras: {}, pendingRestart: true };
  const active = computeActiveServers(baseConfig, state, "hello world");
  assert.ok(active.has("karajan"));
});

test("tool baseline for a server", () => {
  const tools = computeActiveTools(baseConfig, idleState, "repo");
  assert.deepEqual(
    [...tools].sort(),
    ["approve", "comment", "createPR", "getPR", "getPRComments", "listPRs"].sort()
  );
});

test("escalated tools are ignored unless pendingRestart is set", () => {
  const state = { extras: [], toolExtras: { repo: ["mergePullRequest"] }, pendingRestart: false };
  const tools = computeActiveTools(baseConfig, state, "repo");
  assert.ok(!tools.has("mergePullRequest"));
});

test("escalated tools are applied when pendingRestart is set", () => {
  const state = { extras: [], toolExtras: { repo: ["mergePullRequest"] }, pendingRestart: true };
  const tools = computeActiveTools(baseConfig, state, "repo");
  assert.ok(tools.has("mergePullRequest"));
});

test("a server with no configured tool baseline yields an empty set", () => {
  const tools = computeActiveTools(baseConfig, idleState, "docs");
  assert.equal(tools.size, 0);
});
