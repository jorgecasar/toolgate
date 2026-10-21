// `commands install --dry-run` and `subagents install --dry-run` change nothing and say what they would do, as
// `skills install --dry-run` does; without it both install as before.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { git as hermeticGit } from "./support/git.js";

const made = [];
const tmp = (name) => (made.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-dryrun-${name}-`))), made.at(-1));
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const noQmd = () => {
  throw new Error("no qmd");
};
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
// Every file and folder under the roots with its content, so "nothing changed" is a deep equality.
function snapshot(...roots) {
  const files = {};
  const walk = (dir, label, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const key = `${label}:${path.relative(base, full)}`;
      if (entry.isDirectory()) {
        files[`${key}/`] = "dir";
        walk(full, label, base);
      } else files[key] = fs.readFileSync(full, "utf8");
    }
  };
  roots.forEach((root, i) => walk(root, `root${i}`, root));
  return files;
}
function session() {
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  const [home, xdg, cache, gitCache] = ["home", "xdg", "cache", "gitcache"].map(tmp);
  const out = [];
  const err = [];
  const deps = {
    cwd,
    env: { HOME: home, XDG_CONFIG_HOME: xdg, XDG_CACHE_HOME: cache, TOOLGATE_DEFAULTS: path.join(home, "none.json") },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    loadConfigFn: () => ({}),
    daemon: { status: async () => ({ running: false }) },
    skills: { execFn: noQmd },
    install: { allowFile: true, cache: gitCache },
  };
  return { cwd, deps, snap: () => snapshot(cwd, home, xdg, cache), out: () => out.join(""), err: () => err.join("") };
}
const KINDS = [
  ["commands", "command", { "commands/review.md": "---\ndescription: Review\n---\nbody\n" }, ".toolgate/commands/review.md"],
  ["subagents", "subagent", { "subagents/scout.md": "---\nname: scout\ndescription: Scouts\n---\nYou scout.\n" }, ".toolgate/subagents/scout.md"],
];
for (const [command, noun, files, copy] of KINDS) {
  for (const flags of [[], ["--local"], ["--user"]]) {
    test(`${command} install --dry-run ${flags.join(" ")}: nothing is written at any level, and it says what it would do`, async () => {
      const s = session();
      const before = s.snap();
      assert.equal(await run([command, "install", remote(files), "--dry-run", ...flags], s.deps), 0);
      assert.deepEqual(s.snap(), before, "the project, HOME and XDG are identical (the download cache aside)");
      assert.match(s.out(), new RegExp(`^toolgate: would install 1 ${noun}, would update 0, unchanged 0 from .* \\(dry run, nothing written\\)\\n`));
      assert.match(s.out(), /would be new: /);
      assert.doesNotMatch(s.out(), /index/, "no reindex for a preview");
    });
  }
  test(`${command} install without --dry-run still installs, and says so`, async () => {
    const s = session();
    assert.equal(await run([command, "install", remote(files)], s.deps), 0);
    assert.ok(fs.existsSync(path.join(s.cwd, copy)), "the copy is in the store");
    assert.ok(fs.readdirSync(path.join(s.cwd, ".toolgate")).some((file) => file.includes("lock")), "and in the lock");
    assert.match(s.out(), new RegExp(`^toolgate: installed 1 ${noun}, updated 0`));
    assert.doesNotMatch(s.out(), /dry run|would/);
  });
}
