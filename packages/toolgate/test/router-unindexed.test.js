// A checkout with skills and no skills index (a new git worktree) says so in `warnings` of need and route (#197).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createQmdBackend, route } from "../src/router.js";
import { NOT_INDEXED, skillsButNoIndex } from "../src/skills/unindexed.js";
const BIN = path.resolve(import.meta.dirname, "..", "bin", "toolgate.js");
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const TEXT = "skills are not indexed in this checkout; run toolgate skills index";
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-ui-")));
  made.push(dir);
  return dir;
};
/** A project with one skill in .toolgate/skills/ and, when asked, an index in `corpus` (default or the given folder). */
function project({ skill = true, index = null } = {}) {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), JSON.stringify({ defaultAgent: "claude-code", router: { backend: "qmd", qmdUrl: null } }));
  if (skill) {
    fs.mkdirSync(path.join(cwd, ".toolgate", "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".toolgate", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nBody\n");
  }
  if (index) {
    fs.mkdirSync(path.resolve(cwd, index), { recursive: true });
    fs.writeFileSync(path.resolve(cwd, index, "_index.md"), "# index\n");
  }
  return cwd;
}
const DEFAULT_CORPUS = path.join(".toolgate", "skills-index", "corpus");
const match = async (cwd, config = {}) => {
  const env = { HOME: tmp(), XDG_CONFIG_HOME: tmp(), PATH: "" };
  return createQmdBackend({ daemonUrl: null, execFn: () => "[]", cwd, env }).match("open a pull request", config);
};
test("skills and no _index.md: the exact warning, once", async () => {
  const result = await match(project());
  assert.equal(NOT_INDEXED, TEXT);
  assert.deepEqual(result.warnings, [TEXT]);
});
test("an _index.md in the corpus folder: no warning; the folder alone is not an index", async () => {
  assert.deepEqual((await match(project({ index: DEFAULT_CORPUS }))).warnings, []);
  const cwd = project();
  fs.mkdirSync(path.join(cwd, DEFAULT_CORPUS), { recursive: true });
  assert.deepEqual((await match(cwd)).warnings, [TEXT]);
});
test("no skills at all: no warning", async () => {
  assert.deepEqual((await match(project({ skill: false }))).warnings, []);
});
test("skills.corpusDir is the folder that is checked", async () => {
  const elsewhere = { skills: { corpusDir: "elsewhere/corpus" } };
  assert.deepEqual((await match(project({ index: DEFAULT_CORPUS }), elsewhere)).warnings, [TEXT], "the default folder has one, the configured one does not");
  assert.deepEqual((await match(project({ index: "elsewhere/corpus" }), elsewhere)).warnings, []);
});
test("the regex backend never routes skills: no warning", async () => {
  const result = await route("open a pull request", { router: { backend: "regex" } }, { backend: "regex" });
  assert.deepEqual(result.warnings ?? [], []);
});
test("skillsButNoIndex: an unreadable corpus folder counts as no index; a failing scan says nothing", () => {
  const cwd = project();
  const env = { HOME: tmp(), XDG_CONFIG_HOME: tmp() };
  assert.equal(skillsButNoIndex({}, cwd, env, { existsFn: () => false }), true);
  assert.equal(skillsButNoIndex({}, cwd, env, { existsFn: () => { throw new Error("boom"); } }), false);
  assert.equal(skillsButNoIndex({ skills: { sources: "not a list" } }, cwd, env), false);
});
test("route and need carry the warning through the real CLI, in json and in text", () => {
  // A child process in the project: the built-in qmd backend looks at the process's own directory. `qmd.bin` is a stub
  // that answers no hits, so no real qmd runs.
  const cwd = project();
  const home = tmp();
  const stub = path.join(home, "qmd-stub");
  fs.writeFileSync(stub, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ qmd: { bin: stub } }));
  const env = { PATH: process.env.PATH, TOOLGATE_DEFAULTS: path.join(home, "config.json"), HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"), QMD_SHARED_PORT: process.env.QMD_SHARED_PORT };
  const go = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(go("need", "open a pull request", "--json")).warnings.filter((w) => w === TEXT), [TEXT]);
  assert.deepEqual(JSON.parse(go("route", "--prompt", "open a pull request", "--backend", "qmd")).warnings.filter((w) => w === TEXT), [TEXT]);
  assert.ok(go("need", "open a pull request").includes(TEXT));
});
