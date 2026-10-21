import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSkills } from "../src/skills/cli.js";
import { readLock } from "../src/skills/install.js";
import { git as hermeticGit } from "./support/git.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-rec-${name}-`));
const git = (cwd, ...args) => hermeticGit(cwd, ...args);
const skillMd = (name, body = "body") => `---\nname: ${name}\ndescription: the ${name} skill\n---\n${body}\n`;
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

function setup(entryExtra = {}) {
  const remote = tmp("remote");
  git(remote, "init", "-q", "-b", "main");
  for (const name of ["alpha", "beta", "router"]) write(remote, `skills/${name}/SKILL.md`, skillMd(name));
  write(remote, "LICENSE", "MIT\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-q", "-m", "init");
  const pin = git(remote, "rev-parse", "HEAD").trim();
  // The branch moves on after the review: the pin must not.
  write(remote, "skills/alpha/SKILL.md", skillMd("alpha", "moved on"));
  git(remote, "add", "-A");
  git(remote, "commit", "-q", "-m", "later");
  const cwd = tmp("project");
  const entry = { id: "t/set", source: `file://${remote}`, commit: pin, license: "MIT", skills: ["alpha", "beta", "router"], exclude: ["router"], overrides: [{ skill: "beta", mcps: ["m"] }], ...entryExtra };
  const config = { skills: { recommended: [entry] } };
  const env = { ...process.env, XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache") };
  const out = [];
  const run = (args, extra = {}, signals = {}) => {
    out.length = 0;
    const code = runSkills(args, { cwd, config, env, install: { allowFile: true }, deps: { execFn: () => "" }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) }, ...extra }, signals);
    return { code, text: out.join("") };
  };
  const lock = () => readLock(path.join(cwd, ".toolgate/skills.lock.json"));
  const overrides = () => {
    const file = path.join(cwd, ".toolgate/config.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).skills?.overrides : undefined;
  };
  return { remote, pin, cwd, run, lock, overrides, entry };
}

test("install recommended:<id> installs the reviewed skills at the pinned commit, not the branch head", () => {
  const t = setup();
  const { code, text } = t.run(["install", "recommended:t/set"]);
  assert.equal(code, 0, text);
  assert.deepEqual(Object.keys(t.lock().skills), ["alpha", "beta"]);
  assert.equal(t.lock().skills.alpha.commit, t.pin);
  assert.doesNotMatch(fs.readFileSync(path.join(t.cwd, ".toolgate/skills/alpha/SKILL.md"), "utf8"), /moved on/);
  const source = t.lock().sources[t.entry.source];
  assert.equal(source.ref, t.pin, "the lock keeps the reviewed commit as its ref");
  assert.deepEqual(source.exclude, ["router"]);
  assert.deepEqual(t.overrides(), [{ skill: "beta", mcps: ["m"] }]);
  assert.match(text, /t\/set: .* at .*\(MIT\), 2 reviewed skills/);
  assert.equal(text.match(/wrote an override/g).length, 1, "one line per override written");
  assert.match(text, /wrote an override for beta \(mcps m\) to \.toolgate[\\/]config\.json \(project config\)/);
});

test("install recommended: running it again is unchanged and keeps an override the user already has", () => {
  const t = setup();
  t.run(["install", "recommended:t/set"]);
  fs.writeFileSync(path.join(t.cwd, ".toolgate/config.json"), JSON.stringify({ skills: { overrides: [{ skill: "beta", mcps: ["mine"] }] } }));
  const again = t.run(["install", "recommended:t/set"]);
  assert.match(again.text, /unchanged 2/);
  assert.match(again.text, /kept your existing overrides for beta/);
  assert.doesNotMatch(again.text, /wrote an override/, "an override that was already there is not announced");
  const third = t.run(["install", "recommended:t/set"]);
  assert.doesNotMatch(third.text, /wrote an override/);
  assert.deepEqual(t.overrides(), [{ skill: "beta", mcps: ["mine"] }]);
});

test("install recommended: a name subset works and a name outside the reviewed list is refused", () => {
  const t = setup();
  assert.equal(t.run(["install", "recommended:t/set", "alpha"]).code, 0);
  assert.deepEqual(Object.keys(t.lock().skills), ["alpha"]);
  assert.equal(t.overrides(), undefined, "no override for a skill that was not installed");
  const bad = t.run(["install", "recommended:t/set", "router"]);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /not in the reviewed list/);
});

test("install recommended: unknown id, a branch instead of a commit, and a reviewed skill missing at the pin all fail", () => {
  assert.match(setup().run(["install", "recommended:nope"]).text, /not a recommended source/);
  assert.match(setup({ commit: "main" }).run(["install", "recommended:t/set"]).text, /40-character SHA/);
  const missing = setup({ skills: ["alpha", "ghost"], exclude: [], overrides: [{ skill: "alpha", mcps: ["m"] }] });
  const result = missing.run(["install", "recommended:t/set"]);
  assert.equal(result.code, 1);
  assert.match(result.text, /lacks the reviewed skills: ghost/);
  assert.equal(fs.existsSync(path.join(missing.cwd, ".toolgate/skills/alpha")), false, "nothing is installed when the review does not match");
});

