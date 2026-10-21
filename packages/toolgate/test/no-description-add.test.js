// Adding a skill, command or subagent without a description says so once, on stderr, and nothing else changes:
// the stdout JSON and the exit code are the ones they were.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { git as hermeticGit } from "./support/git.js";

const made = [];
const tmp = (name) => (made.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-nodesc-${name}-`))), made.at(-1));
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const noQmd = () => {
  throw new Error("no qmd");
};
// A local git repository stands in for the remote; `files` is { relative path: text }.
function remote(files) {
  const root = tmp("remote");
  const git = (...args) => hermeticGit(root, ...args);
  git("init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return `file://${root}`;
}
function session(cwd = tmp("project")) {
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  const out = [];
  const err = [];
  const deps = {
    cwd,
    env: { HOME: tmp("home"), XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), TOOLGATE_DEFAULTS: path.join(cwd, "none.json") },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    loadConfigFn: () => ({}),
    daemon: { status: async () => ({ running: false }) },
    skills: { execFn: noQmd },
    install: { allowFile: true, cache: tmp("gitcache") },
  };
  const take = () => ({ out: out.splice(0).join(""), err: err.splice(0).join("") });
  return { cwd, deps, take };
}
const withDescription = (name) => `---\nname: ${name}\ndescription: has one\n---\nbody\n`;
const bare = (name) => `---\nname: ${name}\n---\nbody\n`;
const LINE = (noun, name, file) => `toolgate: ${noun} ${name} has no description (${file}); route and need will show it without one`;
// The notice lines of a stderr text: it also carries the usual progress lines.
const notices = (err) => err.split("\n").filter((line) => line.includes("has no description"));

// Only `skills install` has --json and --dry-run so far; for the other two the stdout is the usual text and an install writes.
const KINDS = [
  ["skills", "skill", { "skills/a/SKILL.md": withDescription("a"), "skills/b/SKILL.md": bare("b") }, "skills/b/SKILL.md", true],
  ["commands", "command", { "commands/a.md": "---\ndescription: d\n---\nbody\n", "commands/b.md": "---\nname: b\n---\nbody\n" }, "commands/b.md", false],
  ["subagents", "subagent", { "subagents/a.md": withDescription("a"), "subagents/b.md": bare("b") }, "subagents/b.md", false],
];
for (const [command, noun, files, file, structured] of KINDS) {
  test(`${command} install: one stderr line for the item without a description; stdout JSON and exit code as they were`, async () => {
    const spec = remote(files);
    const s = session();
    assert.equal(await run([command, "install", spec, "--json"], s.deps), 0);
    const { out, err } = s.take();
    assert.deepEqual(notices(err), [LINE(noun, "b", file)], "exactly one line, on stderr");
    if (structured) assert.doesNotThrow(() => JSON.parse(out), "stdout is still JSON");
    assert.doesNotMatch(out, /has no description/);
    // said once: the same install again changes nothing, so it says nothing
    assert.equal(await run([command, "install", spec, "--json"], s.deps), 0);
    assert.deepEqual(notices(s.take().err), []);
  });
  test(`${command} install: nothing when every item has a description, and nothing for a skills dry run`, async () => {
    const full = remote(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, text.replace(/^---\n(name: b\n)?---/, "---\nname: b\ndescription: d\n---").replace("name: b\n---\nbody", "name: b\ndescription: d\n---\nbody")])));
    const s = session();
    assert.equal(await run([command, "install", full, "--json"], s.deps), 0);
    assert.deepEqual(notices(s.take().err), []);
    if (!structured) return;
    const dry = session();
    assert.equal(await run([command, "install", remote(files), "--dry-run", "--json"], dry.deps), 0);
    assert.deepEqual(notices(dry.take().err), [], "a preview adds nothing, so it warns about nothing");
  });
}
for (const [command, noun, folder, text] of [
  ["commands", "command", ".claude/commands/b.md", "---\nname: b\n---\nbody\n"],
  ["subagents", "subagent", ".claude/agents/b.md", bare("b")],
]) {
  test(`${command} import: one stderr line per item brought in without a description; stdout JSON unchanged`, async () => {
    const s = session();
    fs.mkdirSync(path.dirname(path.join(s.cwd, folder)), { recursive: true });
    fs.writeFileSync(path.join(s.cwd, folder), text);
    // one with a description beside it: it is brought in without a word
    fs.writeFileSync(path.join(path.dirname(path.join(s.cwd, folder)), "a.md"), withDescription("a"));
    assert.equal(await run([command, "import", "--json"], s.deps), 0);
    const { out, err } = s.take();
    assert.deepEqual(notices(err), [LINE(noun, "b", folder)], "exactly one line, on stderr");
    assert.doesNotThrow(() => JSON.parse(out));
    assert.equal(await run([command, "import", "--json"], s.deps), 0);
    assert.deepEqual(notices(s.take().err), [], "the second import finds it unchanged and says nothing");
  });
}
