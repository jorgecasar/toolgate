// The subagent reader: dialects, what is kept and dropped, the tools, and the hostile cases.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hasDescription } from "../src/assets/common.js";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SUBAGENT_TOOLS, MAX_SUBAGENT_BYTES, RESERVED_SUBAGENT_NAMES, effectiveTools, SUBAGENT_DIALECTS, parseSubagent, renderSubagent } from "../src/subagents/parse.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-subagent-")));
made.push(dir);
let count = 0;
const write = (text, name = `agent${count++}.md`) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const parse = (text, options) => parseSubagent(write(text), options);
const def = (frontmatter, body = "You review code.") => `---\n${frontmatter}\n---\n${body}\n`;

test("a Claude subagent: tools as a comma list or a YAML list, model kept, the rest dropped and listed", () => {
  const a = parse(def("name: reviewer\ndescription: Reviews code\ntools: Read, Grep,  Glob, Read\nmodel: sonnet\ncolor: red\nhooks:\n  PreToolUse: []\npermissionMode: bypassPermissions\nmcpServers:\n  x: {}\nskills: [a]"));
  assert.deepEqual([a.name, a.description, a.tools, a.model, a.kind], ["reviewer", "Reviews code", ["Read", "Grep", "Glob"], "sonnet", "subagent"]);
  assert.deepEqual(a.dropped, ["color", "hooks", "mcpServers", "permissionMode", "skills"]);
  assert.equal(a.prompt, "You review code.");
  assert.deepEqual(parse(def("description: d\ntools: [Read, mcp__github__get_issue]")).tools, ["Read", "mcp__github__get_issue"]);
});

