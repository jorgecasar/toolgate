// The lock and the staging area (#241): nothing a rewrite drops, only what is a copy aside is put back, the staging folder is
// kept out of git, and an unreadable folder does not stop a scan.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { COMMAND_KIND } from "../src/commands/install.js";
import { fingerprint } from "../src/skills/collection.js";
import { runInit } from "../src/init.js";
import { clearStaging, readLock, writeLock } from "../src/skills/install.js";
import { listSourceFiles, scanSkills } from "../src/skills/scan.js";
import { git as hermeticGit } from "./support/git.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-ls-")));
  made.push(dir);
  return dir;
};
const GOOD_SOURCE = { url: "file:///r", ref: null, commit: "c1" };
const GOOD_SKILL = { source: "file:///r", commit: "c1", path: "skills/ok", hash: "h1" };
test("readLock then writeLock keeps every entry that could not be read, as it was written, next to the valid ones", () => {
  const file = path.join(tmp(), "skills.lock.json");
  const written = {
    sources: { "file:///r": GOOD_SOURCE, "file:///bad": 5, "file:///worse": { url: 7 } },
    skills: { ok: GOOD_SKILL, junk: "x", junk2: { hash: 5 }, list: [1] },
  };
  fs.writeFileSync(file, JSON.stringify(written));
  const lock = readLock(file);
  assert.deepEqual(Object.keys(lock.skills), ["ok"]);
  assert.equal(lock.invalid.length, 5, "the warning update prints is unchanged");
  assert.deepEqual(Object.keys(lock), ["sources", "skills", "invalid"], "the shape of the lock is unchanged");
  lock.skills.newer = { ...GOOD_SKILL, hash: "h2" };
  writeLock(file, lock);
  const back = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(back.skills, { junk: "x", junk2: { hash: 5 }, list: [1], newer: { ...GOOD_SKILL, hash: "h2" }, ok: GOOD_SKILL });
  assert.deepEqual(back.sources, written.sources);
});
test("a valid entry written under the name of an unreadable one replaces it; a lock of another kind keeps its own key", () => {
  const file = path.join(tmp(), "commands.lock.json");
  fs.writeFileSync(file, JSON.stringify({ sources: {}, commands: { a: { hash: 1 }, b: "x" } }));
  const lock = readLock(file, "commands");
  lock.commands.a = GOOD_SKILL;
  writeLock(file, lock, "commands");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { sources: {}, commands: { a: GOOD_SKILL, b: "x" } });
});
test("a lock with nothing unreadable is written as before", () => {
  const file = path.join(tmp(), "l.json");
  writeLock(file, { sources: { s: GOOD_SOURCE }, skills: { b: GOOD_SKILL, a: GOOD_SKILL } });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).skills), ["a", "b"]);
  assert.deepEqual(readLock(file).invalid, []);
});
test("an install and a remove keep the entries of the lock that could not be read", async () => {
  const cwd = tmp();
  const remote = tmp();
  const git = (...args) => hermeticGit(remote, ...args);
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(remote, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(remote, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: the alpha skill\n---\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const lockFile = path.join(cwd, ".toolgate", "skills.lock.json");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ sources: { "file:///kept": 3 }, skills: { kept: { hash: [] }, junk: "x" } }));
  const err = [];
  const deps = {
    cwd,
    stdout: { write: () => {} },
    stderr: { write: (s) => err.push(s) },
    loadConfigFn: () => ({}),
    daemon: { status: async () => ({ running: false }) },
    skills: { execFn: () => "" },
    install: { allowFile: true, cache: tmp() },
  };
  assert.equal(await run(["skills", "install", `file://${remote}`], deps), 0, err.join(""));
  const after = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.deepEqual([after.skills.kept, after.skills.junk, after.sources["file:///kept"]], [{ hash: [] }, "x", 3]);
  assert.ok(after.skills.alpha, "the new entry is there too");
  assert.equal(await run(["skills", "remove", "alpha"], deps), 0, err.join(""));
  const removed = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.deepEqual([removed.skills.kept, removed.skills.junk, removed.skills.alpha], [{ hash: [] }, "x", undefined]);
});
test("clearStaging puts back a copy aside only if it is the kind a replace moves: a folder for a skill, a file for a command", () => {
  const plant = (kind) => {
    const root = tmp();
    const stagingRoot = path.join(root, ".staging");
    const run1 = path.join(stagingRoot, "99999999-abc123");
    const storeAbs = path.join(root, "skills");
    fs.mkdirSync(run1, { recursive: true });
    fs.mkdirSync(storeAbs, { recursive: true });
    return { root, stagingRoot, run1, storeAbs, kind };
  };
  const skill = plant(undefined);
  fs.writeFileSync(path.join(skill.run1, "skills-alpha.old"), "a planted file");
  fs.mkdirSync(path.join(skill.run1, "skills-beta.old"));
  fs.writeFileSync(path.join(skill.run1, "skills-beta.old", "SKILL.md"), "x");
  const recoveredSkills = clearStaging(skill.stagingRoot, { storeAbs: skill.storeAbs, locked: { alpha: {}, beta: {} } });
  assert.deepEqual(recoveredSkills, ["beta"]);
  assert.equal(fs.existsSync(path.join(skill.storeAbs, "alpha")), false, "a planted file is not put into the store");
  assert.equal(fs.statSync(path.join(skill.storeAbs, "beta")).isDirectory(), true);
  const command = plant(COMMAND_KIND);
  fs.writeFileSync(path.join(command.run1, "skills-one.old"), "one");
  fs.mkdirSync(path.join(command.run1, "skills-two.old"));
  const recoveredCommands = clearStaging(command.stagingRoot, { storeAbs: command.storeAbs, locked: { one: {}, two: {} }, kind: COMMAND_KIND });
  assert.deepEqual(recoveredCommands, ["one"]);
  assert.equal(fs.existsSync(path.join(command.storeAbs, COMMAND_KIND.fileName("two"))), false, "a folder is not a command");
});
test("a project-level skills install keeps .toolgate/.staging/ out of git, without toolgate init", async () => {
  const cwd = tmp();
  const remote = tmp();
  const git = (...args) => hermeticGit(remote, ...args);
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(remote, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(remote, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: the alpha skill\n---\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const deps = () => ({ cwd, stdout: { write: () => {} }, stderr: { write: () => {} }, loadConfigFn: () => ({}), daemon: { status: async () => ({ running: false }) }, skills: { execFn: () => "" }, install: { allowFile: true, cache: tmp() } });
  assert.equal(await run(["skills", "install", `file://${remote}`, "--dry-run"], deps()), 0);
  assert.equal(fs.existsSync(path.join(cwd, ".gitignore")), false, "a dry run writes nothing");
  assert.equal(await run(["skills", "install", `file://${remote}`], deps()), 0);
  assert.match(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"), /^\.toolgate\/\.staging\/$/m);
});
test("an unreadable folder inside a source is skipped with the skipped notice and the rest is scanned; an unreadable source is still an error", { skip: process.getuid?.() === 0 ? "root can read it" : false }, () => {
  const dir = tmp();
  const skill = (name) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill\n---\n`);
  };
  skill("alpha");
  fs.mkdirSync(path.join(dir, "locked"));
  fs.chmodSync(path.join(dir, "locked"), 0o000);
  try {
    const found = scanSkills([{ dir }]);
    assert.deepEqual(found.map((s) => s.name), ["alpha"]);
    assert.equal(found.skipped.length, 1);
    assert.equal(found.skipped[0].file, path.join(dir, "locked"));
    assert.match(found.skipped[0].reason, /EACCES|permission denied/);
    assert.throws(() => listSourceFiles({ dir }), /EACCES|permission denied/, "without a callback it is the error it was");
    assert.doesNotThrow(() => fingerprint([{ dir }], () => ""), "the index fingerprint reads past it too");
  } finally {
    fs.chmodSync(path.join(dir, "locked"), 0o755);
  }
  fs.chmodSync(dir, 0o000);
  try {
    assert.throws(() => scanSkills([{ dir }]), /./);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});
// A local git repository with one skill, and the deps of an install of it into `cwd` that collects stderr.
function installFixture(cwd) {
  const remote = tmp();
  const git = (...args) => hermeticGit(remote, ...args);
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(remote, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(remote, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: the alpha skill\n---\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const err = [];
  const out = [];
  const env = { HOME: tmp(), XDG_CONFIG_HOME: tmp() };
  const deps = { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, loadConfigFn: () => ({}), daemon: { status: async () => ({ running: false }) }, skills: { execFn: () => "" }, install: { allowFile: true, cache: tmp() } };
  return { source: `file://${remote}`, deps, err: () => err.join(""), out: () => out.join(""), env };
}
test("a .gitignore that cannot be written does not stop the install: exit 0, the whole summary, and a warning that says what to do", { skip: process.getuid?.() === 0 ? "root can write it" : false }, async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  fs.chmodSync(path.join(cwd, ".gitignore"), 0o444);
  const t = installFixture(cwd);
  assert.equal(await run(["skills", "install", t.source], t.deps), 0, t.err());
  assert.match(t.out(), /installed 1 skill/, "the summary is printed");
  assert.match(t.err(), /toolgate skills: could not add \.toolgate\/\.staging\/ to \.gitignore \(.*\); add it by hand/);
  assert.equal(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"), "node_modules/\n");
  assert.ok(fs.existsSync(path.join(cwd, ".toolgate", "skills", "alpha")), "the skill is installed");
});
test("a .gitignore that is a symlink is not written through, and the install still finishes with a warning", async () => {
  const cwd = tmp();
  const outside = path.join(tmp(), "outside.txt");
  fs.writeFileSync(outside, "outside\n");
  fs.symlinkSync(outside, path.join(cwd, ".gitignore"));
  const t = installFixture(cwd);
  assert.equal(await run(["skills", "install", t.source], t.deps), 0, t.err());
  assert.equal(fs.readFileSync(outside, "utf8"), "outside\n", "the file the link points at is untouched");
  assert.ok(fs.lstatSync(path.join(cwd, ".gitignore")).isSymbolicLink(), "the link is still a link");
  assert.match(t.err(), /could not add \.toolgate\/\.staging\/ to \.gitignore \(.*is a symlink.*\); add it by hand/);
  assert.match(t.out(), /installed 1 skill/);
});
test("a dangling .gitignore symlink is not followed either, and a user-level install does not touch .gitignore at all", async () => {
  const cwd = tmp();
  const target = path.join(tmp(), "missing.txt");
  fs.symlinkSync(target, path.join(cwd, ".gitignore"));
  const t = installFixture(cwd);
  assert.equal(await run(["skills", "install", t.source], t.deps), 0, t.err());
  assert.equal(fs.existsSync(target), false, "nothing was created through the link");
  const user = tmp();
  const u = installFixture(user);
  assert.equal(await run(["skills", "install", u.source, "--user"], u.deps), 0, u.err());
  assert.equal(fs.existsSync(path.join(user, ".gitignore")), false, "the user level has no project .gitignore to write");
  assert.ok(!/gitignore/.test(u.err()), "and says nothing about it");
});
test("the other callers of appendIgnored keep following a .gitignore link as they always did: init, init --dry-run and a local install exit 0", async () => {
  const initWith = async (cwd, options) => {
    fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    const code = await runInit({ cwd, env: { XDG_CONFIG_HOME: tmp(), XDG_CACHE_HOME: tmp(), HOME: tmp() }, stdout: { write() {} }, stderr: { write() {} }, execFn: () => { throw new Error("none"); }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, interactive: false, yes: true, backend: "regex", ...options });
    return code;
  };
  // A link to a file inside the project (dotfiles style) and one to a file outside of it.
  const inside = tmp();
  fs.writeFileSync(path.join(inside, "dot.gitignore"), "mine\n");
  fs.symlinkSync("dot.gitignore", path.join(inside, ".gitignore"));
  assert.equal(await initWith(inside, { dryRun: true }), 0, "a dry run");
  assert.equal(fs.readFileSync(path.join(inside, "dot.gitignore"), "utf8"), "mine\n", "and it writes nothing");
  assert.equal(await initWith(inside, {}), 0);
  assert.match(fs.readFileSync(path.join(inside, "dot.gitignore"), "utf8"), /^# toolgate$/m, "init writes through an in-project link, as before");
  const outsideDir = tmp();
  const victim = path.join(outsideDir, "victim");
  fs.writeFileSync(victim, "victim\n");
  const linked = tmp();
  fs.symlinkSync(victim, path.join(linked, ".gitignore"));
  assert.equal(await initWith(linked, {}), 0);
  assert.match(fs.readFileSync(victim, "utf8"), /\.toolgate\/\.staging\//, "and through an outside link: that is not this change's to decide");
  // skills install --local
  const cwd = tmp();
  const victim2 = path.join(tmp(), "victim2");
  fs.writeFileSync(victim2, "victim\n");
  fs.symlinkSync(victim2, path.join(cwd, ".gitignore"));
  const t = installFixture(cwd);
  assert.equal(await run(["skills", "install", t.source, "--local"], t.deps), 0, t.err());
  assert.match(fs.readFileSync(victim2, "utf8"), /\.toolgate\/skills\.local\//, "a local install still appends to what the link points at");
  assert.match(t.out(), /installed 1 skill/);
});
