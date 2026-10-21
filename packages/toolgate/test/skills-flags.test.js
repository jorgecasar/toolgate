import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { unsupportedFlag } from "../src/skills/flags.js";

const project = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-flags-"));
  fs.mkdirSync(path.join(cwd, ".git"));
  return cwd;
};
async function skills(argv) {
  const cwd = project();
  const out = [];
  const err = [];
  const code = await run(["skills", ...argv], { cwd, env: { ...process.env, TOOLGATE_DEFAULTS: path.join(cwd, "none.json"), XDG_CONFIG_HOME: path.join(cwd, "xdg"), XDG_CACHE_HOME: path.join(cwd, "cache") }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  return { code, err: err.join(""), files: fs.readdirSync(cwd).sort() };
}

test("a flag the action does not use is refused with exit 1 and the actions it applies to, before anything is written", async () => {
  for (const [argv, flag, applies] of [
    [["index", "--json"], "--json", /applies to search, status, recommended, install, update, remove/],
    [["index", "--dry-run"], "--dry-run", /applies to install, update, remove/],
    [["search", "x", "--force"], "--force", /applies to index, install, update, remove/],
    [["status", "--dry-run"], "--dry-run", /applies to/],
    [["status", "--user"], "--user", /applies to install, update, remove/],
    [["recommended", "--force"], "--force", /applies to/],
    [["install", "github:a/b", "--prune"], "--prune", /applies to update/],
    [["install", "github:a/b", "--source", "x"], "--source", /applies to update, remove/],
    [["update", "--ref", "main"], "--ref", /applies to install/],
    [["remove", "x", "--prune"], "--prune", /applies to update/],
    [["remove", "x", "--accept-license"], "--accept-license", /applies to update/],
  ]) {
    const result = await skills(argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.err, new RegExp(`toolgate skills ${argv[0]}: ${flag} is not supported here`));
    assert.match(result.err, applies);
    assert.deepEqual(result.files, [".git"], `nothing written for ${argv.join(" ")}`);
  }
});

test("the flags an action uses are accepted, and words after -- are not flags", () => {
  assert.equal(unsupportedFlag("install", ["install", "github:a/b", "--dry-run", "--json", "--force", "--local", "--ref", "x", "--path", "p", "--exclude", "e"]), null);
  assert.equal(unsupportedFlag("update", ["update", "--prune", "--source", "s", "--accept-license", "--user"]), null);
  assert.equal(unsupportedFlag("remove", ["remove", "n", "--keep-overrides", "--dry-run"]), null);
  assert.equal(unsupportedFlag("status", ["status", "--remote", "--check", "--json"]), null);
  assert.equal(unsupportedFlag("search", ["search", "--kind", "skill", "--json"]), null);
  assert.equal(unsupportedFlag("index", ["index", "--force"]), null);
  assert.equal(unsupportedFlag("install", ["install", "--", "--prune"]), null);
  assert.equal(unsupportedFlag("nothing", ["--prune"]), null, "an unknown action is reported by runSkills, not here");
});
