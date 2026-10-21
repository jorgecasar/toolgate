import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreHint, trackedAndMissing } from "../src/configFile.js";
import { runInit } from "../src/init.js";
import { run } from "../src/cli.js";
import { git, isolateGitConfig } from "./support/git.js";
isolateGitConfig();

const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-tracked-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// A real repository whose .toolgate/config.json is committed; `lose` deletes it (or the whole folder) from the working tree.
function repo({ lose = "file" } = {}) {
  const cwd = tmp("repo");
  git(cwd, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  fs.writeFileSync(path.join(cwd, ".toolgate/config.json"), '{ "router": { "backend": "regex" }, "baseline": ["docs"] }\n');
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "config");
  if (lose === "file") fs.rmSync(path.join(cwd, ".toolgate/config.json"));
  if (lose === "folder") fs.rmSync(path.join(cwd, ".toolgate"), { recursive: true });
  return { cwd, file: path.join(cwd, ".toolgate/config.json") };
}
const env = () => ({ XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") });

test("trackedAndMissing: tracked and gone is true, also when the whole folder is gone; present, untracked, no repository, no git are false", () => {
  assert.equal(trackedAndMissing(repo({ lose: "file" }).file), true);
  assert.equal(trackedAndMissing(repo({ lose: "folder" }).file), true, "the folder is gone too: the repository is still found");
  assert.equal(trackedAndMissing(repo({ lose: "none" }).file), false, "it is there");
  const untracked = repo({ lose: "none" });
  assert.equal(trackedAndMissing(path.join(untracked.cwd, ".toolgate/config.local.json")), false, "never tracked");
  assert.equal(trackedAndMissing(path.join(tmp("plain"), ".toolgate/config.json")), false, "not a repository");
  assert.equal(trackedAndMissing(repo({ lose: "file" }).file, { execFn: () => { throw new Error("git: not found"); } }), false, "no git means no doubt to raise");
  assert.equal(restoreHint("/p/.toolgate/config.json", "/p"), ".toolgate/config.json is tracked by git but missing here; restore it with: git restore .toolgate/config.json (or pass --force to create a new one)");
});

test("config set refuses to recreate a tracked config that is missing, writes nothing and exits 1; --force creates it", async () => {
  const r = repo();
  const out = [];
  const err = [];
  const call = (args) => run(args, { cwd: r.cwd, env: env(), stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  assert.equal(await call(["config", "set", "router.backend", "qmd"]), 1);
  assert.match(err.join(""), /\.toolgate\/config\.json is tracked by git but missing here; restore it with: git restore \.toolgate\/config\.json \(or pass --force/);
  assert.equal(fs.existsSync(r.file), false, "nothing was written");
  assert.equal(await call(["config", "set", "router.backend", "qmd", "--force"]), 0, err.join(""));
  assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).router.backend, "qmd");
});

test("config edits of the local and user layers, and of a project that git does not track, are not held back", async () => {
  const r = repo();
  const e = env();
  const call = (args, cwd = r.cwd) => run(args, { cwd, env: e, stdout: { write() {} }, stderr: { write() {} } });
  assert.equal(await call(["config", "set", "router.backend", "qmd", "--local"]), 0);
  assert.equal(await call(["config", "set", "router.backend", "qmd", "--user"]), 0);
  const plain = tmp("plain");
  assert.equal(await call(["config", "set", "router.backend", "qmd"], plain), 0, "not a repository: as before");
  // Even a local config someone committed by mistake and deleted: only the project's file is the team's.
  const local = repo({ lose: "none" });
  fs.writeFileSync(path.join(local.cwd, ".toolgate/config.local.json"), "{}\n");
  git(local.cwd, "add", "-f", "-A");
  git(local.cwd, "commit", "-q", "-m", "local by mistake");
  fs.rmSync(path.join(local.cwd, ".toolgate/config.local.json"));
  assert.equal(await call(["config", "set", "router.backend", "qmd", "--local"], local.cwd), 0, "the local layer is never held back");
});

test("init does not recreate a tracked config that is missing: it says how to restore it, exits 1 and still does the rest; --force creates it", async () => {
  const r = repo();
  const out = [];
  const init = (extra = {}) =>
    runInit({ cwd: r.cwd, env: env(), stdout: { write: (s) => out.push(s) }, execFn: () => { throw new Error("none"); }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, interactive: false, targets: ["claudecode"], ...extra });
  assert.equal(await init(), 1);
  assert.match(out.join(""), /toolgate: \.toolgate\/config\.json is tracked by git but missing here; restore it with: git restore \.toolgate\/config\.json/);
  assert.equal(fs.existsSync(r.file), false);
  assert.ok(fs.existsSync(path.join(r.cwd, ".rulesync/rules/toolgate-router.md")), "the other steps ran");
  out.length = 0;
  assert.equal(await init({ dryRun: true }), 0, "a dry run only tells");
  assert.match(out.join(""), /is tracked by git but missing here/);
  assert.equal(fs.existsSync(r.file), false);
  assert.equal(await init({ force: true }), 0);
  assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).router.backend, "qmd");
});

test("init on a config that exists says which managed key it lacks and which flag it did not apply, and writes nothing", async () => {
  const cwd = tmp("existing");
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  const file = path.join(cwd, ".toolgate/config.json");
  const run1 = async (extra = {}) => {
    const out = [];
    await runInit({ cwd, env: env(), stdout: { write: (s) => out.push(s) }, execFn: () => { throw new Error("none"); }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, interactive: false, ...extra });
    return out.join("");
  };
  const fresh = await run1({ dryRun: true });
  assert.doesNotMatch(fresh, /missing managed key/, "a file that would be created is not 'lacking' a key");
  fs.writeFileSync(file, '{ "baseline": ["docs"] }\n');
  const lacking = await run1();
  assert.match(lacking, /missing managed key router\.backend \(init would set "qmd"\); add it with: toolgate config set router\.backend qmd/);
  assert.equal(fs.readFileSync(file, "utf8"), '{ "baseline": ["docs"] }\n');
  const flagged = await run1({ backend: "regex" });
  assert.match(flagged, /missing managed key router\.backend \(init would set "regex"\)/);
  fs.writeFileSync(file, '{ "router": { "backend": "regex" } }\n');
  assert.match(await run1({ backend: "qmd" }), /the config says router\.backend "regex"; --backend qmd was not applied \(change it with: toolgate config set router\.backend qmd\)/);
  const same = await run1();
  assert.doesNotMatch(same, /missing managed key|was not applied/, "nothing to say when the file has the key and no flag disagrees");
  fs.writeFileSync(file, "{ not json");
  assert.doesNotMatch(await run1(), /missing managed key/, "an unreadable file is left as it is");
});

// git hooks, `git rebase --exec` and `git bisect run` run with GIT_DIR set: it must not decide whose files are asked about.
const withGitEnv = async (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};
test("trackedAndMissing asks the repository of the file even when GIT_DIR or GIT_WORK_TREE point at another one", async () => {
  const elsewhere = repo({ lose: "file" });
  const pointing = { GIT_DIR: path.join(elsewhere.cwd, ".git"), GIT_WORK_TREE: elsewhere.cwd };
  // A project that tracks its deleted config: still refused, GIT_DIR or not.
  const mine = repo({ lose: "file" });
  await withGitEnv({ GIT_DIR: path.join(tmp("other"), ".git") }, () => assert.equal(trackedAndMissing(mine.file), true));
  // A project that tracks nothing, while the other repository tracks that very path: a first init is not refused.
  const fresh = tmp("fresh");
  git(fresh, "init", "-q", "-b", "main");
  await withGitEnv(pointing, async () => {
    assert.equal(trackedAndMissing(path.join(fresh, ".toolgate/config.json")), false);
    const code = await run(["config", "set", "router.backend", "qmd"], { cwd: fresh, env: env(), stdout: { write() {} }, stderr: { write() {} } });
    assert.equal(code, 0, "the first config of an untracked project is written");
  });
});
test("a parent that is not a folder gives the plain config error, not a stack trace", async () => {
  const cwd = tmp("notdir");
  fs.writeFileSync(path.join(cwd, ".toolgate"), "a file where the folder should be\n");
  assert.equal(trackedAndMissing(path.join(cwd, ".toolgate/config.json")), false);
  const err = [];
  const code = await run(["config", "set", "router.backend", "qmd"], { cwd, env: env(), stdout: { write() {} }, stderr: { write: (s) => err.push(s) } });
  assert.equal(code, 1);
  assert.match(err.join(""), /^toolgate config: /);
  assert.doesNotMatch(err.join(""), /\n\s+at /);
});
