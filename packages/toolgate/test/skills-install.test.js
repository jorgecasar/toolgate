import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_KIND, hashDir, installAssets, installSkills, readLock, writeLock } from "../src/skills/install.js";
import { cacheRoot, checkRef, sourceUrl } from "../src/skills/remote.js";
import { git as hermeticGit } from "./support/git.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-${name}-`));
const git = (cwd, ...args) =>
  hermeticGit(cwd, ...args);

const skillMd = (name, description = `the ${name} skill`) => `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`;

function writeSkill(root, dir, name, description) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, "SKILL.md"), skillMd(name, description));
}

// A real git repository: the install code only ever talks to git, so this exercises the real path.
function remoteRepo(layout = (root) => {
  writeSkill(root, "skills/alpha", "alpha");
  writeSkill(root, "skills/beta", "beta");
  fs.mkdirSync(path.join(root, "skills/beta/references"));
  fs.writeFileSync(path.join(root, "skills/beta/references/notes.md"), "extra file\n");
  fs.mkdirSync(path.join(root, "skills/broken"));
  fs.writeFileSync(path.join(root, "skills/broken/SKILL.md"), "---\ndescription: no name\n---\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "MIT License\n");
}) {
  const root = tmp("remote");
  git(root, "init", "-q", "-b", "main");
  layout(root);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const commit = () => git(root, "rev-parse", "HEAD").trim();
  const commitAll = (message) => {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", message);
  };
  return { root, spec: `file://${root}`, commit, commitAll };
}

function project() {
  return { projectDir: tmp("project"), cache: tmp("cache"), allowFile: true };
}
const install = (remote, env, extra = {}) => installSkills({ spec: remote.spec, ...env, ...extra });
const exists = (env, file) => fs.existsSync(path.join(env.projectDir, file));

test("sourceUrl: accepts github shorthand, https and ssh, and refuses anything that could run or read locally", () => {
  assert.equal(sourceUrl("github:addyosmani/agent-skills"), "https://github.com/addyosmani/agent-skills.git");
  assert.equal(sourceUrl("github:owner/repo.git"), "https://github.com/owner/repo.git");
  assert.equal(sourceUrl("https://example.com/team/skills.git"), "https://example.com/team/skills.git");
  assert.equal(sourceUrl("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
  assert.equal(sourceUrl("ssh://git@host/owner/repo.git"), "ssh://git@host/owner/repo.git");
  for (const bad of ["", "--upload-pack=evil", "-x", "file:///etc", "ext::sh -c id", "/tmp/local", "../x", "github:owner", "http://insecure/x.git", "ftp://x/y", "https://user:token@host/x.git", "https://token@host/x.git", "ssh://user:pw@host/x.git"]) {
    assert.throws(() => sourceUrl(bad), /not a skills source|not a supported skills source/, `"${bad}"`);
  }
  assert.equal(sourceUrl("file:///tmp/x", { allowFile: true }), "file:///tmp/x");
  assert.throws(() => sourceUrl(undefined), /not a skills source/);
});

test("checkRef: branches and tags only", () => {
  assert.equal(checkRef(undefined), undefined);
  assert.equal(checkRef("v1.2.0"), "v1.2.0");
  assert.equal(checkRef("feature/x"), "feature/x");
  for (const bad of ["-d", "a..b", "", "a b", "a;rm"]) assert.throws(() => checkRef(bad), /not a valid branch or tag/);
});

test("cacheRoot: under XDG_CACHE_HOME, else ~/.cache", () => {
  assert.equal(cacheRoot({ XDG_CACHE_HOME: "/x" }, "/h"), "/x/toolgate/sources");
  assert.equal(cacheRoot({}, "/h"), "/h/.cache/toolgate/sources");
});

test("install: copies the valid skills with their files, reports the invalid one, and writes the lock", () => {
  const remote = remoteRepo();
  const env = project();
  const result = install(remote, env);

  assert.deepEqual([result.installed, result.updated, result.unchanged], [["alpha", "beta"], [], []]);
  assert.equal(result.commit, remote.commit());
  assert.deepEqual(result.skipped.map((s) => s.name), ["broken"]);
  assert.match(result.skipped[0].reason, /missing "name"/);

  assert.match(fs.readFileSync(path.join(env.projectDir, ".toolgate/skills/alpha/SKILL.md"), "utf8"), /body of alpha/);
  assert.equal(fs.readFileSync(path.join(env.projectDir, ".toolgate/skills/beta/references/notes.md"), "utf8"), "extra file\n");
  assert.ok(!exists(env, ".toolgate/skills/broken"));

  const lock = readLock(path.join(env.projectDir, ".toolgate/skills.lock.json"));
  assert.deepEqual(Object.keys(lock.skills), ["alpha", "beta"]);
  assert.deepEqual(lock.skills.alpha, {
    source: remote.spec,
    commit: remote.commit(),
    path: "skills/alpha",
    hash: hashDir(path.join(env.projectDir, ".toolgate/skills/alpha")),
  });
  assert.equal(lock.sources[remote.spec].commit, remote.commit());
  assert.equal(lock.sources[remote.spec].path, "skills");
});

test("install: keeps the source's license next to the skills", () => {
  const remote = remoteRepo();
  const env = project();
  const result = install(remote, env);
  assert.match(result.license, /^\.toolgate[\\/]skills[\\/]\.licenses[\\/]/);
  assert.equal(fs.readFileSync(path.join(env.projectDir, result.license, "LICENSE"), "utf8"), "MIT License\n");
});

test("install again: nothing changed upstream means nothing is rewritten", () => {
  const remote = remoteRepo();
  const env = project();
  install(remote, env);
  const before = fs.statSync(path.join(env.projectDir, ".toolgate/skills/alpha/SKILL.md")).mtimeMs;
  const again = install(remote, env);
  assert.deepEqual([again.installed, again.updated, again.unchanged], [[], [], ["alpha", "beta"]]);
  assert.equal(fs.statSync(path.join(env.projectDir, ".toolgate/skills/alpha/SKILL.md")).mtimeMs, before);
});

test("install again after the source changed: only the changed skill is updated, and the lock follows", () => {
  const remote = remoteRepo();
  const env = project();
  install(remote, env);
  const first = remote.commit();

  fs.writeFileSync(path.join(remote.root, "skills/alpha/SKILL.md"), skillMd("alpha", "a better description"));
  remote.commitAll("update alpha");
  const again = install(remote, env);

  assert.deepEqual([again.installed, again.updated, again.unchanged], [[], ["alpha"], ["beta"]]);
  assert.notEqual(remote.commit(), first);
  assert.match(fs.readFileSync(path.join(env.projectDir, ".toolgate/skills/alpha/SKILL.md"), "utf8"), /a better description/);
  const lock = readLock(path.join(env.projectDir, ".toolgate/skills.lock.json"));
  assert.equal(lock.skills.alpha.commit, remote.commit());
  assert.equal(lock.sources[remote.spec].commit, remote.commit());
});

test("install: a copy edited by hand is not overwritten without --force", () => {
  const remote = remoteRepo();
  const env = project();
  install(remote, env);
  const file = path.join(env.projectDir, ".toolgate/skills/alpha/SKILL.md");
  fs.appendFileSync(file, "my note\n");
  fs.writeFileSync(path.join(remote.root, "skills/alpha/SKILL.md"), skillMd("alpha", "changed upstream"));
  remote.commitAll("update alpha");

  const blocked = install(remote, env);
  assert.deepEqual(blocked.updated, []);
  assert.match(blocked.skipped.find((s) => s.name === "alpha").reason, /edited since it was installed/);
  assert.match(fs.readFileSync(file, "utf8"), /my note/);

  const forced = install(remote, env, { force: true });
  assert.deepEqual(forced.updated, ["alpha"]);
  assert.ok(!fs.readFileSync(file, "utf8").includes("my note"));
});

test("install: a skill the user already has, or that came from another source, is not replaced without --force", () => {
  const remote = remoteRepo();
  const env = project();
  writeSkill(path.join(env.projectDir, ".toolgate/skills"), "alpha", "alpha", "my own alpha");

  const first = install(remote, env);
  assert.deepEqual(first.installed, ["beta"]);
  assert.match(first.skipped.find((s) => s.name === "alpha").reason, /not installed by toolgate/);
  assert.match(fs.readFileSync(path.join(env.projectDir, ".toolgate/skills/alpha/SKILL.md"), "utf8"), /my own alpha/);

  const other = remoteRepo((root) => writeSkill(root, "skills/beta", "beta", "the other beta"));
  const second = install(other, env);
  assert.match(second.skipped.find((s) => s.name === "beta").reason, /installed from file:\/\//);
  assert.deepEqual(install(other, env, { force: true }).updated, ["beta"]);
});

test("install: names pick skills, --exclude drops them, and an unknown name lists what is available", () => {
  const remote = remoteRepo();
  const only = project();
  assert.deepEqual(install(remote, only, { names: ["beta"] }).installed, ["beta"]);
  assert.ok(!exists(only, ".toolgate/skills/alpha"));

  const excluded = project();
  assert.deepEqual(install(remote, excluded, { exclude: ["alpha"] }).installed, ["beta"]);

  assert.throws(() => install(remote, project(), { names: ["nope"] }), /not found in .*: nope \(available: alpha, beta\)/);
});

test("install: a skill with a symlink is skipped and the others are still installed", () => {
  const outside = path.join(tmp("outside"), "secret.txt");
  fs.writeFileSync(outside, "secret");
  const remote = remoteRepo((root) => {
    writeSkill(root, "skills/good", "good");
    writeSkill(root, "skills/linked", "linked");
    fs.symlinkSync(outside, path.join(root, "skills/linked/secret.txt"));
  });
  const env = project();
  const result = install(remote, env);
  assert.deepEqual(result.installed, ["good"]);
  assert.match(result.skipped.find((s) => s.name === "linked").reason, /symlink/);
  assert.ok(!exists(env, ".toolgate/skills/linked"));
});

test("install: skill names that could escape the folder or clash with the catalog are skipped", () => {
  const remote = remoteRepo((root) => {
    writeSkill(root, "skills/one", "one");
    writeSkill(root, "skills/escape", "../escape");
    writeSkill(root, "skills/catalog", "index");
  });
  const env = project();
  const result = install(remote, env);
  assert.deepEqual(result.installed, ["one"]);
  assert.equal(result.skipped.length, 2);
  assert.ok(!fs.existsSync(path.join(env.projectDir, ".toolgate/escape")));
});

test("install: the names . and .. cannot be used, even with force, and nothing outside the skills folder is touched", () => {
  const remote = remoteRepo((root) => {
    writeSkill(root, "skills/one", "one");
    writeSkill(root, "skills/dot", ".");
    writeSkill(root, "skills/dotdot", "..");
  });
  const env = project();
  fs.mkdirSync(path.join(env.projectDir, ".toolgate/skills/keep"), { recursive: true });
  fs.writeFileSync(path.join(env.projectDir, ".toolgate/skills/keep/SKILL.md"), "mine\n");
  fs.writeFileSync(path.join(env.projectDir, ".toolgate/other.json"), "{}\n");
  for (const force of [false, true]) {
    const result = install(remote, env, { force });
    assert.deepEqual(result.skipped.map((s) => s.name).sort(), ["dot", "dotdot"]);
    assert.ok(exists(env, ".toolgate/skills/keep/SKILL.md"));
    assert.ok(exists(env, ".toolgate/other.json"));
    assert.ok(exists(env, ".toolgate/skills/one/SKILL.md"));
  }
});
test("install: two folders that declare the same skill name install only the first", () => {
  const remote = remoteRepo((root) => {
    writeSkill(root, "skills/a-first", "twin", "first");
    writeSkill(root, "skills/b-second", "twin", "second");
  });
  const env = project();
  const result = install(remote, env);
  assert.deepEqual(result.installed, ["twin"]);
  assert.match(result.skipped.find((s) => s.name === "b-second").reason, /already provided/);
  assert.match(fs.readFileSync(path.join(env.projectDir, ".toolgate/skills/twin/SKILL.md"), "utf8"), /first/);
});
test("install: names that exist on Object.prototype are not mistaken for lock entries", () => {
  const remote = remoteRepo((root) => writeSkill(root, "skills/ctor", "constructor"));
  const env = project();
  assert.deepEqual(install(remote, env).installed, ["constructor"]);
});
test("install: skills at the repository root work when there is no skills folder, and --path is honoured and confined", () => {
  const flat = remoteRepo((root) => writeSkill(root, "tdd", "tdd"));
  assert.deepEqual(install(flat, project()).installed, ["tdd"]);

  const nested = remoteRepo((root) => writeSkill(root, "packages/agent/skills/deep", "deep"));
  assert.deepEqual(install(nested, project(), { subdir: "packages/agent/skills" }).installed, ["deep"]);
  assert.throws(() => install(nested, project(), { subdir: "../.." }), /must stay inside the repository/);
  assert.throws(() => install(nested, project(), { subdir: "missing" }), /does not exist in the repository/);
  assert.throws(() => install(remoteRepo((root) => fs.writeFileSync(path.join(root, "x.txt"), "x")), project(), { subdir: undefined }), /no skills found in .* \(looked for <name>\/SKILL\.md in \.\)/);
});

test("install: a branch can be chosen with --ref", () => {
  const remote = remoteRepo();
  git(remote.root, "checkout", "-q", "-b", "next");
  writeSkill(remote.root, "skills/gamma", "gamma");
  remote.commitAll("add gamma");
  git(remote.root, "checkout", "-q", "main");

  const main = project();
  assert.deepEqual(install(remote, main).installed, ["alpha", "beta"]);
  const next = project();
  assert.deepEqual(install(remote, next, { ref: "next" }).installed, ["alpha", "beta", "gamma"]);
  assert.equal(readLock(path.join(next.projectDir, ".toolgate/skills.lock.json")).sources[remote.spec].ref, "next");
});

test("install: a source that cannot be fetched fails with git's message and writes nothing", () => {
  const env = project();
  assert.throws(() => installSkills({ spec: "file:///nonexistent/repo", ...env }));
  assert.ok(!exists(env, ".toolgate/skills.lock.json"));
  assert.ok(!exists(env, ".toolgate/skills"));
});

test("install: an unreadable lock stops the install instead of being replaced", () => {
  const remote = remoteRepo();
  const env = project();
  fs.mkdirSync(path.join(env.projectDir, ".toolgate"));
  fs.writeFileSync(path.join(env.projectDir, ".toolgate/skills.lock.json"), "{ nope");
  assert.throws(() => install(remote, env), /skills\.lock\.json is not valid JSON and was left untouched/);
  assert.equal(fs.readFileSync(path.join(env.projectDir, ".toolgate/skills.lock.json"), "utf8"), "{ nope");
  assert.ok(!exists(env, ".toolgate/skills"));
});

test("lock: written sorted, and a missing lock reads as empty", () => {
  const file = path.join(tmp("lock"), "skills.lock.json");
  assert.deepEqual(readLock(file), { sources: {}, skills: {}, invalid: [] });
  writeLock(file, { sources: { b: {}, a: {} }, skills: { z: {}, m: {} } });
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([Object.keys(written.sources), Object.keys(written.skills)], [["a", "b"], ["m", "z"]]);
});

test("hashDir: depends on file names and content, not on timestamps", () => {
  const a = tmp("hash");
  const b = tmp("hash");
  for (const dir of [a, b]) fs.writeFileSync(path.join(dir, "SKILL.md"), "same");
  assert.equal(hashDir(a), hashDir(b));
  fs.writeFileSync(path.join(b, "SKILL.md"), "different");
  assert.notEqual(hashDir(a), hashDir(b));
  fs.writeFileSync(path.join(b, "SKILL.md"), "same");
  fs.writeFileSync(path.join(b, "extra.md"), "x");
  assert.notEqual(hashDir(a), hashDir(b));
});
test("lock: a kind keeps its items under its own key", () => {
  const file = path.join(tmp("lock"), "commands.lock.json");
  assert.deepEqual(readLock(file, "commands"), { sources: {}, commands: {}, invalid: [] });
  writeLock(file, { sources: { s: {} }, commands: { b: {}, a: {} } }, "commands");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(written), ["sources", "commands"]);
  assert.deepEqual(Object.keys(written.commands), ["a", "b"]);
  assert.deepEqual(Object.keys(readLock(file, "commands").commands), ["a", "b"]);
});
test("installAssets: the descriptor decides where copies, lock and licenses go; skills are unchanged", () => {
  const remote = remoteRepo();
  const env = project();
  const kind = { ...SKILL_KIND, storeDir: ".toolgate/other", lockFile: ".toolgate/other.lock.json", lockKey: "others" };
  const result = installAssets(kind, { spec: remote.spec, ...env });
  assert.deepEqual(result.installed, ["alpha", "beta"]);
  assert.ok(exists(env, ".toolgate/other/alpha/SKILL.md"));
  assert.ok(exists(env, ".toolgate/other/.licenses"));
  assert.deepEqual(Object.keys(readLock(path.join(env.projectDir, kind.lockFile), "others").others), ["alpha", "beta"]);
  assert.ok(!exists(env, ".toolgate/skills") && !exists(env, ".toolgate/skills.lock.json"));
});
test("readLock: a lock written before the descriptor existed still reads with the default key", () => {
  const file = path.join(tmp("lock"), "skills.lock.json");
  fs.writeFileSync(file, JSON.stringify({ sources: { s: { url: "u" } }, skills: { alpha: { source: "s", hash: "h" } } }));
  assert.deepEqual(readLock(file), { sources: { s: { url: "u" } }, skills: { alpha: { source: "s", hash: "h" } }, invalid: [] });
});
test("installAssets: hashes and copies through the descriptor's own functions", () => {
  const remote = remoteRepo();
  const env = project();
  const calls = { hash: 0, copy: 0 };
  const kind = {
    ...SKILL_KIND,
    hash: (dir) => (calls.hash++, SKILL_KIND.hash(dir)),
    copy: (from, to) => (calls.copy++, SKILL_KIND.copy(from, to)),
  };
  installAssets(kind, { spec: remote.spec, ...env });
  assert.equal(calls.copy, 2);
  assert.ok(calls.hash >= 2);
});

test("install --user and --local write their own store and lock; the project's are untouched", () => {
  const remote = remoteRepo();
  const env = { ...project(), userDir: tmp("user") };
  install(remote, env, { level: "user", names: ["alpha"] });
  install(remote, env, { level: "local", names: ["beta"] });
  assert.ok(fs.existsSync(path.join(env.userDir, "skills/alpha/SKILL.md")));
  assert.ok(fs.existsSync(path.join(env.userDir, "skills/.licenses")));
  assert.deepEqual(Object.keys(readLock(path.join(env.userDir, "skills.lock.json")).skills), ["alpha"]);
  assert.ok(exists(env, ".toolgate/skills.local/beta/SKILL.md"));
  assert.deepEqual(Object.keys(readLock(path.join(env.projectDir, ".toolgate/skills.local.lock.json")).skills), ["beta"]);
  assert.equal(exists(env, ".toolgate/skills"), false);
  assert.equal(exists(env, ".toolgate/skills.lock.json"), false);
  assert.throws(() => install(remote, { ...env, userDir: undefined }, { level: "user" }), /user config directory/);
  assert.throws(() => install(remote, env, { level: "team" }), /unknown level/);
});

test("install: copies lose the executable bit, and a leftover staging folder never stays in the store", () => {
  const remote = remoteRepo((root) => {
    writeSkill(root, "skills/alpha", "alpha");
    fs.mkdirSync(path.join(root, "skills/alpha/scripts"));
    fs.writeFileSync(path.join(root, "skills/alpha/scripts/run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  });
  const env = project();
  const staging = path.join(env.projectDir, ".toolgate/.staging");
  // pid 2147483646 does not run; the parent of this test does.
  const dead = "2147483646-aa11bb22";
  const alive = `${process.ppid}-aa11bb22`;
  for (const name of [dead, alive, "skills-alpha-1", "999-NOTHEX"]) fs.mkdirSync(path.join(staging, name), { recursive: true });
  fs.writeFileSync(path.join(staging, "2147483645-aa11bb22"), "a file, not a run folder");
  install(remote, env);
  assert.equal(fs.statSync(path.join(env.projectDir, ".toolgate/skills/alpha/scripts/run.sh")).mode & 0o111, 0);
  assert.deepEqual(fs.readdirSync(path.join(env.projectDir, ".toolgate/skills")).filter((n) => n.includes("installing")), []);
  assert.equal(exists(env, `.toolgate/.staging/${dead}`), false, "the folder of a run that died is removed");
  assert.equal(exists(env, `.toolgate/.staging/${alive}`), true, "a run whose pid is alive keeps its staging, however old");
  assert.equal(exists(env, ".toolgate/.staging/skills-alpha-1"), true, "only folders shaped <pid>-<hex> are ever removed");
  assert.equal(exists(env, ".toolgate/.staging/999-NOTHEX"), true);
  assert.equal(exists(env, ".toolgate/.staging/2147483645-aa11bb22"), true, "a file is not a run folder");
});

test("install records the excluded names in the lock source and keeps them across runs", () => {
  const remote = remoteRepo();
  const env = project();
  install(remote, env, { exclude: ["beta"] });
  const lockFile = path.join(env.projectDir, ".toolgate/skills.lock.json");
  assert.deepEqual(readLock(lockFile).sources[remote.spec].exclude, ["beta"]);
  install(remote, env, { exclude: ["alpha"], names: ["beta"] });
  assert.deepEqual(readLock(lockFile).sources[remote.spec].exclude, ["alpha", "beta"]);
  const plain = project();
  install(remote, plain);
  assert.equal("exclude" in readLock(path.join(plain.projectDir, ".toolgate/skills.lock.json")).sources[remote.spec], false);
});

test("fetchSource: a pinned commit is fetched by SHA, reused from the cache, and refused if another one arrives", async () => {
  const { fetchSource } = await import("../src/skills/remote.js");
  const remote = remoteRepo();
  const pin = remote.commit();
  const cache = tmp("cache");
  const first = fetchSource({ url: remote.spec, ref: pin, cache, allowFile: true });
  assert.equal(first.commit, pin);
  fs.writeFileSync(path.join(remote.root, "skills/alpha/SKILL.md"), skillMd("alpha", "later"));
  remote.commitAll("later");
  const again = fetchSource({ url: remote.spec, ref: pin, cache, allowFile: true });
  assert.equal(again.dir, first.dir, "the same cache folder is reused");
  assert.equal(again.commit, pin);
  const lying = (bin, args, options) => (args.includes("rev-parse") ? `${"0".repeat(40)}\n` : execFileSync(bin, args, { ...options, encoding: "utf8" }));
  assert.throws(() => fetchSource({ url: remote.spec, ref: pin, cache: tmp("cache"), execFn: lying, allowFile: true }), /returned 0{40} for the pinned commit/);
});

test("install: a skill name over 100 characters is skipped with the limit in the reason, and 100 is installed", () => {
  const remote = remoteRepo((root) => {
    writeSkill(root, "skills/a", "a".repeat(100));
    writeSkill(root, "skills/b", "b".repeat(101));
  });
  const result = install(remote, project());
  assert.deepEqual(result.installed, ["a".repeat(100)]);
  assert.match(result.skipped[0].reason, /101 characters, over the install limit of 100; a copy already installed is untouched/);
});

test("install: a skill whose name differs only in case from an installed one is skipped, with or without --force", () => {
  const first = remoteRepo((root) => writeSkill(root, "skills/a", "Foo"));
  const second = remoteRepo((root) => writeSkill(root, "skills/a", "foo"));
  const env = project();
  install(first, env);
  for (const force of [false, true]) {
    const result = install(second, env, { force });
    assert.deepEqual(result.installed, []);
    assert.match(result.skipped[0].reason, /differs only in case from the installed "Foo"/);
  }
  assert.deepEqual(install(first, env).unchanged, ["Foo"]);
});