test("without tools the subagent gets the read-only default, never every tool", () => {
  assert.equal(parse(def("description: d")).tools, null);
  assert.equal(parse(def("description: d\ntools:")).tools, null);
  for (const empty of ["[]", '""', "' , '"]) {
    assert.throws(() => parse(def(`description: d\ntools: ${empty}`)), /"tools" is empty \(list at least one tool/, `tools: ${empty} is refused, not widened`);
  }
  assert.throws(() => parse(def("description: d\ntools:\n  bash: false"), { dialect: "opencode" }), /"tools" is empty/, "a map that enables nothing is empty too");
  assert.deepEqual([...DEFAULT_SUBAGENT_TOOLS], ["Read", "Grep", "Glob"]);
  assert.deepEqual(effectiveTools(parse(def("description: d"))), ["Read", "Grep", "Glob"]);
  assert.deepEqual(effectiveTools(parse(def("description: d\ntools: Bash"))), ["Bash"], "a declared list is never widened");
  assert.ok(Object.isFrozen(DEFAULT_SUBAGENT_TOOLS));
});

test("an opencode subagent: the tools map gives the enabled tools; a disabled one is not a tool; the name is the file's", () => {
  const file = write(def("description: Writes docs\nmode: subagent\nmodel: anthropic/claude-sonnet\ntools:\n  write: true\n  bash: false\n  edit: true", "Write docs."), "agent/docs.md");
  const a = parseSubagent(file, { dialect: "opencode", relative: "agent/docs.md" });
  assert.deepEqual([a.name, a.tools, a.model, a.dropped], ["agent-docs", ["write", "edit"], "anthropic/claude-sonnet", ["mode"]]);
  assert.throws(() => parse(def("description: d\ntools:\n  bash: maybe"), { dialect: "opencode" }), /map each tool to true or false/);
  assert.throws(() => parse(def("description: d\ntools:\n  bash: false"), { dialect: "claude" }), /list of strings/);
});

test("the name: from the file, nested folders join, reserved and unsafe names are refused", () => {
  assert.equal(parse(def("description: d"), { relative: "team/qa.md" }).name, "team-qa");
  for (const name of ["general-purpose", "Explore", "PLAN", "toolgate", "index", "_index", "__proto__", "..", "a/b", "a b", "x\u001b[31m"]) {
    assert.throws(() => parse(def(`name: ${JSON.stringify(name)}\ndescription: d`)), /cannot be used as a subagent name|name/, name);
  }
  assert.throws(() => parse(def("name: 5\ndescription: d")), /"name" must be a non-empty string|cannot be used/);
  assert.ok(["general-purpose", "explore", "plan", "toolgate"].every((n) => RESERVED_SUBAGENT_NAMES.has(n)));
  assert.doesNotMatch((() => { try { parse(def('name: "x\\u001b[31mred"\ndescription: d')); } catch (err) { return err.message; } return ""; })(), /\u001b/, "the error text is printable");
});

test("required parts: a description and a prompt; the dialect must be known", () => {
  // a missing description is accepted and stored as empty (doctor reports it); a value that is not text is dropped
  for (const front of ["name: a", "name: a\ndescription: 3", 'name: a\ndescription: "   "']) {
    const agent = parse(def(front));
    assert.equal(hasDescription(agent), false, front);
    assert.equal(typeof agent.description, "string", front);
  }
  assert.equal(parse(def("name: a")).description, "");
  assert.equal(hasDescription(parse(def("name: a\ndescription: d"))), true);
  assert.throws(() => parse(def("description: d", "  \n ")), /has no prompt/);
  assert.equal(hasDescription(parse("no frontmatter at all")), false, "no frontmatter is no description, not an error");
  assert.throws(() => parse(def("description: d"), { dialect: "codex" }), /unknown subagent dialect "codex" \(use claude, opencode\)/);
  assert.deepEqual([...SUBAGENT_DIALECTS], ["claude", "opencode"]);
});

test("tool names are plain text, short, and not too many; model is an id", () => {
  assert.throws(() => parse(def('description: d\ntools: ["Read\\u001b[31m"]')), /tool name that is not plain text/);
  assert.throws(() => parse(def('description: d\ntools: ["a\\nb"]')), /not plain text/);
  assert.throws(() => parse(def(`description: d\ntools: [${JSON.stringify("x".repeat(201))}]`)), /not plain text/);
  assert.equal(parse(def(`description: d\ntools: [${JSON.stringify("x".repeat(200))}]`)).tools[0].length, 200);
  for (const hidden of ["Read\u202e", "Re\u200bad", "a\u00adb", "x\u{e0041}", "Bash(git:*)\u0085"]) {
    assert.throws(() => parse(def(`description: d\ntools: [${JSON.stringify(hidden)}]`)), /not plain text/, JSON.stringify(hidden));
  }
  assert.throws(() => parse(def(`description: d\ntools: ${JSON.stringify(Array.from({ length: 101 }, (_, i) => `T${i}`))}`)), /more than 100 tools/);
  assert.throws(() => parse(def("description: d\ntools: [1]")), /list of strings/);
  for (const model of ["a b", "x‮", `${"m".repeat(101)}`, "[1]"]) {
    assert.throws(() => parse(def(`description: d\nmodel: ${JSON.stringify(model)}`)), /must be a model id/, model);
  }
  assert.throws(() => parse(def("description: d\nmodel: 7")), /must be a model id/);
});

test("servers: declared mcps win, otherwise the prompt's Required MCPs section", () => {
  assert.deepEqual(parse(def("description: d\nmcps: [github]")).mcps, ["github"]);
  assert.deepEqual(parse(def("description: d", "Do it.\n\n## Required MCPs\n- github\n")).mcps, ["github"]);
  assert.deepEqual(parse(def("description: d")).mcps, []);
});

test("the prompt is kept as written: no rewriting of shell or file syntax, which the agent never expands in a system prompt", () => {
  const a = parse(def("description: d", "Run !`git log` and read @src/a.js with $ARGUMENTS."));
  assert.equal(a.prompt, "Run !`git log` and read @src/a.js with $ARGUMENTS.");
});

test("hostile files: a size cap, YAML that would build objects, BOM and CRLF", () => {
  const big = write(def("description: d", "x".repeat(MAX_SUBAGENT_BYTES)));
  assert.throws(() => parseSubagent(big), /larger than 65536 bytes/);
  assert.throws(() => parse("---\ndescription: !!js/function 'function(){}'\n---\nbody\n"), /./);
  assert.equal(parse("---\ndescription: &a [*a]\n---\nbody\n").description, "", "a self-referencing value is dropped, not carried");
  const crlf = parse("﻿---\r\ndescription: d\r\ntools: Read\r\n---\r\nPrompt line\r\n");
  assert.deepEqual([crlf.description, crlf.tools, crlf.prompt], ["d", ["Read"], "Prompt line"]);
  assert.throws(() => parseSubagent(path.join(dir, "missing.md")), /ENOENT/);
});

test("the neutral copy round trips: the effective tools are written, a default is marked and stays a default", () => {
  const source = parse(def("name: qa\ndescription: 'QA: checks things'\ntools: Read, Grep\nmodel: opus\ntags: [x]\nmcps: [github]\nhooks: {}", "Check the work.\n\nSecond paragraph."));
  const text = renderSubagent(source);
  assert.match(text, /^---\nname: "qa"\ndescription: "QA: checks things"\ntools: \["Read","Grep"\]\nmodel: "opus"\ntags: \["x"\]\nmcps: \["github"\]\n---\n\nCheck the work\./);
  assert.doesNotMatch(text, /hooks|tools-default/);
  const again = parseSubagent(write(text));
  const { path: _a, dropped: _d, ...left } = source;
  const { path: _b, dropped: back, ...right } = again;
  assert.deepEqual(right, left);
  assert.deepEqual(back, []);

  const open = renderSubagent(parse(def("description: d")));
  assert.match(open, /\ntools: \["Read","Grep","Glob"\]\ntools-default: true\n/);
  const reread = parseSubagent(write(open));
  assert.equal(reread.tools, null, "a default written by toolgate is not a declared list");
  assert.equal(renderSubagent(reread), open, "rendering again changes nothing");
  // A copy that someone edited to list tools and still says default is a default: it cannot widen by itself.
  assert.deepEqual(reread.dropped, [], "the marker of a default is a kept key");
  assert.equal(parseSubagent(write(open.replace('["Read","Grep","Glob"]', '["Bash","Write"]'))).tools, null);
});
test("a source that lists tools and also says tools-default: the default stands (it never widens) and the list it wrote is reported as dropped", () => {
  const other = parse(def("description: d\ntools: [Bash, Write]\ntools-default: true"));
  assert.equal(other.tools, null);
  assert.deepEqual(other.dropped, ["tools"]);
  const same = parse(def("description: d\ntools: [Glob, Read, Grep]\ntools-default: true"));
  assert.equal(same.tools, null);
  assert.deepEqual(same.dropped, [], "the exact default is what toolgate itself writes: nothing was ignored");
  const unreadable = parse(def('description: d\ntools: ["a\\nb"]\ntools-default: true'));
  assert.equal(unreadable.tools, null);
  assert.deepEqual(unreadable.dropped, ["tools"]);
  const withOther = parse(def("description: d\nhooks: {}\ntools: [Bash]\ntools-default: true"));
  assert.deepEqual(withOther.dropped, ["hooks", "tools"]);
  assert.deepEqual(parse(def("description: d\ntools: [Bash]")).dropped, [], "without the mark the list is simply the tools");
  assert.deepEqual(parse(def("description: d\ntools-default: true")).dropped, [], "a mark with no list ignores nothing");
});

test("tool names take the forms a command's allowed-tools takes (a scoped Bash, a server pattern); server names stay plain (a definition of a cloned repository cannot name a pattern for a server)", () => {
  for (const tools of ["Bash(git:*)", "Bash(git add:*), Read", "mcp__ok__*", "mcp__ok", "Read, mcp__ok__get_issue", "WebFetch(domain:example.com)", "*", "a/b", "x y"]) {
    const parsed = parse(def(`description: d\ntools: ${JSON.stringify(tools)}`));
    assert.deepEqual(parsed.tools, tools.split(",").map((t) => t.trim()), tools);
  }
  assert.deepEqual(parse(def('description: d\ntools: ["Bash(git:*)", "mcp__ok__*"]')).tools, ["Bash(git:*)", "mcp__ok__*"], "a YAML list too");
  assert.deepEqual(parse(def('description: d\ntools: ["Bash(a(b)c:*)"]')).tools, ["Bash(a(b)c:*)"], "nested and balanced is fine");
  // A comma in the string form cuts a scoped tool in two: the pieces have a parenthesis open or closed too early.
  for (const tools of ['"Bash(git add,commit:*)"', '"Read)"', '"(Read"', '"Bash(a))("', '["Bash(git"]', '["a)"]']) {
    assert.throws(() => parse(def(`description: d\ntools: ${tools}`)), /tool name that is not plain text/, tools);
  }
  for (const tools of ["a\nb", "Bash(git:*\u001b)"]) {
    assert.throws(() => parse(def(`description: d\ntools: ${JSON.stringify(tools)}`)), /tool name that is not plain text/, JSON.stringify(tools));
  }
  for (const server of ["*", "x y", "x\nbash: allow", "a/b", "a*"]) {
    assert.throws(() => parse(def(`description: d\nmcps: [${JSON.stringify(server)}]`)), /a server name is not a plain name/, server);
  }
  assert.deepEqual(parse(def("description: d\nmcps: [github, my-server.v2]")).mcps, ["github", "my-server.v2"]);
});
test("a copy of a subagent without a description does not write an empty one", () => {
  const copy = renderSubagent(parse(def("name: a")));
  assert.doesNotMatch(copy, /^description:/m);
  assert.equal(hasDescription(parse(copy)), false, "and it reads back as without");
  assert.match(renderSubagent(parse(def("name: a\ndescription: d"))), /^description: "d"$/m);
});
