// What the live check of #19 found (#311): the agent named in the restart text, the catalog card matched for servers that are already
// active in the session, and the catalog warning that names only the servers of the repository.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { formatNeed, resolveNeed } from "../src/need.js";
import { route } from "../src/router.js";
import { catalogForRoute } from "../src/catalog/read.js";
import { checkCatalog } from "../src/doctor/checks.js";
import { renderCatalog } from "../src/catalog/render.js";
import { createSession, readSession, readInstructions, updateSession } from "../src/session.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (label) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-live-${label}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, data) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof data === "string" ? data : JSON.stringify(data));
};
const tool = (name, description) => ({ name, description });
const card = (server, tools) => renderCatalog({ server, transport: "stdio", auth: "none", instructionsChars: 0, tools }, new Map());
const IDLE = { extras: [], toolExtras: {}, pendingRestart: false };
const GITHUB = [tool("create_pull_request", "Open a pull request on GitHub"), tool("list_issues", "List the issues of a repository")];

// A project whose .mcp.json defines `project` servers, a user config with `user` servers, and a catalog file for each of `catalog`.
function project({ project: projectServers = [], user: userServers = [], catalog = {} } = {}) {
  const cwd = tmp("proj");
  const home = tmp("home");
  put(home, ".claude.json", { mcpServers: Object.fromEntries(userServers.map((s) => [s, { command: "x" }])) });
  if (projectServers.length) put(cwd, ".mcp.json", { mcpServers: Object.fromEntries(projectServers.map((s) => [s, { command: "x" }])) });
  for (const [server, tools] of Object.entries(catalog)) put(cwd, `.toolgate/catalog/servers/${server}.md`, card(server, tools));
  return { cwd, home, catalog: () => catalogForRoute({ config: {}, cwd, homedir: home }) };
}

// --- 3. the catalog warning
test("a user-level server with no catalog entry is not named; a server of the repository is, as before", async () => {
  const p = project({ project: ["newone", "github"], user: ["karajan-mcp", "squeezr"], catalog: { github: GITHUB } });
  const routed = await route("open a pull request", {}, { catalog: p.catalog() });
  const known = routed.warnings.filter((w) => /does not know/.test(w));
  assert.equal(known.length, 1);
  assert.match(known[0], /does not know newone:/);
  assert.doesNotMatch(known[0], /karajan-mcp|squeezr/);
  const onlyUser = project({ project: ["github"], user: ["squeezr"], catalog: { github: GITHUB } });
  assert.deepEqual((await route("open a pull request", {}, { catalog: onlyUser.catalog() })).warnings.filter((w) => /does not know/.test(w)), []);
});

// --- 2. the catalog card of a server that is already active
test("route gives the tools of the card of an active server the task matches, without choosing it or counting for the cap", async () => {
  const p = project({ project: ["github", "calendar"], catalog: { github: GITHUB, calendar: [tool("list_events", "List the events of a calendar")] } });
  const task = "open a pull request for this branch";
  for (const config of [{ baseline: ["github"] }, { keywords: { github: ["pull request"] } }, { baseline: ["github"], router: { catalogMaxServers: 0 } }]) {
    const routed = await route(task, config, { catalog: p.catalog(), activeServers: ["github"] });
    assert.deepEqual(routed.sessionTools, [{ server: "github", tools: ["create_pull_request"] }], JSON.stringify(config));
    assert.ok(!routed.servers.includes("calendar"), "no other server is chosen");
  }
  const plain = await route(task, { baseline: ["github"] }, { catalog: p.catalog(), activeServers: ["github"] });
  assert.deepEqual(plain.servers, [], "a baseline server is not added to the chosen ones");
  assert.deepEqual(plain.alwaysOn, [], "and not announced as matched either");
  const noMatch = await route("something unrelated entirely", { baseline: ["github"] }, { catalog: p.catalog(), activeServers: ["github"] });
  assert.ok(!("sessionTools" in noMatch));
  const elsewhere = await route(task, { baseline: ["github"] }, { catalog: p.catalog(), activeServers: ["calendar"] });
  assert.ok(!("sessionTools" in elsewhere), "only the servers of the session");
  assert.ok(!("sessionTools" in (await route(task, { baseline: ["github"] }, { catalog: p.catalog() }))), "outside a session nothing changes");
  assert.ok(!("sessionTools" in (await route(task, { baseline: ["github"] }, { catalog: p.catalog(), activeServers: [] }))));
  const bound = await route(task, { baseline: ["github"], router: { bindings: [{ pattern: "pull request", servers: ["github"] }] } }, { catalog: p.catalog(), activeServers: ["github"] });
  assert.ok(!("sessionTools" in bound), "a mandatory binding is the whole answer");
});

