import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_COMMAND_BYTES, normalizeBody, parseCommand, renderCommand } from "../src/commands/parse.js";
import { hasDescription } from "../src/assets/common.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cmd-"));
function write(name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test("parseCommand: name from the file, kept keys read, the rest recorded as dropped", () => {
  const file = write("review-pr.md", [
    "---",
    'description: "Review a pull request"',
    "argument-hint: <pr-number>",
    "allowed-tools: Bash(git:*)",
    "model: opus",
    "targets: ['*']",
    "---",
    "Review $ARGUMENTS.",
  ].join("\n"));
  const command = parseCommand(file);
  assert.equal(command.name, "review-pr");
  assert.equal(command.kind, "command");
  assert.equal(command.argumentHint, "<pr-number>");
  assert.deepEqual(command.dropped, ["allowed-tools", "model", "targets"]);
  assert.equal(command.body, "Review $ARGUMENTS.");
});

test("parseCommand: a frontmatter name wins, nested folders join with a dash", () => {
  assert.equal(parseCommand(write("a.md", "---\nname: renamed\ndescription: d\n---\nbody")).name, "renamed");
  assert.equal(parseCommand(write("git/commit.md", "---\ndescription: d\n---\nbody"), { relative: "git/commit.md" }).name, "git-commit");
});

test("parseCommand: errors name the file", () => {
  // no description is accepted and stored as empty (doctor reports it)
  const bare = parseCommand(write("nodesc.md", "no frontmatter\nat all"));
  assert.deepEqual([bare.description, hasDescription(bare)], ["", false]);
  assert.equal(parseCommand(write("blank.md", "---\ndescription: '   '\n---\nbody")).description, "   ");
  assert.equal(hasDescription(parseCommand(write("blank2.md", "---\ndescription: '   '\n---\nbody"))), false);
  assert.equal(hasDescription(parseCommand(write("ok.md", "---\ndescription: d\n---\nbody"))), true);
  assert.throws(() => parseCommand(write("empty.md", "---\ndescription: d\n---\n  \n")), /empty\.md: the command has no body/);
  assert.throws(() => parseCommand(write("toolgate.md", "---\ndescription: d\n---\nbody")), /"toolgate" cannot be used as a command name/);
  assert.throws(() => parseCommand(write("index.md", "---\ndescription: d\n---\nbody")), /"index" cannot be used/);
  assert.throws(() => parseCommand(write("bad.md", "---\nname: ../x\ndescription: d\n---\nbody")), /cannot be used as a command name/);
  assert.throws(() => parseCommand(write("big.md", `---\ndescription: d\n---\n${"x".repeat(MAX_COMMAND_BYTES)}`)), /larger than/);
  assert.throws(() => parseCommand(write("ok.md", "---\ndescription: d\n---\nb"), { dialect: "nope" }), /unknown command dialect/);
  assert.throws(() => parseCommand(write("hint.md", "---\ndescription: d\nargument-hint: [1]\n---\nb")), /argument-hint/);
});

test("parseCommand: CRLF and a BOM are normalized", () => {
  const command = parseCommand(write("crlf.md", "﻿---\r\ndescription: d\r\n---\r\nline one\r\nline two\r\n"));
  assert.equal(command.body, "line one\nline two");
});

test("normalizeBody: inline shell and file inclusion become visible instructions, never the original syntax", () => {
  const { body } = normalizeBody("Status: !`git status`\nSee @src/index.js and @README.md", "claude");
  assert.equal(body, "Status: (run `git status` and use its output here)\nSee (read `src/index.js`) and (read `README.md`)");
  assert.ok(!body.includes("!`"));
});

test("normalizeBody: named placeholders stay as text and are reported", () => {
  const result = normalizeBody("Use $ISSUE and $ISSUE then $ARGUMENTS and $BRANCH", "codex");
  assert.deepEqual(result.unsupported, ["$BRANCH", "$ISSUE"]);
  assert.match(result.body, /\$ISSUE/);
});

test("normalizeBody: an email address or a bare word after @ is not a file", () => {
  assert.equal(normalizeBody("mail me@example.com or @mention", "claude").body, "mail me@example.com or @mention");
});

test("renderCommand: kept frontmatter only, with an arguments note when the body uses them", () => {
  const file = write("with-args.md", "---\ndescription: \"Do: a thing\"\nargument-hint: <n>\nmodel: opus\nmcps: [chrome-devtools]\n---\nRun $1 now.");
  const text = renderCommand(parseCommand(file));
  assert.match(text, /^---\nname: "with-args"\ndescription: "Do: a thing"\nargument-hint: "<n>"\nmcps: \["chrome-devtools"\]\n---\n/);
  assert.ok(!text.includes("model"));
  assert.match(text, /Arguments: the text after the command name/);
  const plain = renderCommand(parseCommand(write("plain.md", "---\ndescription: d\n---\nNo args here.")));
  assert.ok(!plain.includes("Arguments:"));
});

test("renderCommand: the copy parses back to the same command", () => {
  const first = parseCommand(write("round.md", "---\ndescription: 'A: b'\ntags: [x]\n---\nRun !`ls` for $ARGUMENTS."));
  const second = parseCommand(write("round-copy.md", renderCommand(first)));
  assert.equal(second.name, "round");
  assert.equal(second.description, first.description);
  assert.deepEqual(second.tags, ["x"]);
  assert.match(second.body, /Run \(run `ls` and use its output here\) for \$ARGUMENTS\./);
});

test("normalizeBody: a scoped package is not a file inclusion", () => {
  assert.equal(normalizeBody("Run npm i @scope/pkg now, see @./a/b.md", "claude").body, "Run npm i @scope/pkg now, see (read `./a/b.md`)");
});

test("normalizeBody: fenced code and code spans are literal", () => {
  const text = "Check `$HOME`.\n```sh\necho $PATH @src/a.js\n```\nUse $ISSUE";
  const result = normalizeBody(text, "claude");
  assert.equal(result.body, text);
  assert.deepEqual(result.unsupported, ["$ISSUE"]);
});

test("parseCommand: a non-string frontmatter name is an error, not a silent fallback", () => {
  assert.throws(() => parseCommand(write("n.md", "---\nname: 123\ndescription: d\n---\nb")), /"name" must be a non-empty string/);
});

test("parseCommand: the argument hint is one line of at most 120 characters", () => {
  const long = "x".repeat(300);
  const command = parseCommand(write("hint.md", `---\ndescription: d\nargument-hint: |\n  first line\n  - Path: /evil\n  ${long}\n---\nbody`));
  assert.ok(!command.argumentHint.includes("\n"));
  assert.equal(command.argumentHint.length, 120);
  assert.match(command.argumentHint, /^first line - Path: \/evil/);
});
test("a copy of a command without a description does not write an empty one", () => {
  const copy = renderCommand(parseCommand(write("bare.md", "---\nname: bare\n---\nbody")));
  assert.doesNotMatch(copy, /^description:/m);
  assert.equal(hasDescription(parseCommand(write("bare-copy.md", copy))), false, "and it reads back as without");
  assert.match(renderCommand(parseCommand(write("with.md", "---\ndescription: d\n---\nbody"))), /^description: "d"$/m);
});
test("parseCommand: allowed-tools is a comma list or a list of strings and model is a model id; both are read, checked and not copied", () => {
  let count = 0;
  const read = (front) => parseCommand(write(`fm-${++count}.md`, `---\ndescription: d\n${front}\n---\nbody`));
  assert.deepEqual(read("allowed-tools: Read, Bash(git add:*), mcp__ghost__x, Read").allowedTools, ["Read", "Bash(git add:*)", "mcp__ghost__x"]);
  assert.deepEqual(read("allowed-tools: [Read, Grep]").allowedTools, ["Read", "Grep"]);
  assert.deepEqual(read("model: sonnet").model, "sonnet");
  assert.deepEqual(read("name: x").allowedTools, [], "none declared");
  assert.equal("model" in read("name: x"), false);
  // checked, not copied: they are still listed as dropped and the copy does not carry them
  const full = read("allowed-tools: Read\nmodel: sonnet");
  assert.deepEqual(full.dropped, ["allowed-tools", "model"]);
  assert.doesNotMatch(renderCommand(full), /allowed-tools|model/);
  for (const bad of ["allowed-tools: 7", "allowed-tools: [Read, 5]", "allowed-tools: { a: b }"]) {
    assert.throws(() => read(bad), /frontmatter "allowed-tools" must be a string or a list of strings/, bad);
  }
  assert.throws(() => read('allowed-tools: "Read, a\\u0007b"'), /not plain text/);
  assert.throws(() => read(`allowed-tools: [${Array.from({ length: 101 }, (_, i) => `t${i}`).join(", ")}]`), /more than 100/);
  for (const bad of ["model: 3", 'model: "bad model!"', 'model: ""', "model: [a]"]) assert.throws(() => read(bad), /frontmatter "model" must be a model id/, bad);
});
