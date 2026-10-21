// The catalog and the qmd search, #242 T6: a file is the catalog's only with its whole head, a result that is not an object is
// no hit, a qmd that ignores SIGTERM is killed, a server's error does not echo a query token, a malformed .mcp.json is said,
// and the key router.catalogCollection has no effect.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { buildCatalog } from "../src/catalog/build.js";
import { isCatalogFile, parseTools, readManual, renderCatalog } from "../src/catalog/render.js";
import { introspectHttp } from "../src/catalog/introspect.js";
import { redact } from "../src/catalog/sanitize.js";
import { writeCatalog } from "../src/catalog/write.js";
import { checkConfig } from "../src/doctor/checks.js";
import { applyChange } from "../src/configFile.js";
import { createQmdBackend } from "../src/router.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cf-")));
  made.push(dir);
  return dir;
};
const REPO_FILE = '---\nserver: "demo"\ntools:\n  - name: "t"\n    description: "d"\n    whenToUse: "carried over from a repository"\n---\nnotes of the repository\n';
test("only a file with the whole head the catalog writes is the catalog's: a repository file that starts with server: is not", () => {
  const ours = renderCatalog({ server: "demo", transport: "stdio", auth: "none", instructionsChars: 3, tools: [{ name: "t", description: "d" }] }, new Map([["t", "written by a person"]]));
  assert.equal(isCatalogFile(ours), true);
  assert.equal(isCatalogFile(renderCatalog({ server: "demo", transport: "stdio", auth: "none", instructionsChars: 0, tools: [] })), true, "an empty catalog too");
  for (const text of [REPO_FILE, '---\nserver: "demo"\n---\nx', '---\nserver: "demo"\ntransport: "stdio"\n---\nx', ours.replace("toolCount: 1\n", ""), ours.replace("tools:\n", ""), `x${ours}`, ours.replace('auth: "none"', "auth: none")]) assert.equal(isCatalogFile(text), false, text.slice(0, 60));
  assert.deepEqual([...readManual(ours)], [["t", "written by a person"]], "ours keeps what a person wrote");
  assert.deepEqual([...readManual(REPO_FILE)], [], "a repository file is not read for it");
  assert.deepEqual(parseTools(REPO_FILE), []);
});
test("a repository file with that first line is not overwritten", () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate", "catalog", "servers"), { recursive: true });
  const file = path.join(cwd, ".toolgate", "catalog", "servers", "demo.md");
  fs.writeFileSync(file, REPO_FILE);
  assert.throws(() => writeCatalog({ cwd, config: {}, server: "demo", text: "new" }), /is not a catalog written by toolgate; refusing to overwrite it/);
  assert.equal(fs.readFileSync(file, "utf8"), REPO_FILE);
});
test("a result that is not an object in what qmd answers is no hit, from the CLI and from the daemon", async () => {
  const cli = createQmdBackend({ daemonUrl: null, execFn: () => '[null, 5, "x", [], [{"file": "a.md"}], {}, {"file": "nothing.md", "score": 0.9}, true]', cwd: tmp() });
  const out = await cli.match("open a pull request", {});
  assert.deepEqual(out.skills, []);
  const reply = (body) => ({ ok: true, status: 200, headers: new Map([["content-type", "application/json"], ["mcp-session-id", "s"]]), text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    return reply({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/call" ? { structuredContent: { results: [null, { file: "nothing.md", score: 0.9 }, 7] } } : {} });
  };
  const viaDaemon = await createQmdBackend({ daemonUrl: "http://d/mcp", fetchFn, execFn: () => assert.fail("the daemon answered"), cwd: tmp() }).match("open a pull request", {});
  assert.deepEqual(viaDaemon.skills, []);
});
test("a qmd that ignores the polite signal is killed when the search times out", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const bin = path.join(dir, "qmd");
  fs.writeFileSync(bin, "#!/bin/sh\ntrap '' TERM\nexec sleep 25\n", { mode: 0o755 });
  const started = Date.now();
  const out = await createQmdBackend({ daemonUrl: null, qmdBin: bin, cwd: dir }).match("open a pull request", {});
  assert.ok(Date.now() - started < 15000, `the search returned after ${Date.now() - started} ms`);
  assert.match(out.reason, /QMD lookup failed/);
});
test("redact: credentials, and the query and fragment of any url, are removed; the rest of the text stays", () => {
  assert.equal(redact("connect to https://u:p@h.example/mcp?token=abc123&x=1 failed"), "connect to https://h.example/mcp?… failed");
  assert.equal(redact("GET http://h/p#access_token=zzz"), "GET http://h/p?…");
  assert.equal(redact('{"url":"https://h/x?key=k1","other":1}'), '{"url":"https://h/x?…","other":1}');
  assert.equal(redact("no url here: spawn x ENOENT"), "no url here: spawn x ENOENT");
  assert.equal(redact("https://h/mcp failed"), "https://h/mcp failed");
  assert.ok(!redact("see https://h/a?token=SECRET and http://h/b?x=SECRET2").includes("SECRET"));
});
test("redact takes time in proportion to the text: a server cannot make an error slow with a lot of http://", () => {
  const started = performance.now();
  const out = redact("http://".repeat(100000));
  assert.ok(performance.now() - started < 2000, `${Math.round(performance.now() - started)} ms for 700 KB`);
  assert.equal(out.length, 700000, "and with no ? or # there is nothing to take out");
  const many = "http://h/a?t=1 ".repeat(20000);
  const t2 = performance.now();
  assert.equal(redact(many), "http://h/a?… ".repeat(20000));
  assert.ok(performance.now() - t2 < 2000);
  assert.equal(redact("see (http://h/a?token=x) and HTTPS://H/B#frag"), "see (http://h/a?… and HTTPS://H/B?…", "a word is cut at the first ? or #, whatever the case of the scheme");
  assert.equal(redact("key=http://h/p?s=1,http://i/q?z=2 end"), "key=http://h/p?… end", "two urls in one word: everything after the first query goes");
});
test("a failure of a server is scrubbed and cut: a very long error with a url costs no more than a short one", async () => {
  const fetchFn = async () => {
    throw new Error(`${"http://".repeat(100000)}y?token=SECRET`);
  };
  const started = performance.now();
  const result = await introspectHttp({ transport: "http", url: "http://h.example/mcp", headers: {} }, { timeoutMs: 20000, fetchFn });
  assert.ok(performance.now() - started < 5000, `${Math.round(performance.now() - started)} ms`);
  assert.equal(result.status, "error");
  assert.ok(!result.reason.includes("SECRET") && result.reason.length <= 300);
  const short = await introspectHttp({ transport: "http", url: "http://h.example/mcp", headers: {} }, { timeoutMs: 20000, fetchFn: async () => { throw new Error("refused at https://h.example/mcp?token=SECRET"); } });
  assert.equal(short.reason, "refused at https://h.example/mcp?…");
});
test("a malformed .mcp.json stops the build with the reason and exit 1, without printing what is in the file; none configured is still exit 0", async () => {
  const cwd = tmp();
  const homedir = tmp();
  fs.writeFileSync(path.join(cwd, ".mcp.json"), '{ "mcpServers": { "a": { "env": { "TOKEN": "TOKEN123" } }, }');
  const result = await buildCatalog({ cwd, homedir });
  assert.equal(result.code, 1);
  assert.match(result.error, /^\.mcp\.json is not valid JSON \(.+\)$/);
  assert.ok(!result.error.includes("TOKEN123"), result.error);
  // V8 quotes the start of a file that is not JSON at all in its message: that piece is not repeated.
  const quoted = tmp();
  fs.writeFileSync(path.join(quoted, ".mcp.json"), "TOKEN123 is not json");
  const shown = await buildCatalog({ cwd: quoted, homedir });
  assert.equal(shown.code, 1);
  assert.match(shown.error, /^\.mcp\.json is not valid JSON \(Unexpected token/);
  assert.ok(!shown.error.includes("TOKEN123"), shown.error);
  // A longer file is quoted in the middle, between ellipses.
  const longer = tmp();
  fs.writeFileSync(path.join(longer, ".mcp.json"), `{ "mcpServers": ${"x".repeat(40)} TOKEN123 ${"y".repeat(40)} }`);
  const middle = await buildCatalog({ cwd: longer, homedir });
  assert.equal(middle.code, 1);
  assert.match(middle.error, /^\.mcp\.json is not valid JSON \(Unexpected token/);
  assert.ok(!middle.error.includes("TOKEN123") && !middle.error.includes("xxxx"), middle.error);
  // V8 can quote a piece with line breaks in it: nothing of it is printed, not even its first characters.
  const lines = tmp();
  fs.writeFileSync(path.join(lines, ".mcp.json"), '{\n"KEY": sk-live-abcdef0123456789,\n"other": 1 }');
  const multi = await buildCatalog({ cwd: lines, homedir });
  assert.equal(multi.code, 1);
  assert.match(multi.error, /^\.mcp\.json is not valid JSON \(Unexpected token 's'\)$/, multi.error);
  assert.ok(!/KEY|sk-live|\{/.test(multi.error), multi.error);
  // A byte order mark is not a syntax error; a file over 1 MiB is not read and that is said.
  const bom = tmp();
  fs.writeFileSync(path.join(bom, ".mcp.json"), `\uFEFF${JSON.stringify({ mcpServers: {} })}`);
  const withBom = await buildCatalog({ cwd: bom, homedir });
  assert.deepEqual([withBom.code, withBom.error], [0, undefined]);
  const big = tmp();
  fs.writeFileSync(path.join(big, ".mcp.json"), JSON.stringify({ mcpServers: {}, pad: "x".repeat(1024 * 1024) }));
  const tooBig = await buildCatalog({ cwd: big, homedir });
  assert.equal(tooBig.code, 1);
  assert.equal(tooBig.error, ".mcp.json is not valid JSON (it is larger than 1 MiB)");
  const err = [];
  const code = await run(["catalog", "build"], { cwd, env: { HOME: homedir, XDG_CONFIG_HOME: tmp() }, stdout: { write: () => {} }, stderr: { write: (s) => err.push(s) }, catalog: { homedir } });
  assert.equal(code, 1);
  assert.match(err.join(""), /^toolgate catalog: \.mcp\.json is not valid JSON \(/);
  const empty = tmp();
  const none = await buildCatalog({ cwd: empty, homedir });
  assert.deepEqual([none.code, none.error, none.rows], [0, undefined, []]);
  fs.writeFileSync(path.join(empty, ".mcp.json"), "[]");
  assert.equal((await buildCatalog({ cwd: empty, homedir })).code, 0, "valid JSON that holds no servers is none configured");
});
test("router.catalogCollection is still accepted and doctor says it has no effect", () => {
  assert.equal(applyChange({}, { action: "set", key: "router.catalogCollection", value: "mine", layer: "user" }), true);
  const findings = checkConfig({ cwd: tmp(), config: { router: { catalogCollection: "mine" } }, configErrors: [], env: {}, qmd: false, homedir: tmp() });
  const note = findings.filter((f) => f.id === "router.catalogCollection");
  assert.equal(note.length, 1);
  assert.equal(note[0].level, "warn");
  assert.match(note[0].message, /^router\.catalogCollection has no effect: /);
  const none = checkConfig({ cwd: tmp(), config: { router: {} }, configErrors: [], env: {}, qmd: false, homedir: tmp() });
  assert.ok(!none.some((f) => f.id === "router.catalogCollection"));
});
