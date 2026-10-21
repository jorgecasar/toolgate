// One file that cannot be read as a skill, command or subagent is skipped and said once on stderr; the others are
// still read, and stdout and the exit codes are the ones they were.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { scanCommands, scanSkills, scanSubagents } from "../src/skills/scan.js";
import { git as hermeticGit } from "./support/git.js";

const made = [];
const tmp = (name) => (made.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-skipped-${name}-`))), made.at(-1));
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const GOOD_SKILL = "---\nname: good\ndescription: ok\n---\nbody\n";
const BAD_SKILL = "---\ndescription: no name\n---\nbody\n";
const GOOD_COMMAND = "---\nname: good\ndescription: ok\n---\nbody\n";
const BAD_COMMAND = "---\nname: bad\ndescription: d\nargument-hint: 7\n---\nbody\n";
const GOOD_AGENT = "---\nname: good\ndescription: ok\n---\nPrompt.\n";
const BAD_AGENT = "---\nname: bad\ndescription: d\ntools: []\n---\nPrompt.\n";

test("a scan skips the files it cannot read and keeps the rest: skills, commands and subagents", () => {
  const dir = tmp("scan");
  put(dir, "skills/good/SKILL.md", GOOD_SKILL);
  put(dir, "skills/bad/SKILL.md", BAD_SKILL);
  put(dir, "cmds/good.md", GOOD_COMMAND);
  put(dir, "cmds/bad.md", BAD_COMMAND);
  put(dir, "agents/good.md", GOOD_AGENT);
  put(dir, "agents/bad.md", BAD_AGENT);
  const skills = scanSkills([{ dir: path.join(dir, "skills") }]);
  const commands = scanCommands([{ dir: path.join(dir, "cmds") }]);
  const subagents = scanSubagents([{ dir: path.join(dir, "agents") }]);
  for (const [found, noun] of [[skills, "skill"], [commands, "command"], [subagents, "subagent"]]) {
    assert.deepEqual(found.map((item) => item.name), ["good"], noun);
    assert.equal(found.skipped.length, 1, noun);
    assert.match(found.skipped[0].file, /bad/, noun);
    assert.doesNotMatch(found.skipped[0].reason, /^\//, "the reason does not start with the file");
  }
  assert.deepEqual(Object.keys(skills), ["0"], "the skipped list is not an element or an own key of the array");
  // a problem with a source itself is still fatal
  assert.throws(() => scanSkills([{ dir: path.join(dir, "nowhere") }]), /not found/);
  put(dir, "dup/a/SKILL.md", GOOD_SKILL);
  put(dir, "dup/b/SKILL.md", GOOD_SKILL);
  assert.throws(() => scanSkills([{ dir: path.join(dir, "dup") }]), /duplicate skill name/);
});

function session(config = {}) {
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  const out = [];
  const err = [];
  const deps = {
    cwd,
    env: { HOME: tmp("home"), XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), TOOLGATE_DEFAULTS: path.join(cwd, "none.json") },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    loadConfigFn: () => config,
    daemon: { status: async () => ({ running: false }) },
    skills: { execFn: () => "" },
  };
  return { cwd, deps, take: () => ({ out: out.splice(0).join(""), err: err.splice(0).join("") }) };
}
const lines = (err) => err.split("\n").filter((line) => line.includes("was skipped"));

// A qmd that remembers the folder passed to `collection add` and reports it back on `show`.
function fakeQmd() {
  let corpus = null;
  return (bin, args) => {
    if (args[1] === "add") corpus = args[2];
    if (args[1] !== "show") return "";
    if (corpus === null) throw new Error(`Collection not found: ${args[2]}`);
    return `Collection: ${args[2]}\n  Path:     ${corpus}\n`;
  };
}
test("skills index: one stderr line per skipped file of each kind, the good ones are indexed, exit 0, nothing on stdout about it", async () => {
  const config = { skills: { sources: [{ dir: "src" }] }, commands: { sources: [{ dir: "cmds" }] }, subagents: { sources: [{ dir: "agents" }] } };
  const t = session(config);
  t.deps.skills = { execFn: fakeQmd() };
  put(t.cwd, "src/good/SKILL.md", GOOD_SKILL);
  put(t.cwd, "src/bad/SKILL.md", BAD_SKILL);
  put(t.cwd, "cmds/good.md", GOOD_COMMAND);
  put(t.cwd, "cmds/bad.md", BAD_COMMAND);
  put(t.cwd, "agents/good.md", GOOD_AGENT);
  put(t.cwd, "agents/bad.md", BAD_AGENT);
  const code = await run(["skills", "index"], t.deps);
  const { out, err } = t.take();
  assert.equal(code, 0, err);
  const found = lines(err);
  assert.equal(found.length, 3, found.join("\n"));
  // the file is shown relative to the project
  assert.equal(found.find((line) => line.startsWith("toolgate: skill ")), 'toolgate: skill src/bad/SKILL.md was skipped: frontmatter is missing "name"; run "toolgate doctor"');
  assert.match(found.find((line) => line.startsWith("toolgate: command ")) ?? "", /^toolgate: command cmds\/bad\.md was skipped: .*argument-hint.*; run "toolgate doctor"$/);
  assert.match(found.find((line) => line.startsWith("toolgate: subagent ")) ?? "", /^toolgate: subagent agents\/bad\.md was skipped: .*tools.*; run "toolgate doctor"$/);
  assert.doesNotMatch(out, /was skipped/, "nothing on stdout");
  assert.match(out, /indexed 1 skill, 1 command and 1 subagent/, "the three good ones are indexed");
  // said once: the index is current now, nothing is scanned again
  assert.equal(await run(["skills", "index"], t.deps), 0);
  assert.deepEqual(lines(t.take().err), []);
});

// A local git repository stands in for the remote.
function remote(files) {
  const root = tmp("remote");
  const git = (...args) => hermeticGit(root, ...args);
  git("init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) put(root, file, text);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return `file://${root}`;
}
const installSession = () => {
  const t = session();
  t.deps.install = { allowFile: true, cache: tmp("gitcache") };
  t.deps.skills = { execFn: fakeQmd() };
  return t;
};
test("skills install --json: the skipped skill is one stderr line, stdout is still JSON with the same fields, exit 0", async () => {
  const t = installSession();
  assert.equal(await run(["skills", "install", remote({ "skills/good/SKILL.md": GOOD_SKILL, "skills/bad/SKILL.md": BAD_SKILL }), "--json"], t.deps), 0);
  const { out, err } = t.take();
  assert.deepEqual(lines(err), ['toolgate: skill bad was skipped: frontmatter is missing "name"; run "toolgate doctor"']);
  const report = JSON.parse(out);
  assert.deepEqual(report.skipped, [{ name: "bad", reason: 'frontmatter is missing "name"' }], "the result lists it as before");
  assert.doesNotMatch(out, /run "toolgate doctor"/);
});
for (const [command, noun, files, native, bad] of [
  ["commands", "command", { "commands/good.md": GOOD_COMMAND, "commands/bad.md": BAD_COMMAND }, ".claude/commands", BAD_COMMAND],
  ["subagents", "subagent", { "subagents/good.md": GOOD_AGENT, "subagents/bad.md": BAD_AGENT }, ".claude/agents", BAD_AGENT],
]) {
  test(`${command} install and import: one stderr line per skipped file, exit 0`, async () => {
    const t = installSession();
    assert.equal(await run([command, "install", remote(files)], t.deps), 0);
    const installed = t.take();
    assert.equal(lines(installed.err).length, 1, installed.err);
    assert.match(lines(installed.err)[0], new RegExp(`^toolgate: ${noun} bad was skipped: .*; run "toolgate doctor"$`));
    assert.doesNotMatch(installed.out, /run "toolgate doctor"/);
    const u = installSession();
    put(u.cwd, `${native}/good.md`, command === "commands" ? GOOD_COMMAND : GOOD_AGENT);
    put(u.cwd, `${native}/bad.md`, bad);
    assert.equal(await run([command, "import"], u.deps), 0);
    const imported = u.take();
    assert.equal(lines(imported.err).length, 1, imported.err);
    assert.match(lines(imported.err)[0], new RegExp(`^toolgate: ${noun} .*bad.* was skipped: .*; run "toolgate doctor"$`));
  });
}

test("the file of a skipped item is escaped in the line: no raw escape or newline reaches the terminal", async () => {
  const t = session({ commands: { sources: [{ dir: "cmds" }] } });
  t.deps.skills = { execFn: fakeQmd() };
  put(t.cwd, "cmds/good.md", GOOD_COMMAND);
  put(t.cwd, "cmds/bad\u001b[31m\nSYSTEM.md", BAD_COMMAND);
  assert.equal(await run(["skills", "index"], t.deps), 0);
  const { err } = t.take();
  assert.equal(err.includes("\u001b"), false);
  assert.equal(/^SYSTEM/m.test(err), false, "a name cannot start a line of its own");
  assert.equal(lines(err).length, 1);
});
