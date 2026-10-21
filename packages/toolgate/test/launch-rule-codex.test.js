// client.injectRule for Codex: the Step 0 text goes in as `-c developer_instructions="…"` for this launch only (#268).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, capability } from "../src/adapters/codex.js";
import { validateCapability } from "../src/capability.js";
import { BUILTIN_RULE_TEMPLATE, MAX_RULE_BYTES, tomlString } from "../src/ruleText.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-lrc-")));
  made.push(dir);
  return dir;
};
const idle = { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] };
const KEY = "developer_instructions";

const run = async (options = {}, { config = {}, cwd = tmp() } = {}) => {
  const calls = [];
  const errors = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    calls.push(args);
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  await launch({ spawnFn, readFileFn: () => "", config, state: idle, projectDir: cwd, stderr: { write: (s) => errors.push(s) }, ...options });
  return { args: calls[0], errors: errors.join("") };
};

// The one TOML basic string of `-c key="…"`, read back: the reverse of tomlString, written apart from it.
function parseBasicString(argument) {
  const match = /^developer_instructions=("(?:[^"\\\n]|\\.)*")$/s.exec(argument);
  assert.ok(match, "key = one basic string, on one line");
  const body = match[1].slice(1, -1);
  return body.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/g, (_, u4, u8, ch) => {
    if (u4 || u8) return String.fromCodePoint(parseInt(u4 ?? u8, 16));
    const known = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    assert.ok(ch in known, `valid TOML escape \\${ch}`);
    return known[ch];
  });
}
const injected = (args) => parseBasicString(args[args.indexOf("-c") + 1]);

test("the capability names the config key, and a bad one is refused", () => {
  assert.equal(capability.rules.injectConfigKey, KEY);
  assert.deepEqual(validateCapability(capability), []);
  const bad = (rules) => validateCapability(Object.freeze({ ...capability, rules: Object.freeze(rules) })).join(" ");
  assert.match(bad({ kind: "projectFile", path: "x", injectConfigKey: "a.b" }), /injectConfigKey/);
  assert.match(bad({ kind: "none", injectConfigKey: KEY }), /injectConfigKey/);
  assert.match(bad({ kind: "projectFile", path: "x", injectConfigKey: KEY, injectFlag: "--x" }), /alternatives/);
});

test("with client.injectRule the built-in text is passed as -c before everything else; without it the arguments are as today", async () => {
  const text = fs.readFileSync(BUILTIN_RULE_TEMPLATE, "utf8");
  const on = await run({ prompt: "do it", agentArgs: ["--model", "x"] }, { config: { client: { injectRule: true } } });
  assert.equal(injected(on.args), text);
  assert.deepEqual([on.args[0], on.args.slice(2)], ["-c", ["--model", "x", "do it"]], "before the user's own arguments, the prompt last");
  const headless = await run({ prompt: "do it", headless: true }, { config: { client: { injectRule: true } } });
  assert.equal(headless.args[0], "exec", "after exec");
  assert.equal(headless.args[1], "-c");
  assert.equal(headless.args.at(-1), "do it");
  const off = await run({ prompt: "do it", agentArgs: ["--model", "x"] });
  assert.deepEqual(off.args, ["--model", "x", "do it"]);
  assert.deepEqual((await run({ prompt: "do it" }, { config: { client: { injectRule: false } } })).args, ["do it"]);
  assert.deepEqual((await run({ prompt: "do it" }, { config: { client: { injectRule: "true" } } })).args, ["do it"], "only true turns it on");
});

