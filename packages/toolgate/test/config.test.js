import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configLayerPaths,
  mergeConfigLayers,
  loadConfig,
  loadState,
  resolveConfig,
  saveState,
  consumeEscalations,
} from "../src/config.js";
import { computeActiveServers } from "../src/activeSet.js";

function tmpFile(contents) {
  const file = path.join(
    os.tmpdir(),
    `toolgate-config-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  );
  if (contents !== undefined) fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

test("mergeConfigLayers: baseline REPLACEs, later layer wins", () => {
  const merged = mergeConfigLayers([{ baseline: ["docs"] }, { baseline: ["docs", "repo"] }]);
  assert.deepEqual(merged.baseline, ["docs", "repo"]);
});

test("mergeConfigLayers: keywords and toolBaselines merge by appending per server", () => {
  const merged = mergeConfigLayers([
    { keywords: { repo: ["pull request"] }, toolBaselines: { repo: ["listPRs"] } },
    { keywords: { repo: ["merge"], tasks: ["sprint"] }, toolBaselines: { repo: ["getPR"] } },
  ]);
  assert.deepEqual(merged.keywords.repo, ["pull request", "merge"]);
  assert.deepEqual(merged.keywords.tasks, ["sprint"]);
  assert.deepEqual(merged.toolBaselines.repo, ["listPRs", "getPR"]);
});

test("mergeConfigLayers: missing/null layers are skipped without breaking the merge", () => {
  const merged = mergeConfigLayers([null, { baseline: ["docs"] }, undefined]);
  assert.deepEqual(merged.baseline, ["docs"]);
});

test("mergeConfigLayers: empty input yields an empty config", () => {
  const merged = mergeConfigLayers([]);
  assert.deepEqual(merged, {
    baseline: [],
    commands: {},
    keywords: {},
    toolBaselines: {},
    client: {},
    qmd: {},
    router: {},
    serverMeta: {},
    skills: {},
    subagents: {},
    hooks: {},
    permissions: {},
  });
});

test("mergeConfigLayers: skills sources concatenate and other keys are decided by the later layer", () => {
  const merged = mergeConfigLayers([
    { skills: { sources: [{ dir: "a" }], collection: "one", corpusDir: "c1" } },
    { skills: { sources: [{ dir: "b" }], collection: "two" } },
  ]);
  assert.deepEqual(merged.skills, { sources: [{ dir: "a" }, { dir: "b" }], collection: "two", corpusDir: "c1" });
});

const LAYERS = [
  { name: "user", base: "/home/me/.config/toolgate" },
  { name: "project", base: "/repo" },
  { name: "local", base: "/repo" },
];

test("mergeConfigLayers: each source is tagged with its level and resolved against that layer's base", () => {
  const merged = mergeConfigLayers(
    [
      { skills: { sources: [{ dir: "skills" }] } },
      { skills: { sources: [{ dir: ".rulesync/skills", glob: "*/SKILL.md" }] } },
      { skills: { sources: [{ dir: "/tmp/try" }] } },
    ],
    LAYERS
  );
  assert.deepEqual(merged.skills.sources, [
    { dir: "/home/me/.config/toolgate/skills", level: "user" },
    { dir: "/repo/.rulesync/skills", glob: "*/SKILL.md", level: "project" },
    { dir: "/tmp/try", level: "local" },
  ]);
});

test("mergeConfigLayers: the project can switch off user-level and local-level skills", () => {
  const layers = (project) => [
    { skills: { sources: [{ dir: "u" }] } },
    { skills: { sources: [{ dir: "p" }], ...project } },
    { skills: { sources: [{ dir: "l" }] } },
  ];
  const levels = (project) => mergeConfigLayers(layers(project), LAYERS).skills.sources.map((s) => s.level);
  assert.deepEqual(levels({}), ["user", "project", "local"]);
  assert.deepEqual(levels({ userLevel: false }), ["project", "local"]);
  assert.deepEqual(levels({ localLevel: false }), ["user", "project"]);
  assert.deepEqual(levels({ userLevel: false, localLevel: false }), ["project"]);
});

test("mergeConfigLayers: only the project layer's switches count, and the switches are not exposed", () => {
  const merged = mergeConfigLayers(
    [{ skills: { sources: [{ dir: "u" }] } }, { skills: {} }, { skills: { userLevel: false, localLevel: true } }],
    LAYERS
  );
  assert.deepEqual(merged.skills.sources.map((s) => s.level), ["user"]);
  assert.equal("userLevel" in merged.skills, false);
  assert.equal("localLevel" in merged.skills, false);
});

test("loadConfig: skills from the user, project and local files are combined with their levels", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-levels-"));
  const user = path.join(dir, "user", "config.json");
  fs.mkdirSync(path.dirname(user));
  fs.writeFileSync(user, JSON.stringify({ skills: { sources: [{ dir: "mine" }] } }));
  fs.mkdirSync(path.join(dir, "proj", ".toolgate"), { recursive: true });
  fs.writeFileSync(path.join(dir, "proj", ".toolgate", "config.json"), JSON.stringify({ skills: { sources: [{ dir: "team" }] } }));
  fs.writeFileSync(path.join(dir, "proj", ".toolgate", "config.local.json"), JSON.stringify({ skills: { sources: [{ dir: "try" }] } }));

  const merged = loadConfig(configLayerPaths({ cwd: path.join(dir, "proj"), env: { TOOLGATE_DEFAULTS: user }, homedir: dir }));
  assert.deepEqual(merged.skills.sources, [
    { dir: path.join(dir, "user", "mine"), level: "user" },
    { dir: path.join(dir, "proj", "team"), level: "project" },
    { dir: path.join(dir, "proj", "try"), level: "local" },
  ]);
});

test("mergeConfigLayers: client capability override merges, later layer wins", () => {
  const merged = mergeConfigLayers([
    { client: { defersToolSchemas: true } },
    { client: { defersToolSchemas: false } },
  ]);
  assert.deepEqual(merged.client, { defersToolSchemas: false });
});

test("loadConfig reads and merges config files from disk, in order", () => {
  const shared = tmpFile({ baseline: ["docs"], keywords: { repo: ["pull request"] } });
  const project = tmpFile({ baseline: ["docs", "repo"], keywords: { repo: ["merge"] } });
  const merged = loadConfig([shared, project]);
  assert.deepEqual(merged.baseline, ["docs", "repo"]);
  assert.deepEqual(merged.keywords.repo, ["pull request", "merge"]);
  fs.unlinkSync(shared);
  fs.unlinkSync(project);
});

test("loadConfig tolerates a missing config file (fail-open, empty layer)", () => {
  const merged = loadConfig(["/nonexistent/toolgate/config.json"]);
  assert.deepEqual(merged.baseline, []);
  assert.deepEqual(merged.keywords, {});
});

test("loadState defaults to an idle state when the state file is absent", () => {
  const state = loadState("/nonexistent/toolgate/state.json");
  assert.deepEqual(state, { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] });
});

test("loadState reads a previously saved state file", () => {
  const statePath = tmpFile({
    extras: ["karajan"],
    toolExtras: { repo: ["mergePullRequest"] },
    pendingRestart: true,
    subagentExtras: ["review", 5],
  });
  const state = loadState(statePath);
  assert.deepEqual(state, {
    subagentExtras: ["review"],
    extras: ["karajan"],
    toolExtras: { repo: ["mergePullRequest"] },
    pendingRestart: true,
  });
  fs.unlinkSync(statePath);
});

test("saveState writes state to disk and loadState reads it back", () => {
  const statePath = tmpFile();
  saveState(statePath, { extras: ["x"], toolExtras: {}, pendingRestart: true });
  const state = loadState(statePath);
  assert.deepEqual(state, { extras: ["x"], toolExtras: {}, pendingRestart: true, subagentExtras: [] });
  fs.unlinkSync(statePath);
});

test("consumeEscalations resets extras/toolExtras/pendingRestart", () => {
  const consumed = consumeEscalations({ extras: ["x"], toolExtras: { repo: ["y"] }, pendingRestart: true });
  assert.deepEqual(consumed, { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] });
});

test("configLayerPaths: user defaults, project, local, in that order", () => {
  const layers = configLayerPaths({ cwd: "/repo", env: {}, homedir: "/home/me" });
  assert.deepEqual(layers, [
    { name: "user", path: "/home/me/.config/toolgate/config.json", base: "/home/me/.config/toolgate" },
    { name: "project", path: "/repo/.toolgate/config.json", base: "/repo" },
    { name: "local", path: "/repo/.toolgate/config.local.json", base: "/repo" },
  ]);
});

test("configLayerPaths: TOOLGATE_DEFAULTS wins over XDG_CONFIG_HOME, which wins over ~/.config", () => {
  const user = (env) => configLayerPaths({ cwd: "/repo", env, homedir: "/home/me" })[0].path;
  assert.equal(user({ XDG_CONFIG_HOME: "/xdg" }), "/xdg/toolgate/config.json");
  assert.equal(user({ XDG_CONFIG_HOME: "/xdg", TOOLGATE_DEFAULTS: "/etc/tg.json" }), "/etc/tg.json");
});

function layerFiles(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-layers-"));
  return Object.entries(contents).map(([name, value]) => {
    const file = path.join(dir, `${name}.json`);
    if (typeof value === "string") fs.writeFileSync(file, value);
    else if (value !== undefined) fs.writeFileSync(file, JSON.stringify(value));
    return { name, path: file };
  });
}

test("loadConfig: user, project and local layers combine with the existing merge rules", () => {
  const layers = layerFiles({
    user: { baseline: ["docs"], keywords: { repo: ["pull request"] }, client: { defersToolSchemas: true } },
    project: { baseline: ["docs", "repo"], keywords: { repo: ["merge"] }, toolBaselines: { repo: ["getPR"] } },
    local: { keywords: { repo: ["branch"] }, client: { defersToolSchemas: false }, router: { backend: "qmd" } },
  });
  const merged = loadConfig(layers);
  assert.deepEqual(merged.baseline, ["docs", "repo"]);
  assert.deepEqual(merged.keywords.repo, ["pull request", "merge", "branch"]);
  assert.deepEqual(merged.toolBaselines.repo, ["getPR"]);
  assert.deepEqual(merged.client, { defersToolSchemas: false });
  assert.deepEqual(merged.router, { backend: "qmd" });
});

test("loadConfig: each layer works alone, and a missing layer is skipped", () => {
  for (const name of ["user", "project", "local"]) {
    const layers = layerFiles({ user: undefined, project: undefined, local: undefined });
    fs.writeFileSync(layers.find((l) => l.name === name).path, JSON.stringify({ baseline: [name] }));
    assert.deepEqual(loadConfig(layers).baseline, [name]);
  }
});

test("loadConfig: a later layer's baseline replaces the earlier one", () => {
  const layers = layerFiles({ user: { baseline: ["a", "b"] }, project: undefined, local: { baseline: ["c"] } });
  assert.deepEqual(loadConfig(layers).baseline, ["c"]);
});

test("resolveConfig: reports which layers contributed each key", () => {
  const layers = layerFiles({
    user: { baseline: ["docs"], keywords: { repo: ["pull request"] } },
    project: { keywords: { repo: ["merge"], tasks: ["sprint"] }, serverMeta: { repo: { label: "R" } } },
    local: { baseline: ["repo"] },
  });
  const { config, origins, errors } = resolveConfig(layers);
  assert.deepEqual(config.baseline, ["repo"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(origins.baseline, ["user", "local"]);
  assert.deepEqual(origins["keywords.repo"], ["user", "project"]);
  assert.deepEqual(origins["keywords.tasks"], ["project"]);
  assert.deepEqual(origins["serverMeta.repo"], ["project"]);
});

test("resolveConfig: a malformed layer is reported, not silently dropped, and the rest still merge", () => {
  const layers = layerFiles({ user: "{ not json", project: { baseline: ["docs"] }, local: undefined });
  const { config, errors } = resolveConfig(layers);
  assert.deepEqual(config.baseline, ["docs"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].layer, "user");
  assert.match(errors[0].message, /JSON/);
});

test("the layers give the same active set as the single project file they replace", () => {
  const single = { baseline: ["docs"], keywords: { repo: ["pull request"] }, toolBaselines: { repo: ["getPR"] } };
  const layered = loadConfig(
    layerFiles({
      user: { keywords: { repo: ["pull request"] } },
      project: { baseline: ["docs"], toolBaselines: { repo: ["getPR"] } },
      local: undefined,
    })
  );
  const state = { extras: [], toolExtras: {}, pendingRestart: false };
  const prompt = "open a pull request";
  assert.deepEqual(
    [...computeActiveServers(layered, state, prompt)],
    [...computeActiveServers(mergeConfigLayers([single]), state, prompt)]
  );
});

test("mergeConfigLayers: null source entries survive the level switches", () => {
  const merged = mergeConfigLayers(
    [null, { skills: { userLevel: false, sources: [null, { dir: "p" }] } }, null],
    LAYERS
  );
  assert.deepEqual(merged.skills.sources, [null, { dir: "/repo/p", level: "project" }]);
});

test("mergeConfigLayers: ~ in a source dir expands to the home directory", () => {
  const merged = mergeConfigLayers([{ skills: { sources: [{ dir: "~/skills" }] } }], LAYERS);
  assert.equal(merged.skills.sources[0].dir, path.join(os.homedir(), "skills"));
});

test("mergeConfigLayers: the user layer does not set collection or corpusDir, and declared levels are recorded", () => {
  const merged = mergeConfigLayers(
    [
      { skills: { collection: "shared", corpusDir: "/shared", sources: [] } },
      { skills: { collection: "mine", sources: [] } },
      null,
    ],
    LAYERS
  );
  assert.equal(merged.skills.collection, "mine");
  assert.equal("corpusDir" in merged.skills, false);
  assert.deepEqual(merged.skills.declaredLevels, ["user", "project"]);
});

test("defaultAgent: the later layer wins and non-strings are ignored", async () => {
  const { mergeConfigLayers } = await import("../src/config.js");
  assert.equal(mergeConfigLayers([{ defaultAgent: "codex" }, { defaultAgent: "claude-code" }]).defaultAgent, "claude-code");
  assert.equal(mergeConfigLayers([{ defaultAgent: "codex" }, { defaultAgent: 3 }]).defaultAgent, "codex");
  assert.equal(mergeConfigLayers([{}]).defaultAgent, undefined);
});

import { mergeConfigLayers as mergeForLevels } from "../src/config.js";
test("mergeConfigLayers: a project that switches a level off lists it in skills.disabledLevels", () => {
  const meta = [{ name: "user", base: "/u" }, { name: "project", base: "/p" }, { name: "local", base: "/p" }];
  const merged = mergeForLevels([{ skills: { sources: [{ dir: "x" }] } }, { skills: { userLevel: false } }, {}], meta);
  assert.deepEqual(merged.skills.disabledLevels, ["user"]);
  assert.deepEqual(merged.skills.sources, []);
  assert.equal(mergeForLevels([{}, {}, {}], meta).skills.disabledLevels, undefined);
});
test("mergeConfigLayers: subagents sources are tagged by level like commands, and the project can switch user and local levels off", () => {
  const merged = mergeConfigLayers(
    [{ subagents: { sources: [{ dir: "~u", dialect: "opencode" }] } }, { subagents: { sources: [{ dir: "p" }], userLevel: false } }],
    [{ name: "user", base: "/home/u" }, { name: "project", base: "/proj" }],
  );
  assert.deepEqual(merged.subagents.disabledLevels, ["user"]);
  assert.deepEqual(merged.subagents.sources, [{ dir: path.resolve("/proj", "p"), level: "project" }]);
  assert.equal(merged.subagents.userLevel, undefined);
});
test("consumeEscalations gives a fresh list of subagents each time: pushing to one never changes the idle state", () => {
  const first = consumeEscalations();
  first.subagentExtras.push("leak");
  assert.deepEqual(consumeEscalations().subagentExtras, []);
});
test("mergeConfigLayers: the project can switch the user and local levels of hooks off, like for the other kinds", () => {
  const merged = mergeConfigLayers(
    [{ hooks: { userLevel: true } }, { hooks: { userLevel: false, localLevel: false } }],
    [{ name: "user", base: "/home/u" }, { name: "project", base: "/proj" }],
  );
  assert.deepEqual(merged.hooks.disabledLevels, ["user", "local"]);
  assert.equal(merged.hooks.userLevel, undefined);
});
test("mergeConfigLayers: the project can switch the user and local levels of permissions off", () => {
  const merged = mergeConfigLayers(
    [{ permissions: { userLevel: true } }, { permissions: { localLevel: false } }],
    [{ name: "user", base: "/home/u" }, { name: "project", base: "/proj" }],
  );
  assert.deepEqual(merged.permissions.disabledLevels, ["local"]);
  assert.equal(merged.permissions.localLevel, undefined);
});

