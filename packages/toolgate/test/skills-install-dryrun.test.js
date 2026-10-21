import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSkills } from "../src/skills/cli.js";
import { git as hermeticGit } from "./support/git.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-dry-${name}-`));
const git = (cwd, ...args) => hermeticGit(cwd, ...args);
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

// Every file under the dirs, with its bytes: the oracle for "a dry run changes nothing".
const snapshot = (...dirs) => {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[full] = fs.readFileSync(full, "utf8");
    }
  };
  dirs.forEach(walk);
  return files;
};

function setup() {
  const remote = tmp("remote");
  git(remote, "init", "-q", "-b", "main");
  for (const name of ["alpha", "beta"]) write(remote, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody\n`);
  write(remote, "LICENSE", "MIT\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-q", "-m", "init");
  const pin = git(remote, "rev-parse", "HEAD").trim();
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  const entry = { id: "t/set", source: `file://${remote}`, commit: pin, license: "MIT", skills: ["alpha", "beta"], overrides: [{ skill: "beta", mcps: ["m"] }] };
  const config = { skills: { recommended: [entry] } };
  const xdg = tmp("xdg");
  const home = tmp("home");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, XDG_CACHE_HOME: tmp("cache") };
  const calls = [];
  const out = [];
  const run = (args, extra = {}) => {
    out.length = 0;
    const code = runSkills(args, { cwd, config, env, install: { allowFile: true }, deps: { execFn: (...call) => (calls.push(call), "") }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) }, ...extra });
    return { code, text: out.join("") };
  };
  return { remote, cwd, xdg, home, run, calls, state: () => snapshot(cwd, xdg, home) };
}

for (const [label, args] of [
  ["a plain install", (t) => ["install", `file://${t.remote}`]],
  ["a recommended install, with its override", () => ["install", "recommended:t/set"]],
  ["a local install", (t) => ["install", `file://${t.remote}`]],
]) {
  test(`--dry-run writes nothing (${label}): project, config and home are identical before and after`, () => {
    const t = setup();
    const before = t.state();
    const { code, text } = t.run(args(t), { dryRun: true, ...(label.startsWith("a local") ? { level: "local" } : {}) });
    assert.equal(code, 0, text);
    assert.deepEqual(t.state(), before, text);
    assert.deepEqual(t.calls, [], "qmd was not asked for anything");
    assert.match(text, /would install 2 skills/);
    assert.match(text, /dry run, nothing written/);
    if (label.startsWith("a recommended")) assert.match(text, /would write an override for beta \(mcps m\) to \.toolgate[\\/]config\.json/);
    assert.doesNotMatch(text, /\bwrote\b|\binstalled 2/);
  });
}

test("the same install without --dry-run does write, so the snapshot test can fail", () => {
  const t = setup();
  const before = t.state();
  const { code, text } = t.run(["install", "recommended:t/set"]);
  assert.equal(code, 0, text);
  assert.notDeepEqual(t.state(), before);
  assert.ok(fs.existsSync(path.join(t.cwd, ".toolgate/skills.lock.json")));
  assert.ok(fs.existsSync(path.join(t.cwd, ".toolgate/config.json")));
});

test("--dry-run after a real install reports unchanged and still writes nothing", () => {
  const t = setup();
  t.run(["install", "recommended:t/set"]);
  const before = t.state();
  const { text } = t.run(["install", "recommended:t/set"], { dryRun: true });
  assert.deepEqual(t.state(), before);
  assert.match(text, /unchanged 2/);
});

test("--dry-run leaves a staging folder of an earlier crashed run where it is (it does not clean up)", () => {
  const t = setup();
  write(t.cwd, ".toolgate/.staging/999999-abc123/leftover.txt", "x\n");
  const before = t.state();
  const { code, text } = t.run(["install", `file://${t.remote}`], { dryRun: true });
  assert.equal(code, 0, text);
  assert.deepEqual(t.state(), before);
});

test("--json prints one result object on stdout and the text on stderr; --dry-run says so in it", () => {
  const t = setup();
  const stdout = [];
  const stderr = [];
  const code = runSkills(["install", "recommended:t/set"], { cwd: t.cwd, config: { skills: { recommended: [{ id: "t/set", source: `file://${t.remote}`, commit: git(t.remote, "rev-parse", "HEAD").trim(), license: "MIT", skills: ["alpha", "beta"], overrides: [{ skill: "beta", mcps: ["m"] }] }] } }, env: { ...process.env, HOME: t.home, XDG_CONFIG_HOME: t.xdg, XDG_CACHE_HOME: tmp("cache") }, install: { allowFile: true }, deps: { execFn: () => "" }, json: true, dryRun: true, stdout: { write: (s) => stdout.push(s) }, stderr: { write: (s) => stderr.push(s) } });
  assert.equal(code, 0, stderr.join(""));
  const result = JSON.parse(stdout.join(""));
  assert.deepEqual(Object.keys(result).sort(), ["commit", "dryRun", "installed", "overrides", "skipped", "source", "unchanged", "updated"]);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.installed.sort(), ["alpha", "beta"]);
  assert.deepEqual(result.overrides, { written: ["beta"], kept: [] });
  assert.match(stderr.join(""), /would install 2 skills/);
  assert.doesNotMatch(stdout.join(""), /toolgate:/);
});

test("--json of a plain install has no overrides field and lists what was skipped with its reason", () => {
  const t = setup();
  const stdout = [];
  const url = `file://${t.remote}`;
  write(t.cwd, ".toolgate/skills/alpha/SKILL.md", "mine\n");
  const code = runSkills(["install", url], { cwd: t.cwd, config: {}, env: { ...process.env, HOME: t.home, XDG_CONFIG_HOME: t.xdg, XDG_CACHE_HOME: tmp("cache") }, install: { allowFile: true }, deps: { execFn: () => "" }, json: true, stdout: { write: (s) => stdout.push(s) }, stderr: { write() {} } });
  assert.equal(code, 0);
  const result = JSON.parse(stdout.join(""));
  assert.equal(result.dryRun, false);
  assert.equal("overrides" in result, false);
  assert.deepEqual(result.installed, ["beta"]);
  assert.equal(result.skipped[0].name, "alpha");
  assert.match(result.skipped[0].reason, /not installed by toolgate/);
});