test("the user's own -c / --config developer_instructions before a -- wins; after it, it is only text", async () => {
  const config = { client: { injectRule: true } };
  const text = fs.readFileSync(BUILTIN_RULE_TEMPLATE, "utf8");
  for (const agentArgs of [["-c", `${KEY}="mine"`], ["--config", `${KEY}="mine"`], [`--config=${KEY}="mine"`], [`-c=${KEY}='mine'`], ["-c", ` ${KEY} = "mine"`]]) {
    const result = await run({ prompt: "x", agentArgs }, { config });
    assert.deepEqual(result.args, [...agentArgs, "x"], agentArgs.join(" "));
    assert.equal(result.errors, `toolgate: client.injectRule is on, but you passed -c ${KEY} yourself; the Step 0 rule was not added\n`);
  }
  const other = await run({ prompt: "x", agentArgs: ["-c", 'model="o3"'] }, { config });
  assert.equal(injected(other.args), text, "another key is not theirs");
  assert.equal(other.errors, "");
  const after = await run({ prompt: "x", agentArgs: ["--", "-c", `${KEY}="mine"`] }, { config });
  assert.equal(injected(after.args), text, "after the --");
  assert.deepEqual(after.args.slice(after.args.indexOf("--")), ["--", "-c", `${KEY}="mine"`, "x"]);
  assert.equal(after.errors, "");
});

test("an unreadable template is said and the launch goes on without the rule; rule.template is honoured", async () => {
  const cwd = tmp();
  const broken = await run({ prompt: "x" }, { config: { client: { injectRule: true }, rule: { template: path.join(cwd, "nope.md") } }, cwd });
  assert.deepEqual(broken.args, ["x"]);
  assert.match(broken.errors, /^toolgate: client.injectRule is on, but ".*nope.md" is not a readable file; launching without the Step 0 rule\n$/);
  fs.writeFileSync(path.join(cwd, "mine.md"), "MY RULE");
  assert.equal(injected((await run({ prompt: "x" }, { config: { client: { injectRule: true }, rule: { template: "mine.md" } }, cwd })).args), "MY RULE");
});

test("a hostile template round-trips as one argument: quotes, backslashes, CRLF, control characters, a lone surrogate, the 64 KiB cap", async () => {
  const cwd = tmp();
  const hostile = 'say "hi" \\ path\\to\\n\r\n\ttab \u0001 \u007f end  ünï 😀 """ \'\'\' =';
  const write = (text) => fs.writeFileSync(path.join(cwd, "r.md"), text);
  const config = { client: { injectRule: true }, rule: { template: "r.md" } };
  write(hostile);
  const one = await run({ prompt: "x" }, { config, cwd });
  assert.equal(one.args.filter((arg) => arg === "-c").length, 1);
  assert.equal(injected(one.args), hostile);
  assert.ok(!one.args[1].includes("\n") && !one.args[1].includes("\r"), "one line");
  // A lone surrogate cannot be in a UTF-8 file, so it is checked on the helper itself.
  assert.equal(parseBasicString(`${KEY}=${tomlString("a\ud800b")}`), "a�b");
  assert.equal(parseBasicString(`${KEY}=${tomlString("a\udc00")}`), "a�");
  assert.equal(parseBasicString(`${KEY}=${tomlString("😀")}`), "😀", "a pair is kept");
  // The cap: 64 KiB of text with a quote or a newline in every line is one argument under Linux's 128 KiB limit. (Escaping can double
  // the worst case, 64 KiB made only of quotes or newlines; that one still round-trips, and the limit is the operating system's.)
  const prose = ('say "this" \\ and that\n'.repeat(MAX_RULE_BYTES)).slice(0, MAX_RULE_BYTES);
  write(prose);
  const max = await run({ prompt: "x" }, { config, cwd });
  assert.equal(injected(max.args), prose);
  assert.ok(Buffer.byteLength(max.args[1]) < 128 * 1024, "under Linux's 128 KiB per argument");
  write('"'.repeat(MAX_RULE_BYTES));
  assert.equal(injected((await run({ prompt: "x" }, { config, cwd })).args), '"'.repeat(MAX_RULE_BYTES));
  write("é".repeat(MAX_RULE_BYTES / 2));
  assert.equal(injected((await run({ prompt: "x" }, { config, cwd })).args), "é".repeat(MAX_RULE_BYTES / 2));
  write("a".repeat(MAX_RULE_BYTES + 1));
  assert.deepEqual((await run({ prompt: "x" }, { config, cwd })).args, ["x"], "over the cap is not a rule");
});