test("install recommended: a commit that does not exist upstream fails and installs nothing", () => {
  const t = setup({ commit: "f".repeat(40) });
  const result = t.run(["install", "recommended:t/set"]);
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(path.join(t.cwd, ".toolgate/skills.lock.json")), false);
});

test("install recommended: --ref and --path cannot be combined with a pinned recommendation", () => {
  const t = setup();
  const result = t.run(["install", "recommended:t/set"], { install: { allowFile: true, ref: "main" } });
  assert.equal(result.code, 1);
  assert.match(result.text, /cannot be combined/);
  assert.equal(fs.existsSync(path.join(t.cwd, ".toolgate/skills.lock.json")), false);
});

test("install recommended: a later update stays on the reviewed commit", async () => {
  const { updateAssets } = await import("../src/skills/update.js");
  const { SKILL_KIND } = await import("../src/skills/install.js");
  const t = setup();
  t.run(["install", "recommended:t/set"]);
  const result = updateAssets(SKILL_KIND, { projectDir: t.cwd, cache: tmp("cache"), allowFile: true });
  assert.deepEqual(result.sources[0].updated, [], "the head of the branch is not followed");
  assert.equal(t.lock().skills.alpha.commit, t.pin);
});

test("install recommended: the overrides go to the config of the install level (local)", () => {
  const t = setup();
  const result = t.run(["install", "recommended:t/set"], { level: "local" });
  assert.equal(result.code, 0, result.text);
  const local = JSON.parse(fs.readFileSync(path.join(t.cwd, ".toolgate/config.local.json"), "utf8"));
  assert.deepEqual(local.skills.overrides, [{ skill: "beta", mcps: ["m"] }]);
  assert.equal(t.overrides(), undefined);
  assert.match(result.text, /wrote an override for beta \(mcps m\) to \.toolgate[\\/]config\.local\.json \(local config\)/);
});

test("install recommended: a broken config stops the command before anything is installed", () => {
  const t = setup();
  fs.mkdirSync(path.join(t.cwd, ".toolgate"), { recursive: true });
  fs.writeFileSync(path.join(t.cwd, ".toolgate/config.json"), "{nope");
  const result = t.run(["install", "recommended:t/set"]);
  assert.equal(result.code, 1);
  assert.match(result.text, /not valid JSON/);
  assert.equal(fs.existsSync(path.join(t.cwd, ".toolgate/skills")), false);
});

test("install recommended --user: an entry from the committed project config is refused, one from the user config is not", () => {
  const t = setup();
  t.entry.layer = "project";
  const refused = t.run(["install", "recommended:t/set"], { level: "user" });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /comes from the project config/);
  assert.equal(fs.existsSync(path.join(t.cwd, ".toolgate/skills.lock.json")), false);
  t.entry.layer = "local";
  assert.equal(t.run(["install", "recommended:t/set"], { level: "user" }).code, 1, "local is not trusted either");
  t.entry.layer = "user";
  const allowed = t.run(["install", "recommended:t/set"], { level: "user" });
  assert.equal(allowed.code, 0, allowed.text);
  assert.match(allowed.text, /from the user config/);
});

test("install recommended --user: an entry with no layer is as untrusted as a project one; the layer cannot be forged from the file", async () => {
  const { mergeConfigLayers } = await import("../src/config.js");
  const t = setup();
  delete t.entry.layer;
  const unknown = t.run(["install", "recommended:t/set"], { level: "user" });
  assert.equal(unknown.code, 1);
  assert.match(unknown.text, /unknown origin/);
  // A committed project file that claims to be a user entry: the merge writes the real layer.
  const forged = mergeConfigLayers([null, { skills: { recommended: [{ ...t.entry, layer: "user" }] } }], [{ name: "user", base: "/u" }, { name: "project", base: "/p" }]);
  const refused = t.run(["install", "recommended:t/set"], { level: "user", config: forged });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /comes from the project config/);
});

test("install recommended: an exclude that covers every skill is refused, not reported as zero skills", () => {
  const t = setup({ exclude: ["alpha", "beta", "router"] });
  const { code, text } = t.run(["install", "recommended:t/set"]);
  assert.equal(code, 1);
  assert.match(text, /exclude leaves no reviewed skill/);
});

test("install recommended: a reviewed skill skipped because the copy was edited makes the install exit 1", () => {
  const t = setup();
  assert.equal(t.run(["install", "recommended:t/set"]).code, 0);
  fs.appendFileSync(path.join(t.cwd, ".toolgate/skills/alpha/SKILL.md"), "my edit\n");
  const again = t.run(["install", "recommended:t/set"]);
  assert.equal(again.code, 1, again.text);
  assert.match(again.text, /skipped alpha: edited/);
});

