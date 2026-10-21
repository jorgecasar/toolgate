// The servers opencode's config defines for a launch (#1 T2): its files, their order, the forms read, and what is never read.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as opencode from "../src/adapters/opencode.js";
import { parseJsonc, stripJsonc } from "../src/jsonc.js";
import { MAX_MCP_BYTES } from "../src/proxyEnv.js";
import { sessionFor, wrappedServers } from "../src/sessionLaunch.js";
import { sessionsRoot } from "../src/session.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-ocd-")));
  made.push(dir);
  return dir;
};
const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};
const local = (name, extra = {}) => ({ type: "local", command: ["toolgate-proxy"], environment: { TOOLGATE_UPSTREAM_CMD: "x", TOOLGATE_SERVER: name }, ...extra });
const box = () => {
  const cwd = tmp();
  const homedir = tmp();
  return { cwd, homedir, env: {}, read: (extra = {}) => opencode.definedServers({ cwd, homedir, env: {}, ...extra }) };
};

test("a local server is read as { command, args, env }: the command list is split, only text values of environment are kept", () => {
  const { cwd, read } = box();
  put(path.join(cwd, "opencode.json"), { mcp: { probe: { type: "local", command: ["node", "a.js", "--x"], environment: { TOOLGATE_SERVER: "probe", N: 5, OK: "1" } } } });
  assert.deepEqual(read(), { probe: { command: "node", args: ["a.js", "--x"], env: { TOOLGATE_SERVER: "probe", OK: "1" } } });
});

test("forms that are not a local server with a command list are not read, and never an error", () => {
  const { cwd, read } = box();
  put(path.join(cwd, "opencode.json"), {
    mcp: {
      remote: { type: "remote", url: "https://x" },
      string: { type: "local", command: "toolgate-proxy" },
      empty: { type: "local", command: [] },
      mixed: { type: "local", command: ["a", 5] },
      untyped: { command: ["a"] },
      nothing: null,
      text: "x",
      list: [],
      good: local("good"),
    },
  });
  assert.deepEqual(Object.keys(read()), ["good"]);
  for (const content of ['{"mcp":null}', '{"mcp":[]}', '{"mcp":"x"}', "null", "[]", "{not json", ""]) {
    put(path.join(cwd, "opencode.json"), content);
    assert.deepEqual(read(), {}, content);
  }
  assert.deepEqual(box().read(), {}, "no file");
});

test("a name that is __proto__ is a server like any other, not the prototype", () => {
  const { cwd, read } = box();
  put(path.join(cwd, "opencode.json"), `{"mcp":{"__proto__":${JSON.stringify(local("__proto__"))}}}`);
  const servers = read();
  assert.deepEqual(Object.keys(servers), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(servers), Object.prototype);
});

test("opencode.jsonc: comments and trailing commas are read, and // inside a string stays", () => {
  const { cwd, read } = box();
  put(path.join(cwd, "opencode.jsonc"), `{
    // the servers
    "mcp": {
      /* proxied */
      "probe": { "type": "local", "command": ["toolgate-proxy",], "environment": { "URL": "http://x//y", "TOOLGATE_SERVER": "probe", }, },
    },
  }`);
  assert.deepEqual(read(), { probe: { command: "toolgate-proxy", args: [], env: { URL: "http://x//y", TOOLGATE_SERVER: "probe" } } });
});

test("the files are read in opencode's order, the last one naming a server wins, and an entry that is not local removes the earlier one", () => {
  const { cwd, homedir, read } = box();
  const config = tmp();
  const other = put(path.join(tmp(), "named.json"), { mcp: { a: local("a", { command: ["viaEnvFile"] }), c: local("c") } });
  // The order measured with opencode 1.18.4, lowest first: ~/.config/opencode, OPENCODE_CONFIG, the project, ~/.opencode.
  const global = put(path.join(homedir, ".config", "opencode", "opencode.json"), { mcp: { a: local("a", { command: ["global"] }), b: local("b"), d: local("d") } });
  const env = { OPENCODE_CONFIG: other };
  const projectFile = put(path.join(cwd, "opencode.json"), { mcp: { a: local("a", { command: ["project"] }), d: { type: "remote", url: "https://x" } } });
  const dot = put(path.join(homedir, ".opencode", "opencode.json"), { mcp: { a: local("a", { command: ["dot"] }) } });
  assert.equal(read({ env }).a.command, "dot", "~/.opencode wins over all");
  assert.deepEqual(Object.keys(read({ env })).sort(), ["a", "b", "c"], "d is remote in the project's file: not a local server any more");
  fs.rmSync(dot);
  assert.equal(read({ env }).a.command, "project", "the project's over OPENCODE_CONFIG");
  fs.rmSync(projectFile);
  assert.equal(read({ env }).a.command, "viaEnvFile", "OPENCODE_CONFIG over the global folder");
  assert.equal(read({ env }).d.command, "toolgate-proxy", "d is local again once the file that made it remote is gone");
  assert.equal(read().a.command, "global", "no OPENCODE_CONFIG: the global folder");
  fs.rmSync(global);
  put(path.join(cwd, "opencode.json"), { mcp: { a: local("a", { command: ["json"] }) } });
  assert.equal(read().a.command, "json");
  put(path.join(cwd, "opencode.jsonc"), { mcp: { a: local("a", { command: ["jsonc"] }) } });
  assert.equal(read().a.command, "jsonc", "opencode.jsonc after opencode.json of the same folder");
  put(path.join(homedir, ".config", "opencode", "opencode.json"), { mcp: { b: local("b") } });
  // XDG_CONFIG_HOME moves the global folder.
  put(path.join(config, "opencode", "opencode.json"), { mcp: { x: local("x") } });
  assert.ok(Object.hasOwn(read({ env: { XDG_CONFIG_HOME: config } }), "x"));
  assert.ok(!Object.hasOwn(read({ env: { XDG_CONFIG_HOME: config } }), "b"), "the folder under the home is not read then");
  assert.ok(Object.hasOwn(read({ env: { XDG_CONFIG_HOME: config } }), "x"));
  const relative = path.relative(process.cwd(), config);
  assert.ok(!path.isAbsolute(relative));
  assert.ok(!Object.hasOwn(read({ env: { XDG_CONFIG_HOME: relative } }), "x"), "a relative XDG_CONFIG_HOME is not used");
});