function sandbox({ cards = { repo: ["list", "get", "merge"] }, agent } = {}) {
  const env = { XDG_STATE_HOME: tmp("state"), HOME: tmp("home") };
  const { file } = createSession(["repo", "docs"], { env, projectDir: "/work/proj", ...(agent ? { agent } : {}) });
  const session = () => ({
    state: readSession(file, { env }),
    cardTools: (server) => cards[server] ?? [],
    instructionsOf: (server) => readInstructions(file, server, { env }),
    update: (change) => updateSession(file, change, { env }),
  });
  return { env, file, session, state: () => readSession(file, { env }) };
}
const routed = (overrides = {}) => ({ servers: [], missing: [], skills: [], commands: [], subagents: [], warnings: [], binding: null, alwaysOn: [], ...overrides });
const adapter = { supportsResume: true, capability: { subagents: { kind: "none" } } };

test("need reveals the tools of the card of an active server the router did not choose (a baseline one), and of one a keyword chose", () => {
  for (const route_ of [routed({ alwaysOn: ["repo"], sessionTools: [{ server: "repo", tools: ["list"] }] }), routed({ servers: ["repo"], sessionTools: [{ server: "repo", tools: ["list"] }] })]) {
    const box = sandbox();
    const { result, state } = resolveNeed(route_, { state: IDLE, agent: "claude-code", adapter, session: box.session() });
    assert.deepEqual(result.servers, [{ server: "repo", status: "revealed", source: "catalog", tools: ["list"] }]);
    assert.equal(state, null);
    assert.equal(result.restart, null);
    assert.deepEqual(box.state().servers.repo.enabled, ["list"]);
  }
});

test("need says dormant when the router chose the server and its card did not match, as before; an unmatched baseline server is not mentioned", () => {
  const box = sandbox();
  const dormant = resolveNeed(routed({ servers: ["repo"] }), { state: IDLE, agent: "claude-code", adapter, session: box.session() });
  assert.equal(dormant.result.servers[0].status, "dormant");
  const none = resolveNeed(routed(), { state: IDLE, agent: "claude-code", adapter, session: box.session() });
  assert.deepEqual(none.result.servers, []);
  // one that the task matched by words and the card did not: available, as before
  const matched = resolveNeed(routed({ alwaysOn: ["repo"] }), { state: IDLE, agent: "claude-code", adapter, session: box.session() });
  assert.deepEqual(matched.result.servers, [{ server: "repo", status: "available" }]);
});

test("the tools matched for a server that is not in the session are ignored, and so is a session that is not there", () => {
  const box = sandbox();
  const other = resolveNeed(routed({ sessionTools: [{ server: "elsewhere", tools: ["x"] }] }), { state: IDLE, agent: "claude-code", adapter, session: box.session() });
  assert.deepEqual(other.result.servers, []);
  const none = resolveNeed(routed({ sessionTools: [{ server: "repo", tools: ["list"] }] }), { state: IDLE, agent: "claude-code", adapter, session: null });
  assert.deepEqual(none.result.servers, []);
});

// --- 1. the agent in the restart text
function cliSetup(box, { sessionEnv = {}, defaultAgent, resume = false } = {}) {
  const out = [];
  const deps = {
    cwd: "/project",
    env: { ...box.env, ...sessionEnv },
    stdout: { write: (s) => out.push(s) },
    stderr: { write() {} },
    loadConfigFn: () => ({ baseline: [], ...(defaultAgent ? { defaultAgent } : {}), router: { bindings: [{ pattern: "pull request", servers: ["elsewhere"] }] } }),
    loadStateFn: () => structuredClone(IDLE),
    saveStateFn() {},
    adapters: { "claude-code": () => Promise.resolve({ supportsResume: resume }), opencode: () => Promise.resolve({ supportsResume: resume }), codex: () => Promise.resolve({ supportsResume: resume }) },
  };
  return { deps, restart: () => JSON.parse(out.join("")).restart };
}
const askRestart = async (box, options, args = []) => {
  const setup = cliSetup(box, options);
  await run(["need", "open a pull request", "--json", ...args], setup.deps);
  return setup.restart();
};

