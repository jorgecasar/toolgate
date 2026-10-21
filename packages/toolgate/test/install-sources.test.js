import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { defaultExec } from "../src/daemon.js";
import { git as hermeticGit } from "./support/git.js";

const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-instsrc-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const git = (cwd, ...args) => hermeticGit(cwd, ...args);
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

// What each kind installs from a real repository, where its store is at each level, and which settings key lists its sources.
const KINDS = {
  skills: { files: { "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: the alpha skill\n---\nbody\n" }, stores: { project: ".toolgate/skills", local: ".toolgate/skills.local", user: "skills" }, sourcesKey: "sources" },
  commands: { files: { "commands/review.md": "---\ndescription: Review a pull request\n---\nReview it.\n" }, stores: { project: ".toolgate/commands", local: ".toolgate/commands.local", user: "commands" }, sourcesKey: "commandSources" },
  subagents: { files: { "subagents/helper.md": "---\ndescription: Helps\n---\nHelp.\n" }, stores: { project: ".toolgate/subagents", local: ".toolgate/subagents.local", user: "subagents" }, sourcesKey: "subagentSources" },
};
function remote(files) {
  const root = tmp("remote");
  git(root, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) put(root, file, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return `file://${root}`;
}
// `sources` stands for "the sources this run computed": an empty list makes the store one that is not listed, at any level.
function project({ config = {}, sources } = {}) {
  const cwd = tmp("project");
  const xdg = tmp("xdg");
  const out = [];
  const execFn = (bin, args) => (args[1] === "show" ? `Collection: ${args[2]}\n  Path:     ${path.join(cwd, ".toolgate/skills-index/corpus")}\n` : "");
  const exec = async (args) => {
    out.length = 0;
    const code = await run(args, {
      cwd,
      env: { HOME: tmp("home"), XDG_CONFIG_HOME: xdg, XDG_CACHE_HOME: tmp("cache") },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => out.push(s) },
      loadConfigFn: () => config,
      daemon: { status: async () => ({ running: false }) },
      skills: { execFn, ...(sources ? { sources: [], commandSources: [], subagentSources: [] } : {}) },
      install: { allowFile: true, cache: tmp("cache"), execFn: defaultExec },
    });
    return { code, out: out.join("") };
  };
  const exists = (file) => fs.existsSync(path.join(cwd, file));
  const read = (file) => JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8"));
  return { cwd, xdg, exec, exists, read, userConfig: path.join(xdg, "toolgate/config.json") };
}

for (const [kind, spec] of Object.entries(KINDS)) {
  test(`${kind} install --local writes the local config, --user the user's, and never the project's`, async () => {
    const local = project({ sources: [] });
    const resultLocal = await local.exec([kind, "install", remote(spec.files), "--local"]);
    assert.equal(resultLocal.code, 0, resultLocal.out);
    assert.match(resultLocal.out, new RegExp(`added ${kind}\\.sources .* to the local config`));
    assert.deepEqual(local.read(".toolgate/config.local.json")[kind].sources, [{ dir: spec.stores.local }]);
    assert.equal(local.exists(".toolgate/config.json"), false, "the project's file is not touched by a personal level");
    const user = project({ sources: [] });
    const resultUser = await user.exec([kind, "install", remote(spec.files), "--user"]);
    assert.equal(resultUser.code, 0, resultUser.out);
    assert.match(resultUser.out, new RegExp(`added ${kind}\\.sources .* to the user config`));
    assert.deepEqual(JSON.parse(fs.readFileSync(user.userConfig, "utf8"))[kind].sources, [{ dir: spec.stores.user }]);
    assert.equal(user.exists(".toolgate/config.json"), false);
    assert.equal(user.exists(".toolgate/config.local.json"), false);
  });

  test(`${kind} install leaves the config alone when its own kind's sources already list the store`, async () => {
    const p = project({ config: { [kind]: { sources: [{ dir: spec.stores.project }] } } });
    const result = await p.exec([kind, "install", remote(spec.files)]);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /added .*sources/);
    assert.equal(p.exists(".toolgate/config.json"), false, "it is listed already: nothing to write");
  });
}

test("an install that installs nothing writes no config at any level, and the old command is what it prints", async () => {
  const invalid = {
    skills: { "skills/bad/SKILL.md": "---\ndescription: no name\n---\nbody\n" },
    commands: { "commands/bad name!.md": "---\ndescription: x\n---\nbody\n" },
    subagents: { "subagents/bad name!.md": "---\ndescription: x\n---\nbody\n" },
  };
  for (const kind of Object.keys(invalid)) {
    for (const flags of [[], ["--local"], ["--user"]]) {
      const p = project({ sources: [] });
      const result = await p.exec([kind, "install", remote(invalid[kind]), ...flags]);
      assert.match(result.out, /installed 0 /, `${kind} ${flags.join(" ")}: nothing was installed (${result.out.slice(0, 100)})`);
      assert.equal(p.exists(".toolgate/config.json") || p.exists(".toolgate/config.local.json") || fs.existsSync(p.userConfig), false, `${kind} ${flags.join(" ")}: no config written`);
    }
  }
});