test("install recommended: when the overrides cannot be written the skills stay installed and the message says to rerun", () => {
  const t = setup();
  const original = fs.renameSync;
  // Only the config write fails: the skills are copied with renames of their own.
  fs.renameSync = (from, to) => {
    if (String(to).endsWith("config.json")) throw new Error("EROFS: read-only file system");
    return original(from, to);
  };
  let result;
  try {
    result = t.run(["install", "recommended:t/set"]);
  } finally {
    fs.renameSync = original;
  }
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /installed but their overrides could not be written.*run the same command again/);
  assert.ok(fs.existsSync(path.join(t.cwd, ".toolgate/skills/alpha/SKILL.md")));
});

test("install: installing a pinned source again without --ref keeps the pin instead of following the branch", () => {
  const t = setup();
  t.run(["install", "recommended:t/set"]);
  const plain = t.run(["install", t.entry.source]);
  assert.equal(plain.code, 0, plain.text);
  assert.equal(t.lock().sources[t.entry.source].ref, t.pin);
  assert.equal(t.lock().skills.alpha.commit, t.pin);
});

test("validateRecommendation: a description over 500 characters is refused and a valid override is accepted", async () => {
  const { validateRecommendation } = await import("../src/skills/recommended.js");
  const base = { id: "t/set", source: "github:o/r", commit: "a".repeat(40), license: "MIT", skills: ["a"] };
  validateRecommendation({ ...base, overrides: [{ skill: "a", description: "x".repeat(500), mcps: ["m"] }] });
  assert.throws(() => validateRecommendation({ ...base, overrides: [{ skill: "a", description: "x".repeat(501) }] }), /overrides must be/);
});

test("fetching a pinned commit: a commit that is gone and a server that refuses SHAs are told apart", async () => {
  const { fetchSource } = await import("../src/skills/remote.js");
  const fail = (stderr) => (bin, args) => {
    if (args.includes("fetch")) throw Object.assign(new Error(`Command failed: git ${args.join(" ")}`), { stderr });
    return "";
  };
  const pin = "c".repeat(40);
  const run = (stderr) => fetchSource({ url: "https://example.com/o/r.git", ref: pin, cache: tmp("cache"), execFn: fail(stderr) });
  assert.throws(() => run("fatal: remote error: upload-pack: not our ref " + pin), /no longer exists in https:\/\/example.com\/o\/r.git.*not our ref/);
  assert.throws(() => run("error: Server does not allow request for unadvertised object " + pin), /does not serve commits by SHA/);
  assert.throws(() => run("fatal: unable to access: Could not resolve host"), /could not fetch the pinned commit.*Could not resolve host/);
});

test("install recommended --user: a config.local.json that a cloned repository ships is as untrusted as the committed config", async () => {
  const { loadConfig, configLayerPaths } = await import("../src/config.js");
  const t = setup();
  fs.mkdirSync(path.join(t.cwd, ".toolgate"), { recursive: true });
  const evil = { ...t.entry, overrides: [{ skill: "alpha", description: "EVIL from local" }] };
  fs.writeFileSync(path.join(t.cwd, ".toolgate/config.local.json"), JSON.stringify({ skills: { recommended: [evil] } }));
  const env = { ...process.env, XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache") };
  const config = loadConfig(configLayerPaths({ cwd: t.cwd, env }));
  const userConfig = path.join(env.XDG_CONFIG_HOME, "toolgate/config.json");
  const refused = t.run(["install", "recommended:t/set"], { level: "user", config, env });
  assert.equal(refused.code, 1, refused.text);
  assert.match(refused.text, /comes from the local config/);
  assert.equal(fs.existsSync(userConfig), false, "nothing was written to the user config");
  const local = t.run(["install", "recommended:t/set"], { level: "local", config, env });
  assert.equal(local.code, 0, local.text);
});

test("recommendations carry where they come from: the shipped ones are marked, and git speaks English", async () => {
  const { loadRecommendations } = await import("../src/skills/recommended.js");
  const { gitEnv } = await import("../src/skills/remote.js");
  assert.ok(loadRecommendations([]).length > 0);
  assert.ok(loadRecommendations([]).every((entry) => entry.layer === "shipped"));
  assert.equal(gitEnv().LC_ALL, "C");
  assert.equal(gitEnv().LANGUAGE, "C");
});
test("install recommended: the servers of the overrides it writes are the ones --catalog builds, and so are the ones the user already had", () => {
  const written = setup();
  const signals = {};
  assert.equal(written.run(["install", "recommended:t/set"], {}, signals).code, 0);
  assert.deepEqual([...signals.servers], ["m"], "beta has no server of its own: the override the recommendation wrote gives it one");
  const kept = setup();
  fs.mkdirSync(path.join(kept.cwd, ".toolgate"), { recursive: true });
  fs.writeFileSync(path.join(kept.cwd, ".toolgate/config.json"), JSON.stringify({ skills: { overrides: [{ skill: "beta", mcps: ["mine"] }] } }));
  const again = {};
  assert.equal(kept.run(["install", "recommended:t/set"], { config: { skills: { recommended: [kept.entry], overrides: [{ skill: "beta", mcps: ["mine"] }] } } }, again).code, 0);
  assert.deepEqual([...again.servers], ["mine"], "the existing override is kept, and it is the effective one");
});
