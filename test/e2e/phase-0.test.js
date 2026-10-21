import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";
import { run } from "../../packages/toolgate/src/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_BIN = path.join(__dirname, "..", "..", "packages", "toolgate-proxy", "bin", "toolgate-proxy.js");
const FAKE_UPSTREAM = path.join(__dirname, "..", "..", "packages", "toolgate-proxy", "fixtures", "fake-upstream.js");

function startProxy(envOverrides = {}) {
  const child = spawn(process.execPath, [PROXY_BIN], {
    env: {
      ...process.env,
      TOOLGATE_UPSTREAM_CMD: process.execPath,
      TOOLGATE_UPSTREAM_ARGS: JSON.stringify([FAKE_UPSTREAM]),
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines = [];
  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const parts = stdoutBuffer.split("\n");
    stdoutBuffer = parts.pop();
    stdoutLines.push(...parts);
  });

  let stderrData = "";
  child.stderr.on("data", (chunk) => {
    stderrData += chunk.toString("utf8");
  });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    stdoutLines,
    getStderr: () => stderrData,
    exited,
  };
}

function waitFor(fn, { timeout = 5000, interval = 20 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("waitFor timed out"));
      setTimeout(tick, interval);
    };
    tick();
  });
}

const ALL_REVIEW_TOOLS = ["listPRs", "getPR", "getPRComments"];
const ALL_TOOLS = ["listPRs", "getPR", "getPRComments", "comment", "approve", "createPR", "mergePullRequest"];

const TEMP_ROOT = path.join(os.tmpdir(), "toolgate-e2e", String(process.pid));
const CONFIG_PATH = path.join(TEMP_ROOT, ".toolgate", "config.json");
const STATE_PATH = path.join(TEMP_ROOT, ".toolgate", "state.json");

function makeLauncherDeps() {
  const stdoutChunks = [];
  const stderrChunks = [];
  return {
    cwd: TEMP_ROOT,
    stdout: { write: (s) => stdoutChunks.push(s) },
    stderr: { write: (s) => stderrChunks.push(s) },
    stdoutChunks,
    stderrChunks,
  };
}

// helper: convenience wrapper around `run()` for testing escalation + state lifecycle.
async function escalateTool(server, tool) {
  const deps = makeLauncherDeps();
  const code = await run(["escalate", server, tool], deps);
  assert.equal(code, 0, `escalate ${server}:${tool} must return 0`);
  return code;
}

function parseToolsFromResponse(line) {
  const msg = JSON.parse(line);
  return msg.result.tools.map((t) => t.name);
}

test("Phase 0 — baseline filtering: N=7 → M=3, mergePullRequest absent", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: ALL_REVIEW_TOOLS.join(",") });
  proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  await waitFor(() => proxy.stdoutLines.length >= 2);

  const initResp = JSON.parse(proxy.stdoutLines[0]);
  assert.equal(initResp.id, 1);
  assert.equal(initResp.result.serverInfo.name, "fake-upstream");

  const tools = parseToolsFromResponse(proxy.stdoutLines[1]);
  assert.equal(tools.length, 3, `expected M=3 tools, got ${tools.length}`);
  assert.deepEqual(
    [...tools].sort(),
    [...ALL_REVIEW_TOOLS].sort(),
    "filtered tools must match the review subset exactly"
  );
  assert.ok(!tools.includes("mergePullRequest"), "mergePullRequest must be absent at baseline");

  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("Phase 0 — fail-open: no allow-list passes all 7 tools unfiltered", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "" });
  proxy.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await waitFor(() => proxy.stdoutLines.length >= 1);

  const tools = parseToolsFromResponse(proxy.stdoutLines[0]);
  assert.equal(tools.length, 7, `expected all 7 tools unfiltered, got ${tools.length}`);
  assert.deepEqual([...tools].sort(), [...ALL_TOOLS].sort(), "fail-open must pass all tools through");

  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("Phase 0 — escalate tool: after escalation + restart, mergePullRequest is present and state resets", async (t) => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      baseline: ["repo"],
      toolBaselines: { repo: [...ALL_REVIEW_TOOLS] },
    })
  );

  // --- Act 1: escalate mergePullRequest ---
  await escalateTool("repo", "mergePullRequest");

  const stateAfterEscalate = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  assert.deepEqual(stateAfterEscalate.toolExtras.repo, ["mergePullRequest"]);
  assert.equal(stateAfterEscalate.pendingRestart, true);

  // --- Act 2: simulate the "restart" — the launcher would compute the new allow-list
  // including the escalated tool. We replicate that here by spawning the proxy
  // with TOOLGATE_ALLOWED_TOOLS = baseline + escalated tool ---
  const proxyAfterEscalate = startProxy({
    TOOLGATE_ALLOWED_TOOLS: [...ALL_REVIEW_TOOLS, "mergePullRequest"].join(","),
  });
  proxyAfterEscalate.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  proxyAfterEscalate.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  await waitFor(() => proxyAfterEscalate.stdoutLines.length >= 2);

  const tools = parseToolsFromResponse(proxyAfterEscalate.stdoutLines[1]);
  assert.ok(
    tools.includes("mergePullRequest"),
    "after escalation, mergePullRequest must be present in tools/list"
  );
  assert.equal(tools.length, 4, `expected M+1=4 tools after escalation, got ${tools.length}`);

  proxyAfterEscalate.child.kill("SIGTERM");
  await proxyAfterEscalate.exited;

  // --- Act 3: verify that a "launch" (without claude) consumed the escalation ---
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({
      extras: [],
      toolExtras: { repo: ["mergePullRequest"] },
      pendingRestart: true,
    })
  );

  const deps = makeLauncherDeps();
  deps.adapters = { "claude-code": () => Promise.resolve({ launch: async () => ({ code: 0 }) }) };
  deps.env = { TOOLGATE_ADAPTER: "claude-code" };
  const code = await run(["verify restarted"], deps);
  assert.equal(code, 0);

  const stateAfterLaunch = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  assert.deepEqual(
    stateAfterLaunch,
    { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] },
    "pendingRestart must be consumed after the escalations are applied"
  );

  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

