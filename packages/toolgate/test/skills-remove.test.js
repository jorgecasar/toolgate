import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_KIND, installSkills, readLock } from "../src/skills/install.js";
import { formatRemove, removeAssets, removeExitCode } from "../src/skills/remove.js";
import { git as hermeticGit } from "./support/git.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-rm-${name}-`));
const git = (cwd, ...args) => hermeticGit(cwd, ...args);
const skillMd = (name) => `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody\n`;

function repo(names) {
  const root = tmp("remote");
  git(root, "init", "-q", "-b", "main");
  for (const name of names) {
    fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), skillMd(name));
  }
  fs.writeFileSync(path.join(root, "LICENSE"), "MIT\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return `file://${root}`;
}

function setup() {
  const projectDir = tmp("project");
  const userDir = tmp("user");
  const cache = tmp("cache");
  const one = repo(["alpha", "beta"]);
  const two = repo(["gamma"]);
  for (const spec of [one, two]) installSkills({ spec, projectDir, cache, allowFile: true });
  const configFile = path.join(projectDir, ".toolgate/config.json");
  fs.writeFileSync(configFile, JSON.stringify({ router: { backend: "regex" }, skills: { overrides: [{ skill: "alpha", mcps: ["m"] }, { skill: "beta", tags: ["t"] }] } }));
  const env = { projectDir, userDir, env: { ...process.env, XDG_CONFIG_HOME: tmp("xdg") } };
  const dir = (name) => path.join(projectDir, ".toolgate/skills", name);
  const lock = () => readLock(path.join(projectDir, ".toolgate/skills.lock.json"));
  const config = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
  return { env, one, two, dir, lock, config, remove: (extra) => removeAssets(SKILL_KIND, { ...env, ...extra }) };
}

test("remove: deletes the copy, its lock entry and its override, and keeps the rest", () => {
  const t = setup();
  const result = t.remove({ names: ["alpha"] });
  assert.deepEqual(result.removed, ["alpha"]);
  assert.equal(fs.existsSync(t.dir("alpha")), false);
  assert.equal("alpha" in t.lock().skills, false);
  assert.deepEqual(t.config().skills.overrides, [{ skill: "beta", tags: ["t"] }]);
  assert.ok(fs.existsSync(t.dir("beta")));
  assert.ok(t.one in t.lock().sources, "the source still has beta");
  assert.equal(removeExitCode(result), 0);
});

test("remove: the last skill of a source drops the source and its license; the config section stays tidy", () => {
  const t = setup();
  const licenses = path.join(t.env.projectDir, ".toolgate/skills/.licenses");
  assert.equal(fs.readdirSync(licenses).length, 2);
  const result = t.remove({ names: ["gamma"] });
  assert.deepEqual(result.sources, [t.two]);
  assert.equal(t.two in t.lock().sources, false);
  assert.equal(fs.readdirSync(licenses).length, 1);
  t.remove({ names: ["alpha", "beta"] });
  assert.equal(t.config().skills, undefined, "no empty skills section is left");
});

test("remove --source removes every skill of that source", () => {
  const t = setup();
  const result = t.remove({ source: t.one });
  assert.deepEqual(result.removed.sort(), ["alpha", "beta"]);
  assert.deepEqual(Object.keys(t.lock().skills), ["gamma"]);
  assert.equal(removeAssets(SKILL_KIND, { ...t.env, source: "github:nope/nope" }).refused.length, 1);
});

test("remove: refuses what the lock does not know, odd names and a missing name", () => {
  const t = setup();
  fs.mkdirSync(t.dir("mine"));
  const result = t.remove({ names: ["mine", "../../etc", "..", "alpha/../beta"] });
  assert.equal(result.removed.length, 0);
  assert.equal(result.refused.length, 4);
  assert.ok(fs.existsSync(t.dir("mine")) && fs.existsSync(t.dir("beta")));
  assert.equal(removeExitCode(result), 1);
  assert.equal(t.remove({}).refused[0].reason, "no name given");
});

test("remove: an edited copy needs --force", () => {
  const t = setup();
  fs.appendFileSync(path.join(t.dir("alpha"), "SKILL.md"), "my edit\n");
  const refused = t.remove({ names: ["alpha"] });
  assert.match(refused.refused[0].reason, /edited/);
  assert.ok(fs.existsSync(t.dir("alpha")));
  assert.deepEqual(t.remove({ names: ["alpha"], force: true }).removed, ["alpha"]);
});

