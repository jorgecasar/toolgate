// One list of the characters that hide or reorder text, used by printable, exact, jsonSafe and the override check (#242).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { exact, hasHiddenChars, jsonSafe, printable } from "../src/assets/common.js";
import { exact as exactFromCatalog } from "../src/catalog/sanitize.js";
import { applyChange } from "../src/configFile.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { checkSkills } from "../src/doctor/checks.js";
import { parseHook } from "../src/hooks/parse.js";
import { parsePermission } from "../src/permissions/parse.js";
const HIDDEN = [0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0x206f, 0x2800, 0x3164, 0xfe00, 0xfe0d, 0xfeff, 0xffa0, 0xfff9, 0xfffb, 0xe0001, 0xe0041, 0xe007f, 0xe0100, 0xe01ef, 0x85, 0x7f, 0x1b];
const SHOWN = ["é", "é", "‌", "‍", "\u{1F468}‍\u{1F469}", "❤️", "❤︎", "日本語", "ñ", " ", "a\tb"];
const esc = (code) => (code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`);
test("printable escapes every hidden character as one escape, and keeps accents, the joiners and the emoji selectors", () => {
  for (const code of HIDDEN) assert.equal(printable(`a${String.fromCodePoint(code)}b`), `a${esc(code)}b`, code.toString(16));
  for (const text of SHOWN.filter((t) => t !== "a\tb")) assert.equal(printable(text), text, JSON.stringify(text));
  assert.equal(printable("a\tb\nc\rd"), "a\\tb\\nc\\rd");
  assert.equal(printable("a\ud800b"), "a\\ud800b", "a lone surrogate");
  assert.equal(printable("\u{1F600}"), "\u{1F600}", "a whole surrogate pair is fine");
  assert.equal(printable(undefined), "undefined");
});
test("exact escapes everything printable does, and the joiners, every variation selector and the no-break space too; astral characters keep their own code", () => {
  for (const code of [...HIDDEN, 0x200c, 0x200d, 0xfe0e, 0xfe0f, 0x00a0, 0xfdd0, 0xfffe, 0xe0100, 0xe01ef, 0xe0001]) {
    if (code === 0x1b || code === 0x85 || code === 0x7f) continue;
    assert.equal(exact(`a${String.fromCodePoint(code)}b`), `"a${esc(code)}b"`, code.toString(16));
  }
  assert.equal(exact("\u{e0041}"), '"\\u{e0041}"');
  assert.notEqual(exact("\u{e0041}"), exact("\u{e0042}"));
  assert.equal(exact("a\nb\u001b"), '"a\\nb\\u001b"');
  assert.equal(exact("é"), '"é"');
  assert.equal(exactFromCatalog, exact, "the catalog uses the same function");
});
test("jsonSafe escapes the hidden characters of JSON output and leaves it valid JSON that reads back the same", () => {
  const value = { name: "a‮b", note: "x\u{e0041}y\u0085z⠀", ok: "é‍", list: ["﻿", "­"] };
  const text = jsonSafe(JSON.stringify(value, null, 2));
  assert.deepEqual(JSON.parse(text), value);
  assert.ok(!/[‮\u0085⠀﻿­]|\u{e0041}/u.test(text), "none is left raw");
  assert.match(text, /\\u202e/);
  assert.match(text, /\\udb40\\udc41/, "an astral character is a surrogate pair");
  assert.ok(text.includes("\n  \"name\""), "the layout is kept");
  assert.equal(jsonSafe('{"a":"‍ é"}'), '{"a":"‍ é"}', "joiners and accents stay");
});
test("hasHiddenChars: controls and hidden characters, not the joiners or accents", () => {
  for (const code of HIDDEN) assert.equal(hasHiddenChars(`a${String.fromCodePoint(code)}`), true, code.toString(16));
  assert.equal(hasHiddenChars("a\u0001"), true);
  for (const text of SHOWN.filter((t) => t !== "a\tb")) assert.equal(hasHiddenChars(text), false, JSON.stringify(text));
});
test("an override refuses bidi controls, zero-width characters, the BOM and lone surrogates, with the text it always had", () => {
  const set = (value) => applyChange({}, { action: "set", key: "skills.overrides", value: [value], layer: "user" });
  const message = /skills\.overrides/;
  for (const bad of ["a‮b", "a​b", "a﻿b", "a\ud800b", "a⁦b", "a⠀b", "a\u0085b", "a b", "a\nb"]) {
    assert.throws(() => set({ skill: "s", description: bad }), message, JSON.stringify(bad));
    assert.throws(() => set({ skill: bad, tags: ["t"] }), message);
    assert.throws(() => set({ skill: "s", tags: [bad] }), message);
    assert.throws(() => set({ skill: "s", mcps: [bad] }), message);
  }
  assert.equal(set({ skill: "s", description: "plain é 日本 \u{1F468}‍\u{1F469}" }), true);
});
test("the subagents that are not found are printed escaped, not raw, when a hostile name comes from the state file", async () => {
  const errors = [];
  const hostile = "gh‮ost\u001b[31m\u{e0041}";
  await run(["--no-route", "go"], {
    cwd: process.cwd(),
    stdout: { write: () => {} },
    stderr: { write: (s) => errors.push(s) },
    env: { TOOLGATE_ADAPTER: "claude-code", HOME: process.cwd(), TOOLGATE_DEFAULTS: "/nonexistent/none.json" },
    loadConfigFn: () => ({ subagents: { baseline: [hostile] } }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }),
    saveStateFn: () => {},
    adapters: { "claude-code": () => Promise.resolve({ capability: { subagents: { kind: "launchFlag" } }, launch: () => Promise.resolve({ code: 0 }) }) },
  });
  const line = errors.join("").split("\n").find((l) => l.includes("subagents not found"));
  assert.equal(line, "toolgate: subagents not found in the sources, so not registered: gh\\u202eost\\u001b[31m\\u{e0041}");
});
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-ic-")));
  made.push(dir);
  return dir;
};
const REFUSED = ["a\u00adb", "a\u034fb", "a\u2800b", "a\u3164b", "a\u202eb", "a\u200bb", "a\ufeffb", "a\u{e0041}b", "a\ud800b"];
const ALLOWED = ["a\u200db", "a\u200cb", "a\u00a0b", "a\ufe0fb", "caf\u00e9"];
test("hooks: a handler arg, matcher, if or description with a hidden character is refused at parse, and the joiners, NBSP and accents are accepted", () => {
  const unit = (handler, description = "Checks commands") => {
    const dir = path.join(tmp(), "u");
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(path.join(dir, "HOOK.json"), JSON.stringify({ description, handlers: [{ type: "command", event: "PreToolUse", matcher: "Bash", command: "scripts/check.sh", args: ["--strict"], ...handler }] }));
    return dir;
  };
  for (const text of REFUSED) {
    assert.throws(() => parseHook(unit({ args: [text] })), /an arg must be plain text/, `arg ${JSON.stringify(text)}`);
    assert.throws(() => parseHook(unit({ matcher: text })), /"matcher" must be plain text/, `matcher ${JSON.stringify(text)}`);
    assert.throws(() => parseHook(unit({ if: text })), /"if" must be plain text/, `if ${JSON.stringify(text)}`);
    assert.throws(() => parseHook(unit({}, text)), /plain text/, `description ${JSON.stringify(text)}`);
  }
  for (const text of ALLOWED) assert.equal(parseHook(unit({ args: [text], matcher: text })).handlers[0].args[0], text, JSON.stringify(text));
});
test("permissions: a rule or description with a hidden character is refused at parse, and the joiners, NBSP and accents are accepted", () => {
  const file = (data) => {
    const f = path.join(tmp(), "p.json");
    fs.writeFileSync(f, JSON.stringify({ description: "Narrows the agent", deny: ["Read"], ...data }));
    return f;
  };
  for (const text of REFUSED) {
    assert.throws(() => parsePermission(file({ deny: [`Bash(echo ${text})`] })), /rule must be plain text/, `rule ${JSON.stringify(text)}`);
    assert.throws(() => parsePermission(file({ ask: [text] })), /plain text/, `ask ${JSON.stringify(text)}`);
    assert.throws(() => parsePermission(file({ description: text })), /plain text|description/, `description ${JSON.stringify(text)}`);
  }
  for (const text of ALLOWED) assert.deepEqual(parsePermission(file({ deny: [`Bash(echo ${text})`] })).deny, [`Bash(echo ${text})`], JSON.stringify(text));
});
test("doctor prints a refused override with its hidden characters escaped, not raw", () => {
  const hostile = { skill: "a\u202eb\u00adc\u0085d\u{e0041}", description: "x\u2800" };
  const env = { HOME: tmp(), XDG_CONFIG_HOME: tmp() };
  const findings = checkSkills({ cwd: tmp(), config: { skills: { invalidOverrides: [{ layer: "user", entry: hostile }] } }, env, homedir: tmp() });
  const found = findings.filter((f) => f.id === "skills.overrides");
  assert.equal(found.length, 1);
  assert.ok(!/[\u202e\u00ad\u0085\u2800]|\u{e0041}/u.test(found[0].message), "nothing hidden is left raw");
  assert.match(found[0].message, /a\\u202eb\\u00adc\\u0085d\\udb40\\udc41/);
});