test("Phase 0 — combined assertions: all in one run proves N→M drop, escalate+restart recovery, and fail-open safety", async () => {
  // --- (a) N=7 → M=3 baseline, mergePullRequest absent ---
  const proxyA = startProxy({ TOOLGATE_ALLOWED_TOOLS: ALL_REVIEW_TOOLS.join(",") });
  proxyA.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  proxyA.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await waitFor(() => proxyA.stdoutLines.length >= 2);

  const initA = JSON.parse(proxyA.stdoutLines[0]);
  assert.equal(initA.result.serverInfo.name, "fake-upstream");

  const toolsA = parseToolsFromResponse(proxyA.stdoutLines[1]);
  assert.equal(toolsA.length, 3);
  assert.deepEqual([...toolsA].sort(), [...ALL_REVIEW_TOOLS].sort());
  assert.ok(!toolsA.includes("mergePullRequest"), "mergePullRequest absent at baseline");

  proxyA.child.kill("SIGTERM");
  await proxyA.exited;

  // --- (b) escalate mergePullRequest + restart recovery ---
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      baseline: ["repo"],
      toolBaselines: { repo: [...ALL_REVIEW_TOOLS] },
    })
  );

  await escalateTool("repo", "mergePullRequest");

  const escalatedTools = [...ALL_REVIEW_TOOLS, "mergePullRequest"];
  const proxyB = startProxy({ TOOLGATE_ALLOWED_TOOLS: escalatedTools.join(",") });
  proxyB.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  proxyB.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await waitFor(() => proxyB.stdoutLines.length >= 2);

  const toolsB = parseToolsFromResponse(proxyB.stdoutLines[1]);
  assert.ok(toolsB.includes("mergePullRequest"), "mergePullRequest must be present after escalation");
  assert.equal(toolsB.length, 4);

  proxyB.child.kill("SIGTERM");
  await proxyB.exited;

  // Consume escalation via launch simulation
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({
      extras: [],
      toolExtras: { repo: ["mergePullRequest"] },
      pendingRestart: true,
    })
  );

  const deps = makeLauncherDeps();
  deps.adapters = { "claude-code": () => Promise.resolve({ launch: async () => ({ code: 0 }) }) };
  deps.env = { TOOLGATE_ADAPTER: "claude-code" };
  const launchCode = await run(["post-escalate prompt"], deps);
  assert.equal(launchCode, 0);

  const finalState = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  assert.deepEqual(
    finalState,
    { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] },
    "pendingRestart consumed"
  );

  // --- (c) fail-open: all 7 tools pass through ---
  const proxyC = startProxy({ TOOLGATE_ALLOWED_TOOLS: "" });
  proxyC.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await waitFor(() => proxyC.stdoutLines.length >= 1);

  const toolsC = parseToolsFromResponse(proxyC.stdoutLines[0]);
  assert.equal(toolsC.length, 7);
  assert.deepEqual([...toolsC].sort(), [...ALL_TOOLS].sort());

  proxyC.child.kill("SIGTERM");
  await proxyC.exited;

  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