test("a file that is a symbolic link, not a regular file, or past the size limit is not read", () => {
  const { cwd, read } = box();
  const real = put(path.join(tmp(), "real.json"), { mcp: { probe: local("probe") } });
  fs.symlinkSync(real, path.join(cwd, "opencode.json"));
  assert.deepEqual(read(), {}, "a link");
  fs.rmSync(path.join(cwd, "opencode.json"));
  fs.mkdirSync(path.join(cwd, "opencode.json"));
  assert.deepEqual(read(), {}, "a folder");
  fs.rmdirSync(path.join(cwd, "opencode.json"));
  const big = path.join(cwd, "opencode.json");
  put(big, { mcp: { probe: local("probe") } });
  assert.ok(Object.hasOwn(read(), "probe"));
  // Still valid JSON, only past the limit: the size is what refuses it.
  fs.appendFileSync(big, " ".repeat(MAX_MCP_BYTES));
  assert.deepEqual(read(), {}, "past the limit");
});

test("a launch of opencode opens a session for a wrapped server of its config and for no other", () => {
  const { cwd, homedir } = box();
  put(path.join(cwd, "opencode.json"), { mcp: { probe: local("probe"), plain: { type: "local", command: ["node", "s.js"] }, unnamed: { type: "local", command: ["toolgate-proxy"] } } });
  const env = { XDG_STATE_HOME: tmp(), HOME: tmp() };
  const config = { baseline: ["probe", "plain", "unnamed"] };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };
  const wrapped = wrappedServers({ config, state, prompt: "", adapter: opencode, cwd, homedir, env });
  assert.deepEqual(wrapped, [{ server: "probe", baseline: [] }]);
  const written = [];
  const session = sessionFor({ capability: opencode.capability, agent: "opencode", stderr: { write: (line) => written.push(line) }, env, projectDir: cwd });
  const sessionEnv = session.open(wrapped);
  assert.ok(sessionEnv.TOOLGATE_SESSION_STATE.startsWith(sessionsRoot({ env })));
  assert.deepEqual(written, []);
  session.close();
});

test("opencode declares dynamicTools: true", () => {
  assert.equal(opencode.capability.dynamicTools, true);
});

test("jsonc: comments and trailing commas go, strings stay, an unterminated comment throws, and a file of 300000 trailing commas is read", () => {
  assert.deepEqual(parseJsonc('{"a":[1,2,],/*x*/"b":"//,]",}'), { a: [1, 2], b: "//,]" });
  assert.equal(stripJsonc('"a\\"//b"'), '"a\\"//b"', "an escaped quote does not end the string");
  assert.throws(() => parseJsonc("{/*"), /unterminated/);
  const hostile = `[${"[1,],".repeat(300000)}]`;
  assert.equal(parseJsonc(hostile).length, 300000);
});

// What stripJsonc was before it kept the text in stretches: one piece per character, blanking the comma in the output.
function perCharacter(text) {
  const out = [];
  let i = 0;
  let comma = -1;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
      comma = -1;
    } else if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new SyntaxError("unterminated comment");
      i = end + 2;
    } else {
      if (char === ",") comma = out.length;
      else if ((char === "}" || char === "]") && comma !== -1) {
        out[comma] = "";
        comma = -1;
      } else if (!" \t\n\r".includes(char)) comma = -1;
      out.push(char);
      i += 1;
    }
  }
  return out.join("");
}

test("jsonc: the text in stretches gives what one piece per character gave, on fixed and generated texts", () => {
  const fixed = ['{"a":[1,2,],/*x*/"b":"//,]",}', '[1,/*c*/]', '[1, // c\n]', '{"a":1,,}', '"x\\"', '"unterminated', 'a\\', "/", "/ /", "[,]", '{"k":"v"} // end', "[1,\n\n]", '["/*",]'];
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  const alphabet = ['{', '}', '[', ']', ',', '"', '/', '*', '\\', ' ', '\n', 'a', '1', ':'];
  const generated = Array.from({ length: 3000 }, () => Array.from({ length: 1 + (next() % 24) }, () => alphabet[next() % alphabet.length]).join(""));
  for (const text of [...fixed, ...generated]) {
    let expected;
    try {
      expected = perCharacter(text);
    } catch (error) {
      assert.throws(() => stripJsonc(text), { name: error.name }, JSON.stringify(text));
      continue;
    }
    assert.equal(stripJsonc(text), expected, JSON.stringify(text));
  }
});

test("jsonc: the memory is the text's, not one piece per character (a text with no comment or comma is put in a few pieces)", () => {
  const text = `["${"x".repeat(1024 * 1024)}", ${"1 ".repeat(100000)}]`;
  const push = Array.prototype.push;
  let pushes = 0;
  Array.prototype.push = function counting(...items) {
    pushes += 1;
    return push.apply(this, items);
  };
  try {
    assert.equal(stripJsonc(text), text);
  } finally {
    Array.prototype.push = push;
  }
  assert.ok(pushes < 10, `${pushes} pieces`);
});
