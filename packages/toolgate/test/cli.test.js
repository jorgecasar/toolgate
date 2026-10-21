import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function makeDeps(overrides = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  return {
    cwd: "/project",
    stdout: { write: (s) => stdoutChunks.push(s) },
    stderr: { write: (s) => stderrChunks.push(s) },
    stdoutChunks,
    stderrChunks,
    env: { TOOLGATE_ADAPTER: "claude-code" },
    ...overrides,
  };
}

function makeMockAdapter() {
  const launches = [];
  const adapter = {
    launch: ({ prompt, config, state, mcpJsonPath }) => {
      launches.push({ prompt, config, state, mcpJsonPath });
      return Promise.resolve({ code: 0 });
    },
  };
  adapter.launches = launches;
  return adapter;
}

test("default command loads config/state and launches with the prompt", async () => {
  const adapter = makeMockAdapter();
  const deps = makeDeps({
    loadConfigFn: () => ({ baseline: ["docs"] }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {
      throw new Error("should not save state when nothing was pending");
    },
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  const code = await run(["do the thing"], deps);

  assert.equal(code, 0);
  assert.equal(adapter.launches[0].prompt, "do the thing");
  assert.deepEqual(adapter.launches[0].config, { baseline: ["docs"] });
  assert.equal(adapter.launches[0].mcpJsonPath, "/project/.mcp.json");
});

test("propagates the launched exit code", async () => {
  const adapter = { launch: () => Promise.resolve({ code: 5 }) };
  const deps = makeDeps({
    loadConfigFn: () => ({ baseline: [] }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {},
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  const code = await run(["hi"], deps);
  assert.equal(code, 5);
});

test("resets pendingRestart after a launch that consumed the escalation", async () => {
  const saved = [];
  const adapter = { launch: () => Promise.resolve({ code: 0 }) };
  const deps = makeDeps({
    loadConfigFn: () => ({ baseline: [] }),
    loadStateFn: () => ({ extras: ["karajan"], toolExtras: {}, pendingRestart: true }),
    saveStateFn: (path, state) => saved.push({ path, state }),
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  await run(["hi"], deps);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path, "/project/.toolgate/state.json");
  assert.deepEqual(saved[0].state, { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] });
});

test("escalate <server> adds the server to extras and marks pendingRestart", async () => {
  const saved = [];
  const deps = makeDeps({
    cwd: "/project",
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: (path, state) => saved.push({ path, state }),
  });
  const { run } = await import("../src/cli.js");
  const code = await run(["escalate", "karajan"], deps);
  assert.equal(code, 0);
  assert.deepEqual(saved[0].state, { extras: ["karajan"], toolExtras: {}, pendingRestart: true });
});

test("escalate <server> <tool> adds the tool to toolExtras for that server", async () => {
  const saved = [];
  const deps = makeDeps({
    cwd: "/project",
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: (path, state) => saved.push({ path, state }),
  });
  const { run } = await import("../src/cli.js");
  const code = await run(["escalate", "repo", "mergePullRequest"], deps);
  assert.equal(code, 0);
  assert.deepEqual(saved[0].state, {
    extras: [],
    toolExtras: { repo: ["mergePullRequest"] },
    pendingRestart: true,
  });
});

test("escalate deduplicates repeated servers/tools", async () => {
  const saved = [];
  const deps = makeDeps({
    cwd: "/project",
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    loadStateFn: () => ({
      extras: ["karajan"],
      toolExtras: { repo: ["mergePullRequest"] },
      pendingRestart: true,
    }),
    saveStateFn: (path, state) => saved.push({ path, state }),
  });
  const { run } = await import("../src/cli.js");
  await run(["escalate", "karajan"], deps);
  await run(["escalate", "repo", "mergePullRequest"], deps);
  assert.deepEqual(saved[0].state.extras, ["karajan"]);
  assert.deepEqual(saved[1].state.toolExtras.repo, ["mergePullRequest"]);
});

test("escalate without a server name fails with a usage error", async () => {
  const deps = makeDeps();
  const { run } = await import("../src/cli.js");
  const code = await run(["escalate"], deps);
  assert.equal(code, 1);
  assert.match(deps.stderrChunks.join(""), /server name/);
});

test("launch routes the prompt: routed servers join the active set and skills are appended", async () => {
  const adapter = makeMockAdapter();
  const deps = makeDeps({
    loadConfigFn: () => ({
      baseline: ["docs"],
      keywords: { repo: ["pull request"] },
      router: {
        backend: "regex",
        bindings: [
          {
            pattern: "pull request",
            skill: "review-pr",
            path: ".toolgate/commands/review-pr.md",
            servers: ["repo"],
          },
        ],
      },
    }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {
      throw new Error("routing must not persist state");
    },
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  await run(["review this pull request"], deps);

  const launched = adapter.launches[0];
  assert.deepEqual(launched.state.extras, ["repo"]);
  assert.equal(launched.state.pendingRestart, true);
  assert.match(launched.prompt, /^review this pull request\n\n\[toolgate\] .*review-pr\.md$/);
});

test("launch with --no-route skips routing", async () => {
  const adapter = makeMockAdapter();
  const deps = makeDeps({
    loadConfigFn: () => ({
      router: { bindings: [{ pattern: ".", skill: "x", servers: ["repo"] }] },
    }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {},
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  await run(["--no-route", "hello"], deps);

  assert.equal(adapter.launches[0].prompt, "hello");
  assert.deepEqual(adapter.launches[0].state.extras, []);
});

test("launch continues and warns when routing fails", async () => {
  const adapter = makeMockAdapter();
  const deps = makeDeps({
    loadConfigFn: () => ({ router: { backend: "nonexistent" } }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {},
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  const code = await run(["hello"], deps);

  assert.equal(code, 0);
  assert.equal(adapter.launches[0].prompt, "hello");
  assert.match(deps.stderrChunks.join(""), /routing skipped: .*unknown backend/);
});

test("route reports servers the selected adapter has not configured", async () => {
  const { run } = await import("../src/cli.js");
  const deps = makeDeps({
    loadConfigFn: () => ({ router: { bindings: [{ pattern: "pull request", servers: ["repo", "tasks"] }] } }),
    adapters: {
      "claude-code": () =>
        Promise.resolve({ installedServers: () => ({ servers: ["repo"], source: "/project/.mcp.json" }) }),
    },
  });
  assert.equal(await run(["route", "--prompt", "open a pull request"], deps), 0);
  const out = JSON.parse(deps.stdoutChunks.join(""));
  assert.deepEqual(out.servers, ["repo", "tasks"]);
  assert.deepEqual(out.missing, [{ server: "tasks", install: null, checkedIn: "/project/.mcp.json" }]);
});

test("route without adapter support for installedServers reports nothing missing", async () => {
  const { run } = await import("../src/cli.js");
  const deps = makeDeps({
    loadConfigFn: () => ({ router: { bindings: [{ pattern: "pull request", servers: ["repo"] }] } }),
    adapters: { "claude-code": () => Promise.resolve({}) },
  });
  assert.equal(await run(["route", "--prompt", "open a pull request"], deps), 0);
  const out = JSON.parse(deps.stdoutChunks.join(""));
  assert.deepEqual([out.servers, out.missing], [["repo"], []]);
});

test("route still routes when the installed-server lookup throws or the adapter is unknown", async () => {
  const { run } = await import("../src/cli.js");
  const loadConfigFn = () => ({ router: { bindings: [{ pattern: "pull request", servers: ["repo"] }] } });
  const throwing = makeDeps({
    loadConfigFn,
    adapters: {
      "claude-code": () =>
        Promise.resolve({
          installedServers: () => {
            throw new Error("bad toml");
          },
        }),
    },
  });
  assert.equal(await run(["route", "--prompt", "open a pull request"], throwing), 0);
  assert.deepEqual(JSON.parse(throwing.stdoutChunks.join("")).servers, ["repo"]);

  const unknown = makeDeps({ loadConfigFn, adapters: {} });
  assert.equal(await run(["route", "--prompt", "open a pull request"], unknown), 0);
  assert.deepEqual(JSON.parse(unknown.stdoutChunks.join("")).missing, []);
});

test("init is dispatched to the init command with the working directory", async () => {
  const { run } = await import("../src/cli.js");
  const deps = makeDeps({
    daemon: { status: async () => ({ running: false }) },
    init: { execFn: () => "", daemon: { ensure: async () => ({ running: false, reason: "test" }) } },
  });
  deps.cwd = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "toolgate-cli-init-"));
  deps.skills = { execFn: () => "" };
  assert.equal(await run(["init"], deps), 0);
  assert.match(deps.stdoutChunks.join(""), /created \.toolgate\/config\.json/);
});

test("init restarts a managed daemon that serves fewer documents than the corpus, and says so", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { defaultCollection } = await import("../src/skills/corpus.js");
  const { run } = await import("../src/cli.js");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-init-stale-"));
  const steps = [];
  let served = 1;
  const deps = makeDeps({
    cwd,
    fetchFn: async (url, init) => {
      const body = JSON.parse(init.body);
      const result = body.method === "tools/call" ? { structuredContent: { collections: [{ name: defaultCollection(cwd), documents: served }] } } : {};
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json", "mcp-session-id": "s" }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      };
    },
    daemon: {
      status: async () => ({ running: !steps.includes("stop") }),
      stop: () => (steps.push("stop"), { ok: true, message: "Stopped." }),
      ensure: async () => (steps.push("start"), (served = 3), { running: true, started: true }),
    },
    init: { execFn: () => "", daemon: { ensure: async () => ({ running: false, reason: "test" }) } },
    skills: { execFn: () => "" },
  });
  const corpusDir = path.join(cwd, ".toolgate", "skills-index", "corpus");
  fs.mkdirSync(corpusDir, { recursive: true });
  for (const name of ["a.md", "b.md", "_index.md"]) fs.writeFileSync(path.join(corpusDir, name), "x");

  assert.equal(await run(["init"], deps), 0);
  const out = deps.stdoutChunks.join("");
  assert.deepEqual(steps, ["stop", "start"]);
  assert.match(out, /qmd daemon restarted/);
});

test("without an agent from flag, env or config, the launch errors and nothing starts", async () => {
  const adapter = makeMockAdapter();
  const deps = makeDeps({
    env: {},
    loadConfigFn: () => ({ baseline: [] }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  const code = await run(["hi"], deps);
  assert.equal(code, 1);
  assert.match(deps.stderrChunks.join(""), /defaultAgent/);
  assert.equal(adapter.launches.length, 0);
});

test("defaultAgent from the config selects the adapter", async () => {
  const adapter = makeMockAdapter();
  const deps = makeDeps({
    env: {},
    loadConfigFn: () => ({ baseline: [], defaultAgent: "claude-code" }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  assert.equal(await run(["--no-route", "hi"], deps), 0);
  assert.equal(adapter.launches[0].prompt, "hi");
});

test("--help and -h print the usage and ask for no agent, no config and no project setup", async () => {
  const { run } = await import("../src/cli.js");
  for (const flag of ["--help", "-h"]) {
    const deps = makeDeps({ cwd: "/nowhere", env: {}, loadConfigFn: () => ({}) });
    assert.equal(await run([flag], deps), 0, flag);
    assert.match(deps.stdoutChunks.join(""), /Usage:[\s\S]*toolgate init[\s\S]*toolgate skills[\s\S]*toolgate doctor/, flag);
    assert.equal(deps.stderrChunks.join(""), "", `${flag}: nothing on stderr (no "no agent selected")`);
  }
  // Also after a command: help does not run it.
  const deps = makeDeps({ cwd: "/nowhere", env: {}, loadConfigFn: () => ({}) });
  assert.equal(await run(["init", "--help"], deps), 0);
  assert.match(deps.stdoutChunks.join(""), /Usage:/);
});
test("--version and -v print the package version with no agent, no config and no project setup", async () => {
  const { run } = await import("../src/cli.js");
  const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const flag of ["--version", "-v"]) {
    const deps = makeDeps({ cwd: "/nowhere", env: {}, loadConfigFn: () => ({}) });
    assert.equal(await run([flag], deps), 0, flag);
    assert.equal(deps.stdoutChunks.join(""), `${version}\n`, flag);
    assert.equal(deps.stderrChunks.join(""), "", flag);
  }
  const help = makeDeps({ cwd: "/nowhere", env: {}, loadConfigFn: () => ({}) });
  await run(["--help"], help);
  assert.match(help.stdoutChunks.join(""), /--version, -v/);
});
test("-v after an agent name is the agent's own argument, not toolgate's version", async () => {
  const { run } = await import("../src/cli.js");
  const launches = [];
  const agentCli = { bin: "fake", subcommands: [], valueFlags: [], booleanFlags: ["-v"], nonInteractive: [] };
  const adapter = { agentCli, launch: (args) => (launches.push(args), Promise.resolve({ code: 0 })) };
  const deps = makeDeps({ cwd: "/nowhere", env: {}, loadConfigFn: () => ({}), adapters: { "claude-code": () => Promise.resolve(adapter) } });
  await run(["claude-code", "-v"], deps);
  assert.deepEqual(launches[0], ["-v"]);
  assert.doesNotMatch(deps.stdoutChunks.join(""), /^\d+\.\d+\.\d+\n$/);
});
test("a flag with its value reaches the agent whole: --resume <id> loads that session and is not a task", async () => {
  const adapter = { agentCli: { valueFlags: ["--resume", "--model"] }, launches: [], launch(options) { this.launches.push(options); return Promise.resolve({ code: 0 }); } };
  const deps = makeDeps({
    loadConfigFn: () => ({ baseline: [] }),
    loadStateFn: () => ({ extras: ["chrome-devtools"], toolExtras: {}, pendingRestart: true }),
    saveStateFn: () => {},
    adapters: { "claude-code": () => Promise.resolve(adapter) },
  });
  const { run } = await import("../src/cli.js");
  await run(["--resume", "abc-123"], deps);
  await run(["--resume", "abc-123", "--model", "opus", "do it"], deps);
  await run([], deps);
  assert.deepEqual(adapter.launches.map((l) => [l.prompt, l.agentArgs]), [
    [undefined, ["--resume", "abc-123"]],
    ["do it", ["--resume", "abc-123", "--model", "opus"]],
    [undefined, []],
  ]);
  assert.deepEqual(adapter.launches[0].state.extras, ["chrome-devtools"], "the server asked for earlier is still active");
});