test("the restart text names the agent of the session, then --adapter, then defaultAgent, and never undefined", async () => {
  const inSession = sandbox({ agent: "opencode" });
  const env = { TOOLGATE_SESSION_STATE: inSession.file };
  assert.equal(await askRestart(inSession, { sessionEnv: env, defaultAgent: "claude-code" }, ["--adapter", "codex"]), "end the session and run `toolgate opencode` to relaunch it", "the session's agent wins");
  const noAgent = sandbox();
  assert.equal(await askRestart(noAgent, { sessionEnv: { TOOLGATE_SESSION_STATE: noAgent.file }, defaultAgent: "claude-code" }, ["--adapter", "codex"]), "end the session and run `toolgate codex` to relaunch it", "a session without an agent: --adapter");
  assert.equal(await askRestart(noAgent, { sessionEnv: { TOOLGATE_SESSION_STATE: noAgent.file }, defaultAgent: "claude-code" }), "end the session and run `toolgate claude-code` to relaunch it", "then defaultAgent");
  assert.equal(await askRestart(noAgent, { defaultAgent: "claude-code" }, ["--adapter", "codex"]), "end the session and run `toolgate codex` to relaunch it", "outside a session: --adapter");
  assert.equal(await askRestart(noAgent, { defaultAgent: "claude-code" }), "end the session and run `toolgate claude-code` to relaunch it", "outside a session: defaultAgent");
  const unknown = await askRestart(noAgent, {}).catch(() => null);
  if (unknown !== null) assert.equal(unknown, "end the session and relaunch it with `toolgate <agent>`", "no agent known");
});

test("without a known agent the restart text asks for none instead of printing undefined", () => {
  for (const agent of [undefined, null, ""]) {
    const { result } = resolveNeed(routed({ servers: ["a"] }), { state: IDLE, agent, adapter: { supportsResume: false } });
    assert.equal(result.restart, "end the session and relaunch it with `toolgate <agent>`", String(agent));
    assert.doesNotMatch(formatNeed(result), /undefined/);
  }
});

test("a session keeps the agent it was made for through a relaunch's update, and a hostile name is not stored", () => {
  const box = sandbox({ agent: "claude-code" });
  updateSession(box.file, (state) => state, { env: box.env });
  assert.equal(box.state().agent, "claude-code");
  const refused = createSession(["repo"], { env: { XDG_STATE_HOME: tmp("state"), HOME: tmp("home") }, projectDir: "/work/proj", agent: "bad\u001b[31m name" });
  assert.ok("refused" in refused, "a name that is not an adapter name is refused by the session, not written");
});

test("through the command: a baseline server of the session whose card matches the task is revealed, with the cap at zero too", async () => {
  const p = project({ project: ["github"], catalog: { github: GITHUB } });
  const env = { XDG_STATE_HOME: tmp("state"), HOME: p.home };
  for (const router of [{}, { catalogMaxServers: 0 }]) {
    const { file } = createSession(["github"], { env, projectDir: p.cwd, agent: "claude-code" });
    const out = [];
    const deps = {
      cwd: p.cwd,
      env: { ...env, TOOLGATE_SESSION_STATE: file },
      stdout: { write: (s) => out.push(s) },
      stderr: { write() {} },
      loadConfigFn: () => ({ baseline: ["github"], router }),
      loadStateFn: () => structuredClone(IDLE),
      saveStateFn() {},
      catalog: { homedir: p.home },
      adapters: { "claude-code": () => Promise.resolve({ supportsResume: true }) },
    };
    assert.equal(await run(["need", "open a pull request for this branch"], deps), 0);
    assert.equal(out.join(""), "server github: revealed (create_pull_request)\n", JSON.stringify(router));
    assert.deepEqual(readSession(file, { env }).servers.github.enabled, ["create_pull_request"]);
  }
});

test("doctor still names a user-level server that has no catalog entry, which the route no longer mentions", async () => {
  const p = project({ project: ["github"], user: ["karajan-mcp", "squeezr"], catalog: { github: GITHUB } });
  const [finding, ...rest] = checkCatalog({ config: {}, cwd: p.cwd, homedir: p.home }).filter((f) => f.id === "catalog.missing");
  assert.deepEqual(rest, []);
  assert.equal(finding.level, "warn");
  assert.match(finding.message, /does not describe karajan-mcp, squeezr$/);
  assert.equal(finding.hint, "toolgate catalog build");
  const routed = await route("open a pull request", {}, { catalog: p.catalog() });
  assert.deepEqual(routed.warnings.filter((w) => /does not know/.test(w)), [], "the route stays quiet about them");
});
