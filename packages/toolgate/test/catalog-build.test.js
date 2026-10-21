// `toolgate catalog build` end to end, against the stdio fixture server.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { run } from "../src/cli.js";
import { runCatalog } from "../src/catalog/cli.js";
import { oneLine } from "../src/catalog/sanitize.js";
import { readExisting, writeCatalog } from "../src/catalog/write.js";
import { placeholder, readManual, renderCatalog } from "../src/catalog/render.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/catalog-server.js", import.meta.url));
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-cb-${name}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, data) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof data === "string" ? data : JSON.stringify(data));
};
const def = (mode, env = {}) => ({ command: process.execPath, args: [FIXTURE], env: { MODE: mode, ...env } });

function setup({ user = {}, project = {} } = {}) {
  const cwd = tmp("proj");
  const home = tmp("home");
  put(home, ".claude.json", { mcpServers: user });
  if (Object.keys(project).length) put(cwd, ".mcp.json", { mcpServers: project });
  const questions = [];
  const syncs = [];
  const exec = async (args, { answers = null, env = {} } = {}) => {
    const out = [];
    const err = [];
    const queue = answers;
    const code = await run(["catalog", ...args], {
      cwd,
      env: { TOOLGATE_DEFAULTS: path.join(home, "toolgate.json"), ...env },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      loadConfigFn: () => ({}),
      hooks: { interactive: queue !== null, ask: async (q) => (questions.push(q), queue?.shift() ?? "") },
      catalog: { homedir: home, syncFn: (options) => syncs.push(options) },
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  const file = (name) => path.join(cwd, ".toolgate/catalog/servers", `${name}.md`);
  return { cwd, home, exec, questions, syncs, file, read: (name) => fs.readFileSync(file(name), "utf8"), has: (name) => fs.existsSync(file(name)) };
}

test("a server of the user's own config is built without a question: front matter as SPEC 7.1 and a section per tool", async () => {
  const p = setup({ user: { demo: def("ok") } });
  const result = await p.exec(["build"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /built demo: 2 tools -> \.toolgate\/catalog\/servers\/demo\.md/);
  assert.deepEqual(p.questions, []);
  const text = p.read("demo");
  assert.ok(text.startsWith('---\nserver: "demo"\ntransport: "stdio"\nauth: "none"\ninstructionsChars: 12\ntoolCount: 2\ntools:\n  - name: "alpha"\n    description: "First tool"\n    whenToUse: "First tool"\n'), text.slice(0, 200));
  assert.match(text, /\n## alpha\n\nDescription: First tool\n\nWhen to use: First tool\n/);
  assert.match(text, /\n## beta\n/);
});

test("a project server is not started without a yes: no terminal, --yes, CI, --force and --dry-run leave no marker and no file (exit 2)", async () => {
  const marker = path.join(tmp("mark"), "started");
  const p = setup({ project: { repo: def("ok", { MARKER_FILE: marker }) } });
  for (const [args, extra] of [[["build"], {}], [["build", "--yes"], { answers: ["yes"] }], [["build"], { answers: ["yes"], env: { CI: "1" } }], [["build", "--force"], { answers: ["yes"] }], [["build", "--dry-run"], { answers: ["yes"] }]]) {
    const result = await p.exec(args, extra);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.out, /skipped repo: not approved on this machine/);
  }
  assert.ok(!fs.existsSync(marker), "the server was never started");
  assert.ok(!p.has("repo"));
  assert.deepEqual(p.questions, []);
});

test("a typed yes starts it once, is remembered for that definition, and a change asks again", async () => {
  const marker = path.join(tmp("mark"), "started");
  const p = setup({ project: { repo: def("ok", { MARKER_FILE: marker }) } });
  assert.equal((await p.exec(["build"], { answers: ["Yes"] })).code, 2);
  assert.ok(!fs.existsSync(marker));
  assert.equal((await p.exec(["build"], { answers: ["yes"] })).code, 0);
  assert.ok(fs.existsSync(marker));
  assert.ok(p.has("repo"));
  const before = p.questions.length;
  assert.equal((await p.exec(["build"], { answers: null })).code, 0, "not asked again, not even without a terminal");
  assert.equal(p.questions.length, before);
  put(p.cwd, ".mcp.json", { mcpServers: { repo: def("ok", { MARKER_FILE: marker, EXTRA: "1" }) } });
  assert.equal((await p.exec(["build"], { answers: null })).code, 2, "a changed definition waits again");
});

test("a rebuild keeps what a person wrote in whenToUse, drops tools that went away, and never treats the generated text as hand-written", async () => {
  const p = setup({ user: { demo: def("ok") } });
  await p.exec(["build"]);
  const edited = p.read("demo").replace('whenToUse: "First tool"', 'whenToUse: "when the user asks for the first thing"').replace(/\n {4}whenToUseGenerated: true(?=\n {2}- name: "beta")/, "");
  fs.writeFileSync(p.file("demo"), edited);
  await p.exec(["build"]);
  const text = p.read("demo");
  assert.match(text, /whenToUse: "when the user asks for the first thing"\n/);
  assert.match(text, /name: "alpha"\n {4}description: "First tool"\n {4}whenToUse: "when the user asks for the first thing"\n(?! {4}whenToUseGenerated)/);
  assert.match(text, /name: "beta"\n {4}description: "Second tool"\n {4}whenToUse: "Second tool"\n {4}whenToUseGenerated: true/);
  assert.equal(await p.exec(["build"]).then((r) => r.code), 0);
  assert.deepEqual([...readManual(p.read("demo"))], [["alpha", "when the user asks for the first thing"]]);
});

test("a server that fails keeps its previous file, and the others are still built", async () => {
  const p = setup({ user: { good: def("ok"), flaky: def("ok") } });
  await p.exec(["build"]);
  const before = p.read("flaky");
  put(p.home, ".claude.json", { mcpServers: { good: def("ok"), flaky: def("oauth") } });
  const result = await p.exec(["build"]);
  assert.equal(result.code, 0, "a server that needs a login is skipped, not a failure");
  assert.match(result.out, /skipped flaky: needs OAuth or a login/);
  assert.equal(p.read("flaky"), before);
  put(p.home, ".claude.json", { mcpServers: { good: def("ok"), flaky: { command: "/nonexistent/server" } } });
  const failed = await p.exec(["build"]);
  assert.equal(failed.code, 1);
  assert.match(failed.out, /failed flaky: /);
  assert.equal(p.read("flaky"), before);
  assert.match(failed.out, /built good/);
});

test("the catalog is never written through a link, and a file toolgate did not write is not overwritten", async () => {
  const p = setup({ user: { demo: def("ok") } });
  const outside = tmp("out");
  fs.mkdirSync(path.join(p.cwd, ".toolgate"));
  fs.symlinkSync(outside, path.join(p.cwd, ".toolgate/catalog"));
  const linked = await p.exec(["build"]);
  assert.equal(linked.code, 1);
  assert.match(linked.err, /is a link or not a folder/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(p.cwd, ".toolgate/catalog"));
  put(p.cwd, ".toolgate/catalog/servers/demo.md", "my own notes\n");
  const foreign = await p.exec(["build"]);
  assert.equal(foreign.code, 1);
  assert.match(foreign.out, /is not a catalog written by toolgate; refusing to overwrite it/);
  assert.equal(p.read("demo"), "my own notes\n");
  fs.rmSync(p.file("demo"));
  const target = path.join(outside, "target.md");
  fs.writeFileSync(target, '---\nserver: "demo"\n---\nuntouched');
  fs.symlinkSync(target, p.file("demo"));
  assert.equal((await p.exec(["build"])).code, 1);
  assert.equal(fs.readFileSync(target, "utf8"), '---\nserver: "demo"\n---\nuntouched');
});

test("--dry-run writes nothing, --server picks one, an unknown name is an error, and an unsafe server name is skipped", async () => {
  const p = setup({ user: { one: def("ok"), two: def("ok") }, project: { "../evil": def("ok") } });
  const dry = await p.exec(["build", "--dry-run"]);
  assert.match(dry.out, /would build one: 2 tools/);
  assert.match(dry.out, /skipped \.\.\/evil: not a safe file name/);
  assert.ok(!fs.existsSync(path.join(p.cwd, ".toolgate")));
  await p.exec(["build", "--server", "two"]);
  assert.ok(p.has("two") && !p.has("one"));
  const unknown = await p.exec(["build", "--server", "nope"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no MCP server named "nope" is configured/);
});

test("--json lists the servers; an unknown subcommand is an error; catalogPath comes from the config and may not leave the project", async () => {
  const p = setup({ user: { demo: def("ok") } });
  const json = JSON.parse((await p.exec(["build", "--json"])).out);
  assert.deepEqual(json.servers.map((s) => [s.server, s.origin, s.status, s.toolCount]), [["demo", "user", "built", 2]]);
  const bad = await p.exec(["bogus"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /expected build/);
  const out = [];
  const err = [];
  const code = await run(["catalog", "build"], { cwd: p.cwd, env: { TOOLGATE_DEFAULTS: path.join(p.home, "t.json") }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, loadConfigFn: () => ({ router: { catalogPath: "../elsewhere" } }), catalog: { homedir: p.home, syncFn: () => {} } });
  assert.equal(code, 1);
  assert.match(err.join(""), /not a folder inside the project/);
});

test("hostile tools never reach the front matter as keys: it reads back as exactly the tools that were safe", async () => {
  const p = setup({ user: { bad: def("hostile") } });
  await p.exec(["build"]);
  const text = p.read("bad");
  const front = text.slice(0, text.indexOf("\n---\n", 4));
  assert.equal([...front.matchAll(/^ {2}- name: /gm)].length, 2);
  assert.doesNotMatch(front, /[\u202e\u0007]/);
  assert.doesNotMatch(front, /^ {2}- name: "forged/m);
  assert.match(front, /^toolCount: 2$/m);
  assert.equal(front.split("\n").filter((l) => /^\S/.test(l)).map((l) => l.split(":")[0]).join(","), "---,server,transport,auth,instructionsChars,toolCount,tools");
});

test("render: the placeholder is the first sentence, and values that look like YAML stay inside their quotes", () => {
  assert.equal(placeholder("Reads a file. Then more."), "Reads a file.");
  assert.equal(placeholder("No full stop"), "No full stop");
  const text = renderCatalog({ server: "s", transport: "stdio", auth: "none", instructionsChars: 0, tools: [{ name: "t", description: 'x"\nwhenToUse: injected\n---' }] });
  assert.equal([...text.matchAll(/^ {4}whenToUse:/gm)].length, 1);
  assert.equal(text.split("\n---\n").length, 2);
  assert.equal(readManual("not ours").size, 0);
  assert.equal(readManual('---\nnot: ours\n  - name: "a"\n    whenToUse: "hand written"\n---\n').size, 0, "a file we did not write is not read for text to keep");
});

test("text that cannot be written as YAML is cleaned: noncharacters and lone surrogates go, and a cut never splits a pair", () => {
  assert.equal(oneLine("a\uffffb\ufffec\ud800d\udc00e"), "a b c d e");
  const cut = oneLine("\u{1f600}".repeat(10), 4);
  assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.doesNotMatch(oneLine("x\ud800y"), /[\ud800-\udfff]/);
});

test("two servers whose names differ only in case never share a file: the first keeps it, the second is said", async () => {
  const p = setup({ user: { Foo: def("ok"), foo: def("ok") } });
  const result = await p.exec(["build"]);
  assert.match(result.out, /built Foo: 2 tools/);
  assert.match(result.out, /skipped foo: differs only in case from Foo, which has the file/);
  assert.equal(fs.readdirSync(path.dirname(p.file("Foo"))).length, 1);
  const dir = path.join(p.cwd, ".toolgate/catalog/servers");
  put(dir, "other.md", renderCatalog({ server: "Other", transport: "stdio", auth: "none", instructionsChars: 0, tools: [] }));
  assert.throws(() => writeCatalog({ cwd: p.cwd, config: {}, server: "other", text: "x" }), /is the catalog of the server "Other", not "other"/);
  assert.match(fs.readFileSync(path.join(dir, "other.md"), "utf8"), /^# Other$/m);
});

test("a build that is interrupted stops the server and everything it started", async () => {
  const home = tmp("home");
  const cwd = tmp("proj");
  const pidFile = path.join(tmp("pids"), "pids");
  put(home, ".claude.json", { mcpServers: { slow: def("hang", { PID_FILE: pidFile }) } });
  const bin = fileURLToPath(new URL("../bin/toolgate.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "catalog", "build"], { cwd, env: { PATH: process.env.PATH, HOME: home, TOOLGATE_DEFAULTS: path.join(home, "t.json") }, stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(fs.existsSync(pidFile), "the server was started");
  const [server, grandchild] = fs.readFileSync(pidFile, "utf8").split(" ").map(Number);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(alive(server), false, "the server is gone");
  assert.equal(alive(grandchild), false, "and what it started");
});

test("the write is atomic: when it cannot finish, the previous file is as it was", () => {
  const p = setup();
  const dir = path.join(p.cwd, ".toolgate/catalog/servers");
  const old = renderCatalog({ server: "keep", transport: "stdio", auth: "none", instructionsChars: 0, tools: [] });
  put(dir, "keep.md", old);
  const real = fs.writeFileSync;
  fs.writeFileSync = (target, data, options) => {
    real(target, String(data).slice(0, 2), options);
    throw new Error("disk full");
  };
  try {
    assert.throws(() => writeCatalog({ cwd: p.cwd, config: {}, server: "keep", text: "new text" }), /disk full/);
  } finally {
    fs.writeFileSync = real;
  }
  assert.equal(fs.readFileSync(path.join(dir, "keep.md"), "utf8"), old, "a write that fails half way leaves the previous file");
});

test("what is read back is cleaned and a link is not read; an extra argument and control characters in the report are refused", async () => {
  const text = '---\nserver: "s"\ntransport: "stdio"\nauth: "none"\ninstructionsChars: 0\ntoolCount: 1\ntools:\n  - name: "t"\n    description: "d"\n    whenToUse: "x\\u202ey"\n---\n';
  assert.deepEqual([...readManual(text)], [["t", "x y"]]);
  const p = setup();
  const dir = path.join(p.cwd, ".toolgate/catalog/servers");
  const outside = tmp("out");
  put(outside, "s.md", text);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(outside, "s.md"), path.join(dir, "s.md"));
  assert.equal(readExisting(dir, "s"), null);
  const extra = await p.exec(["build", "now"]);
  assert.equal(extra.code, 1);
  const out = [];
  await runCatalog(["build"], { stdout: { write: (t) => out.push(t) }, stderr: { write: () => {} }, buildFn: async () => ({ code: 1, rows: [{ server: "a\u001b[31mb", status: "failed", reason: "bad\u202e\u0007 reason" }] }) });
  assert.doesNotMatch(out.join(""), /[\u001b\u202e\u0007]/);
});
