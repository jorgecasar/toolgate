// The hook reader: the one shape that is accepted, what is dropped, and the hostile cases.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOK_EVENTS, MAX_ARGS, MAX_HANDLERS, MAX_HOOK_FILE_BYTES, MAX_UNIT_FILES, parseHook, renderHook } from "../src/hooks/parse.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-hook-")));
made.push(root);
let count = 0;
const handler = (extra = {}) => ({ type: "command", event: "PreToolUse", matcher: "Bash", command: "scripts/check.sh", args: ["--strict"], ...extra });
// A unit folder with HOOK.json and the files given.
function unit(hook, files = { "scripts/check.sh": "#!/bin/sh\nexit 0\n" }, name = `unit${count++}`) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  fs.writeFileSync(path.join(dir, "HOOK.json"), typeof hook === "string" ? hook : JSON.stringify(hook));
  return dir;
}
const ok = (hook, files) => parseHook(unit({ description: "Checks commands", handlers: [handler()], ...hook }, files));
const refused = (hook, pattern, files) => assert.throws(() => parseHook(unit({ description: "d", handlers: [handler()], ...hook }, files)), pattern, JSON.stringify(hook).slice(0, 80));

test("a hook: handlers in exec form whose command is a file of the unit, the name from the folder, the dropped keys listed", () => {
  const hook = ok({ name: "guard", handlers: [handler({ timeout: 30, if: "Bash(git *)", async: true, statusMessage: "x" }), { type: "http", url: "https://x" }, { type: "prompt", prompt: "p" }], extra: 1, hooks: {} });
  assert.deepEqual([hook.name, hook.description, hook.kind], ["guard", "Checks commands", "hook"]);
  assert.deepEqual(hook.handlers, [{ event: "PreToolUse", matcher: "Bash", if: "Bash(git *)", command: "scripts/check.sh", args: ["--strict"], timeout: 30 }]);
  assert.deepEqual(hook.dropped, ["async", "extra", "handler:http", "handler:prompt", "hooks", "statusMessage"]);
  assert.deepEqual(hook.files, ["HOOK.json", "scripts/check.sh"]);
  const fromFolder = parseHook(unit({ description: "d", handlers: [handler({ command: "node", args: ["-v"] })] }, {}, "folder-name"));
  assert.equal(fromFolder.name, "folder-name");
  assert.equal(parseHook(unit({ description: "d", handlers: [handler({ command: "node", args: [] })] }, {}), { relative: "from-relative" }).name, "from-relative", "relative is the name when the file has none");
});

test("the program is a bare name or a file of the unit; shell form and placeholders are refused", () => {
  assert.equal(ok({ handlers: [handler({ command: "node", args: ["a.js"] })] }).handlers[0].command, "node");
  refused({ handlers: [{ type: "command", event: "Stop", command: "echo hi" }] }, /shell form is not accepted/);
  refused({ handlers: [handler({ command: "echo hi", args: [] })] }, /bare program name or a relative path inside the unit/);
  for (const command of ["../x.sh", "/bin/sh", "a/../x.sh", "./x.sh", "a//b", "a\\b", "x;y", "scripts/", "$HOME/x"]) {
    refused({ handlers: [handler({ command, args: [] })] }, /bare program name|holds a placeholder/, undefined);
  }
  for (const command of ["${CLAUDE_PLUGIN_ROOT}/x.sh", "$(whoami)", "`id`"]) refused({ handlers: [handler({ command, args: [] })] }, /placeholder or substitution/);
  for (const arg of ["${HOME}", "$(id)", "$HOME", "`id`", "%PATH%", "x$USER", "--dir=$PWD"]) refused({ handlers: [handler({ args: [arg] })] }, /holds a placeholder, variable or substitution/);
  for (const arg of ["^foo$", "100%", "a$1", "$", "--price=5$", "%d items", "50% off"]) assert.equal(ok({ handlers: [handler({ args: [arg] })] }).handlers[0].args[0], arg, `${arg} is plain text`);
  for (const command of [".", "..", "...", "$HOME"]) refused({ handlers: [handler({ command, args: [] })] }, /bare program name|holds a placeholder/);
  assert.equal(ok({ handlers: [handler({ command: "python3.12", args: [] })] }).handlers[0].command, "python3.12");
  assert.equal(ok({ handlers: [handler({ command: ".hidden", args: [] })] }).handlers[0].command, ".hidden", "a name that only starts with a dot is a name");
  refused({ handlers: [handler({ command: "scripts/missing.sh" })] }, /is not a file of the unit/);
  refused({ handlers: [handler({ args: "--strict" })] }, /shell form is not accepted/);
  refused({ handlers: [handler({ args: [5] })] }, /an arg must be plain text/);
});

test("the event is one Claude Code documents, and every documented one is accepted", () => {
  assert.ok(HOOK_EVENTS.includes("PreToolUse") && HOOK_EVENTS.includes("SessionEnd") && HOOK_EVENTS.length === 33);
  for (const event of HOOK_EVENTS) assert.equal(ok({ handlers: [handler({ event })] }).handlers[0].event, event, event);
  for (const event of ["pretooluse", "Whatever", "", undefined, 5]) refused({ handlers: [handler({ event })] }, /is not a hook event Claude Code documents/, undefined);
});

test("only command handlers count: a hook with nothing else to run is refused", () => {
  refused({ handlers: [{ type: "http", url: "x" }, { type: "agent" }] }, /no handler is a command in exec form/);
  refused({ handlers: [] }, /non-empty "handlers" list/);
  refused({ handlers: "x" }, /non-empty "handlers" list/);
  refused({ handlers: [5] }, /a handler must be an object/);
  refused({ handlers: [null] }, /a handler must be an object/);
});

