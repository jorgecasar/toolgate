import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addStoreSource, ensureIndexedSource } from "../src/sources.js";
import { git, isolateGitConfig } from "./support/git.js";
isolateGitConfig();

const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-sources-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the source goes to the config of the level of the install: project, local, or the user's (relative to its own base)", () => {
  const cwd = tmp("project");
  const xdg = tmp("xdg");
  const env = { XDG_CONFIG_HOME: xdg, HOME: tmp("home") };
  const project = addStoreSource({ kind: "skills", level: "project", storeDir: ".toolgate/skills", cwd, env });
  assert.deepEqual(read(path.join(cwd, ".toolgate/config.json")).skills.sources, [{ dir: ".toolgate/skills" }]);
  assert.equal(project.layer, "project");
  addStoreSource({ kind: "commands", level: "local", storeDir: ".toolgate/commands.local", cwd, env });
  assert.deepEqual(read(path.join(cwd, ".toolgate/config.local.json")).commands.sources, [{ dir: ".toolgate/commands.local" }]);
  assert.equal(read(path.join(cwd, ".toolgate/config.json")).commands, undefined, "a personal level never goes to the project's file");
  addStoreSource({ kind: "subagents", level: "user", storeDir: "subagents", cwd, env });
  assert.deepEqual(read(path.join(xdg, "toolgate/config.json")).subagents.sources, [{ dir: "subagents" }]);
  assert.equal(read(path.join(cwd, ".toolgate/config.json")).subagents, undefined);
  assert.equal(addStoreSource({ kind: "skills", level: "project", storeDir: ".toolgate/skills", cwd, env }).added, false, "twice is not twice");
});

test("a tracked project config that is missing, or one that is not JSON, is not touched: the reason comes back", () => {
  const env = { XDG_CONFIG_HOME: tmp("xdg"), HOME: tmp("home") };
  const repo = tmp("repo");
  git(repo, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(repo, ".toolgate"));
  fs.writeFileSync(path.join(repo, ".toolgate/config.json"), "{}\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c");
  fs.rmSync(path.join(repo, ".toolgate/config.json"));
  assert.throws(() => addStoreSource({ kind: "skills", level: "project", storeDir: ".toolgate/skills", cwd: repo, env }), /tracked by git but missing here; restore it with: git restore/);
  assert.equal(fs.existsSync(path.join(repo, ".toolgate/config.json")), false);
  const bad = tmp("bad");
  fs.mkdirSync(path.join(bad, ".toolgate"));
  fs.writeFileSync(path.join(bad, ".toolgate/config.json"), "{ nope");
  assert.throws(() => addStoreSource({ kind: "skills", level: "project", storeDir: ".toolgate/skills", cwd: bad, env }), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(bad, ".toolgate/config.json"), "utf8"), "{ nope");
});

test("ensureIndexedSource: a store that already is a source is left alone, a missing one is added to the options too", () => {
  const cwd = tmp("ensure");
  const env = { XDG_CONFIG_HOME: tmp("xdg"), HOME: tmp("home") };
  const out = [];
  const stdout = { write: (s) => out.push(s) };
  const present = { sources: [{ dir: path.join(cwd, ".toolgate/skills") }] };
  assert.equal(ensureIndexedSource({ kind: "skills", noun: "skills", level: "project", storeDir: ".toolgate/skills", root: cwd, options: present, sourcesKey: "sources", cwd, env, stdout }), true);
  assert.equal(fs.existsSync(path.join(cwd, ".toolgate")), false, "nothing was written");
  const missing = { sources: [] };
  assert.equal(ensureIndexedSource({ kind: "skills", noun: "skills", level: "project", storeDir: ".toolgate/skills", root: cwd, options: missing, sourcesKey: "sources", cwd, env, stdout }), true);
  assert.deepEqual(missing.sources, [{ dir: path.join(cwd, ".toolgate/skills") }], "the same run indexes it");
  assert.match(out.join(""), /added skills\.sources/);
});

test("ensureIndexedSource: a config that already lists the store but does not resolve to it is reported, not claimed as fixed", () => {
  const cwd = tmp("listed");
  const env = { XDG_CONFIG_HOME: tmp("xdg"), HOME: tmp("home") };
  addStoreSource({ kind: "skills", level: "project", storeDir: ".toolgate/skills", cwd, env });
  const out = [];
  const options = { sources: [] }; // what the run computed: the entry is not in effect there (a disabled level, for one)
  const ok = ensureIndexedSource({ kind: "skills", noun: "skills", level: "project", storeDir: ".toolgate/skills", root: cwd, options, sourcesKey: "sources", cwd, env, stdout: { write: (s) => out.push(s) } });
  assert.equal(ok, false);
  assert.match(out.join(""), /already lists it, but it does not resolve to this store.*toolgate config add skills\.sources/);
  assert.deepEqual(options.sources, []);
});