test("remove: a folder that is a symlink is never followed or deleted", () => {
  const t = setup();
  const outside = tmp("outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "x");
  fs.rmSync(t.dir("alpha"), { recursive: true });
  fs.symlinkSync(outside, t.dir("alpha"));
  const result = t.remove({ names: ["alpha"], force: true });
  assert.match(result.refused[0].reason, /plain directory/);
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
});

test("remove: a copy that is already gone still cleans the lock", () => {
  const t = setup();
  fs.rmSync(t.dir("alpha"), { recursive: true });
  assert.deepEqual(t.remove({ names: ["alpha"] }).removed, ["alpha"]);
  assert.equal("alpha" in t.lock().skills, false);
});

test("remove --dry-run changes nothing; --keep-overrides keeps the config entry", () => {
  const t = setup();
  const before = [JSON.stringify(t.lock()), JSON.stringify(t.config())];
  const dry = t.remove({ names: ["alpha"], dryRun: true });
  assert.deepEqual(dry.removed, ["alpha"]);
  assert.deepEqual([JSON.stringify(t.lock()), JSON.stringify(t.config())], before);
  assert.ok(fs.existsSync(t.dir("alpha")));
  assert.match(formatRemove(dry, { dryRun: true }), /would remove alpha/);
  t.remove({ names: ["alpha"], keepOverrides: true });
  assert.equal(t.config().skills.overrides.length, 2);
});

test("remove: an override in another layer is left and mentioned", () => {
  const t = setup();
  const local = path.join(t.env.projectDir, ".toolgate/config.local.json");
  fs.writeFileSync(local, JSON.stringify({ skills: { overrides: [{ skill: "alpha", tags: ["x"] }] } }));
  const result = t.remove({ names: ["alpha"] });
  assert.deepEqual(result.overrides.elsewhere, [{ name: "alpha", layer: "local" }]);
  assert.equal(JSON.parse(fs.readFileSync(local, "utf8")).skills.overrides.length, 1);
  assert.match(formatRemove(result), /still has an override in the local config/);
});

test("remove: works on the user level", () => {
  const t = setup();
  installSkills({ spec: t.one, projectDir: t.env.projectDir, cache: tmp("cache"), allowFile: true, level: "user", userDir: t.env.userDir, names: ["alpha"] });
  const result = t.remove({ names: ["alpha"], level: "user" });
  assert.deepEqual(result.removed, ["alpha"]);
  assert.equal(fs.existsSync(path.join(t.env.userDir, "skills/alpha")), false);
  assert.ok(fs.existsSync(t.dir("alpha")), "the project copy is untouched");
});

test("remove: a repeated name is removed once and does not fail; a bad name has its own message", () => {
  const t = setup();
  const result = t.remove({ names: ["alpha", "alpha", "../x"] });
  assert.deepEqual(result.removed, ["alpha"]);
  assert.deepEqual(result.refused, [{ name: "../x", reason: "not a valid skill name" }]);
});

test("remove: --source together with names is refused", () => {
  const t = setup();
  const result = t.remove({ source: t.one, names: ["alpha"] });
  assert.match(result.refused[0].reason, /either --source or names/);
  assert.ok(fs.existsSync(t.dir("alpha")));
});

test("remove --source: an edited copy stays, and so does its source and license", () => {
  const t = setup();
  fs.appendFileSync(path.join(t.dir("beta"), "SKILL.md"), "my edit\n");
  const result = t.remove({ source: t.one });
  assert.deepEqual(result.removed, ["alpha"]);
  assert.equal(result.refused.length, 1);
  assert.deepEqual(result.sources, []);
  assert.ok(t.one in t.lock().sources);
});

test("remove --dry-run: the source of every skill about to go is reported as dropped", () => {
  const t = setup();
  const dry = t.remove({ source: t.one, dryRun: true });
  assert.deepEqual(dry.sources, [t.one]);
  assert.ok(t.one in t.lock().sources);
});

test("remove: a regular file where the folder should be is refused; a failing delete is refused per skill", () => {
  const t = setup();
  fs.rmSync(t.dir("alpha"), { recursive: true });
  fs.writeFileSync(t.dir("alpha"), "not a folder");
  assert.match(t.remove({ names: ["alpha"], force: true }).refused[0].reason, /plain directory/);
  const original = fs.rmSync;
  const result = (() => {
    fs.rmSync = (target, options) => {
      if (String(target).endsWith("/beta")) throw new Error("EACCES: denied");
      return original(target, options);
    };
    try {
      return t.remove({ names: ["beta", "gamma"] });
    } finally {
      fs.rmSync = original;
    }
  })();
  assert.deepEqual(result.removed, ["gamma"]);
  assert.match(result.refused[0].reason, /could not delete it: EACCES/);
  assert.ok("beta" in t.lock().skills, "the lock keeps what was not deleted");
  assert.equal("gamma" in t.lock().skills, false);
});

test("remove: a broken config is a warning after the skill is gone, and is left untouched", () => {
  const t = setup();
  const file = path.join(t.env.projectDir, ".toolgate/config.json");
  fs.writeFileSync(file, "{nope");
  const result = t.remove({ names: ["alpha"] });
  assert.deepEqual(result.removed, ["alpha"]);
  assert.match(result.overrides.error, /not valid JSON/);
  assert.match(formatRemove(result), /overrides were not cleaned up/);
  assert.equal(fs.existsSync(path.join(t.env.projectDir, ".toolgate/skills/alpha")), false);
  assert.equal(t.lock().skills.alpha, undefined);
  assert.equal(fs.readFileSync(file, "utf8"), "{nope");
  fs.writeFileSync(file, JSON.stringify({ skills: { overrides: "oops" } }));
  assert.deepEqual(t.remove({ names: ["alpha"] }).overrides.removed, []);
});

test("remove: a config layer that cannot be read exits 1, and the other layers are still cleaned", () => {
  const t = setup();
  const broken = path.join(tmp("layers"), "config.json");
  fs.writeFileSync(broken, "// not json\n{");
  const configFile = path.join(t.env.projectDir, ".toolgate/config.json");
  const result = t.remove({ names: ["alpha"], configLayers: [{ name: "user", path: broken }, { name: "project", path: configFile }] });
  assert.deepEqual(result.removed, ["alpha"]);
  assert.match(result.overrides.error, /user config/);
  assert.equal(removeExitCode(result), 1);
  assert.deepEqual(result.overrides.removed, ["alpha"], "the healthy project layer was cleaned");
  assert.deepEqual(t.config().skills.overrides, [{ skill: "beta", tags: ["t"] }]);
});

test("remove --user: a skill installed at the user level loses its copy and its lock entry there", () => {
  const t = setup();
  installSkills({ spec: t.one, projectDir: t.env.projectDir, userDir: t.env.userDir, cache: tmp("cache"), allowFile: true, level: "user", names: ["alpha"] });
  const userLock = () => readLock(path.join(t.env.userDir, "skills.lock.json"));
  assert.ok(fs.existsSync(path.join(t.env.userDir, "skills/alpha/SKILL.md")));
  const result = t.remove({ names: ["alpha"], level: "user" });
  assert.deepEqual(result.removed, ["alpha"]);
  assert.equal(fs.existsSync(path.join(t.env.userDir, "skills/alpha")), false);
  assert.equal(userLock().skills.alpha, undefined);
  assert.ok(fs.existsSync(t.dir("alpha")), "the project copy is untouched");
});

test("remove: the local level uses its own store, lock and config", () => {
  const t = setup();
  installSkills({ spec: t.one, projectDir: t.env.projectDir, cache: tmp("cache"), allowFile: true, level: "local", names: ["alpha"] });
  const local = path.join(t.env.projectDir, ".toolgate/config.local.json");
  fs.writeFileSync(local, JSON.stringify({ skills: { overrides: [{ skill: "alpha", tags: ["x"] }] } }));
  const result = t.remove({ names: ["alpha"], level: "local" });
  assert.deepEqual(result.removed, ["alpha"]);
  assert.equal(fs.existsSync(path.join(t.env.projectDir, ".toolgate/skills.local/alpha")), false);
  assert.deepEqual(result.overrides.removed, ["alpha"]);
  assert.equal(JSON.parse(fs.readFileSync(local, "utf8")).skills, undefined);
  assert.ok(fs.existsSync(t.dir("alpha")), "the project copy is untouched");
  assert.equal(t.config().skills.overrides.length, 2, "and so is the project override");
});
test("remove --force and --source with hand-edited lock entries (empty, wrong-typed, no source): no throw, nothing is deleted before the entry is validated", () => {
  for (const bad of [{}, { source: 1, commit: "c", hash: "h" }, { source: null }, { source: {}, hash: [] }, { hash: "h" }]) {
    const t = setup();
    const file = path.join(t.env.projectDir, ".toolgate/skills.lock.json");
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    lock.skills.alpha = bad;
    fs.writeFileSync(file, JSON.stringify(lock));
    const label = JSON.stringify(bad);
    let result;
    assert.doesNotThrow(() => (result = t.remove({ names: ["alpha"], force: true })), `--force ${label}`);
    assert.equal(fs.existsSync(t.dir("alpha")), true, `${label}: the folder of an entry that cannot be trusted stays`);
    assert.equal(result.removed.includes("alpha"), false, label);
    assert.equal(removeExitCode(result), 1, label);
    for (const source of [t.one, t.two]) assert.doesNotThrow(() => t.remove({ source, force: true }), `--source ${label}`);
    assert.equal(fs.existsSync(t.dir("beta")) || fs.existsSync(t.dir("gamma")), false, `${label}: the sound entries were removed`);
    assert.equal(fs.existsSync(t.dir("alpha")), true, label);
  }
});