test("names: plain, not reserved", () => {
  for (const name of ["index", "_index", "__proto__", "toolgate", "..", "a/b", "a b", "x\u001b[31m", 5]) refused({ name }, /cannot be used as a hook name/);
});

test("text fields are plain and short; timeout is a whole number of seconds", () => {
  refused({ description: "" }, /needs a "description"/);
  refused({ description: "a\nb" }, /needs a "description"/);
  refused({ description: "x".repeat(513) }, /needs a "description"/);
  refused({ handlers: [handler({ matcher: "a\u001b[31m" })] }, /"matcher" must be plain text/);
  refused({ handlers: [handler({ if: "x".repeat(513) })] }, /"if" must be plain text/);
  refused({ handlers: [handler({ args: ["a\nb"] })] }, /an arg must be plain text/);
  for (const timeout of [0, -1, 601, 1.5, "30", null]) refused({ handlers: [handler({ timeout })] }, /"timeout" must be a whole number/);
  assert.equal(ok({ handlers: [handler({ timeout: 600 })] }).handlers[0].timeout, 600);
  assert.equal(ok({ handlers: [handler({ args: [""] })] }).handlers[0].args[0], "", "an empty argument is an argument");
});

test("caps: handlers, args, HOOK.json, files of the unit", () => {
  refused({ handlers: Array.from({ length: MAX_HANDLERS + 1 }, () => handler()) }, /more than 16 handlers/);
  assert.equal(ok({ handlers: Array.from({ length: MAX_HANDLERS }, () => handler()) }).handlers.length, 16);
  refused({ handlers: [handler({ args: Array.from({ length: MAX_ARGS + 1 }, () => "a") })] }, /more than 32 args/);
  assert.throws(() => parseHook(unit(JSON.stringify({ description: "d", handlers: [handler()], pad: "x".repeat(MAX_HOOK_FILE_BYTES) }))), /HOOK.json is larger than/);
  const files = Object.fromEntries(Array.from({ length: MAX_UNIT_FILES + 1 }, (_, i) => [`f${i}.txt`, "x"]));
  assert.throws(() => parseHook(unit({ description: "d", handlers: [handler({ command: "node", args: [] })] }, files)), /more than 20 files/);
  assert.throws(() => parseHook(unit({ description: "d", handlers: [handler({ command: "node", args: [] })] }, { "big.bin": "x".repeat(1024 * 1024 + 1) })), /larger than 1048576 bytes/);
});

test("hostile units: symlinks anywhere, a missing or broken HOOK.json, __proto__, a link as the unit", () => {
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "x.sh"), "evil");
  const withLink = unit({ description: "d", handlers: [handler()] });
  fs.symlinkSync(path.join(outside, "x.sh"), path.join(withLink, "scripts/linked.sh"));
  assert.throws(() => parseHook(withLink), /scripts\/linked\.sh is a symlink and symlinks are not followed/);
  const dirLink = unit({ description: "d", handlers: [handler()] });
  fs.symlinkSync(outside, path.join(dirLink, "dir"));
  assert.throws(() => parseHook(dirLink), /dir is a symlink/);
  const asLink = path.join(root, "as-link");
  fs.symlinkSync(withLink, asLink);
  assert.throws(() => parseHook(asLink), /a symlink is not followed/);
  const noFile = path.join(root, "nofile");
  fs.mkdirSync(noFile);
  assert.throws(() => parseHook(noFile), /HOOK.json is missing/);
  assert.throws(() => parseHook(unit("{ nope")), /HOOK.json is not valid JSON/);
  assert.throws(() => parseHook(unit("[]")), /HOOK.json must hold an object/);
  assert.throws(() => parseHook(unit("null")), /HOOK.json must hold an object/);
  const proto = parseHook(unit('{"__proto__":{"polluted":1},"description":"d","handlers":[{"type":"command","event":"Stop","command":"node","args":[]}]}'));
  assert.equal({}.polluted, undefined);
  assert.deepEqual(proto.dropped, []);
  const linkFile = unit({ description: "d", handlers: [handler()] });
  fs.rmSync(path.join(linkFile, "HOOK.json"));
  fs.symlinkSync(path.join(outside, "x.sh"), path.join(linkFile, "HOOK.json"));
  assert.throws(() => parseHook(linkFile), /HOOK.json is a symlink/);
});

test("the normalized text is stable: the same hook renders the same, whatever order its keys came in, and reads back to itself", () => {
  const a = ok({ handlers: [handler({ timeout: 9, if: "Bash(ls)" })] });
  const b = parseHook(unit('{"handlers":[{"timeout":9,"args":["--strict"],"command":"scripts/check.sh","if":"Bash(ls)","matcher":"Bash","event":"PreToolUse","type":"command"}],"description":"Checks commands"}', { "scripts/check.sh": "#!/bin/sh\nexit 0\n" }, "other-name"));
  assert.equal(renderHook({ ...a, name: "x" }), renderHook({ ...b, name: "x" }));
  const text = renderHook(a);
  assert.match(text, /^\{\n {2}"name": /);
  assert.ok(text.endsWith("}\n"));
  const dir = unit(text, { "scripts/check.sh": "#!/bin/sh\nexit 0\n" });
  assert.equal(renderHook(parseHook(dir)), text, "render -> parse -> render is the same");
  assert.deepEqual(parseHook(dir).dropped, []);
});
