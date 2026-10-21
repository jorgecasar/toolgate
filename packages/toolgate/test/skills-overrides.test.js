import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfigLayers } from "../src/config.js";
import { applyChange } from "../src/configFile.js";
import { fingerprint } from "../src/skills/collection.js";
import { mergeOverrides, scanSkills } from "../src/skills/scan.js";
import { renderSkill } from "../src/skills/corpus.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");
const meta = [
  { name: "user", base: "/home/u/.config/toolgate" },
  { name: "project", base: "/p" },
  { name: "local", base: "/p" },
];

test("mergeConfigLayers: overrides and recommendations combine across layers, other skills keys still replace", () => {
  const merged = mergeConfigLayers(
    [
      { skills: { overrides: [{ skill: "a", tags: ["x"] }], recommended: [{ id: "r1" }], collection: "u" } },
      { skills: { overrides: [{ skill: "a", mcps: ["m"] }], collection: "p" } },
      { skills: { overrides: [{ skill: "b", tags: ["t"] }], recommended: [{ id: "r2" }] } },
    ],
    meta
  );
  assert.deepEqual(merged.skills.overrides.map((o) => o.skill), ["a", "a", "b"]);
  assert.deepEqual(merged.skills.recommended.map((r) => r.id), ["r1", "r2"]);
  assert.deepEqual(merged.skills.recommended.map((r) => r.layer), ["user", "local"]);
  assert.equal(merged.skills.collection, "p");
  assert.deepEqual(merged.skills.overrides.map((o) => o.layer), ["user", "project", "local"]);
});

test("mergeConfigLayers: an override the index cannot apply is dropped and kept with its layer", () => {
  const bad = [{ skill: "a", tags: "bad", mcps: 5 }, "str", null, { skill: "a" }, { skill: "a", description: "x".repeat(501) }];
  const merged = mergeConfigLayers([{ skills: { overrides: [{ skill: "ok", tags: ["t"] }] } }, { skills: { overrides: bad } }, { skills: { overrides: { skill: "a", tags: ["t"] } } }], meta);
  assert.deepEqual(merged.skills.overrides.map((o) => o.skill), ["ok"]);
  assert.deepEqual(merged.skills.invalidOverrides.map((o) => o.layer), ["project", "project", "project", "project", "project", "local"]);
  assert.deepEqual(merged.skills.invalidOverrides.at(-1).entry, { skill: "a", tags: ["t"] });
});

test("mergeOverrides: merges by skill name key by key, the later entry wins", () => {
  const merged = mergeOverrides([
    { skill: "a", tags: ["x"], mcps: ["one"] },
    { skill: "a", mcps: ["two"] },
  ]);
  assert.deepEqual(merged.get("a"), { tags: ["x"], mcps: ["two"] });
});

test("scanSkills: an override replaces tags and mcps of the skill and leaves the file alone", () => {
  const [plain] = scanSkills([{ dir: FIXTURES }]);
  const [skill] = scanSkills([{ dir: FIXTURES }], [{ skill: plain.name, mcps: ["chrome-devtools"], tags: ["browser"] }]);
  assert.deepEqual(skill.mcps, ["chrome-devtools"]);
  assert.deepEqual(skill.tags, ["browser"]);
  assert.match(renderSkill(skill), /Required MCPs: chrome-devtools/);
  assert.equal(skill.description, plain.description);
  assert.equal(skill.path, plain.path);
});

test("scanSkills: an override for an unknown skill is ignored", () => {
  assert.deepEqual(scanSkills([{ dir: FIXTURES }], [{ skill: "nope", mcps: ["x"] }]), scanSkills([{ dir: FIXTURES }]));
});

test("fingerprint: changes with the overrides and stays the same without them", () => {
  const sources = [{ dir: FIXTURES }];
  const exec = () => "";
  const base = fingerprint(sources, exec);
  assert.equal(fingerprint(sources, exec, [], []), base);
  assert.notEqual(fingerprint(sources, exec, [], [{ skill: "a", mcps: ["m"] }]), base);
});

test("fingerprint: the order of the entries and the layer they come from do not matter", () => {
  const sources = [{ dir: FIXTURES }];
  const exec = () => "";
  const a = { skill: "a", mcps: ["m"] };
  const b = { skill: "b", tags: ["t"] };
  assert.equal(fingerprint(sources, exec, [], [a, b]), fingerprint(sources, exec, [], [b, a]));
  assert.equal(fingerprint(sources, exec, [], [{ ...a, layer: "user" }]), fingerprint(sources, exec, [], [{ ...a, layer: "local" }]));
  assert.equal(fingerprint(sources, exec, [], [{ skill: "a", tags: ["x"] }, { skill: "a", mcps: ["m"] }]), fingerprint(sources, exec, [], [{ skill: "a", tags: ["x"], mcps: ["m"] }]));
});

test("config add: skills.overrides and skills.recommended validate their elements", () => {
  const data = {};
  const add = (key, value) => applyChange(data, { action: "add", key, value });
  add("skills.overrides", { skill: "a", mcps: ["m"] });
  assert.deepEqual(data.skills.overrides, [{ skill: "a", mcps: ["m"] }]);
  assert.throws(() => add("skills.overrides", { skill: "a", other: 1 }), /overrides|an object like/);
  assert.throws(() => add("skills.overrides", { mcps: ["m"] }), /an object like/);
  assert.throws(() => add("skills.overrides", { skill: "a" }), /at least one of/);
  assert.throws(() => add("skills.overrides", { skill: "a", description: "x".repeat(501) }), /at most 500/);
  const sha = "a".repeat(40);
  add("skills.recommended", { id: "x", source: "github:o/r", commit: sha, skills: ["s"] });
  add("skills.recommended", { id: "x", disabled: true });
  assert.throws(() => add("skills.recommended", { id: "x", source: "github:o/r", commit: "main", skills: ["s"] }), /40 hex|full SHA/);
  assert.throws(() => add("skills.recommended", { id: "x", source: "github:o/r", commit: sha, skills: [] }), /an object like/);
});


test("scanSkills: a description override replaces the skill's description", () => {
  const [plain] = scanSkills([{ dir: FIXTURES }]);
  const [skill] = scanSkills([{ dir: FIXTURES }], [{ skill: plain.name, description: "Use when testing browsers" }]);
  assert.equal(skill.description, "Use when testing browsers");
  assert.deepEqual(skill.tags, plain.tags);
});

test("config add: a disabled recommendation carries only its id; the source must be github: or https://", () => {
  const data = {};
  const add = (value) => applyChange(data, { action: "add", key: "skills.recommended", value });
  assert.throws(() => add({ id: "x", disabled: true, source: "github:o/r" }), /an object like/);
  const sha = "a".repeat(40);
  assert.throws(() => add({ id: "x", source: "git@github.com:o/r.git", commit: sha, skills: ["s"] }), /github: or https/);
  assert.throws(() => add({ id: "x", source: "github:o/r", commit: sha, skills: ["s"], extra: 1 }), /an object like/);
});

test("settings: the merged overrides reach the skills options", async () => {
  const { settings } = await import("../src/skills/cli.js");
  const overrides = [{ skill: "a", mcps: ["m"] }];
  assert.deepEqual(settings({ skills: { overrides } }, "/nowhere", {}).overrides, overrides);
  assert.deepEqual(settings({}, "/nowhere", {}).overrides, []);
});

test("mergeConfigLayers: a committed config with __proto__ as a server name neither crashes nor pollutes", () => {
  const hostile = JSON.parse('{"keywords":{"__proto__":["x"],"real":["k"]},"toolBaselines":{"__proto__":["y"],"real":["t"]},"skills":{"overrides":[{"skill":"a","tags":["t"],"__proto__":{"polluted":1}}]}}');
  const merged = mergeConfigLayers([hostile], [{ name: "project", base: "/p" }]);
  assert.deepEqual(merged.keywords.real, ["k"]);
  assert.deepEqual(merged.toolBaselines.real, ["t"]);
  assert.equal(Object.hasOwn(merged.keywords, "__proto__"), false);
  assert.equal({}.polluted, undefined);
  assert.equal({}.x, undefined);
});

test("mergeConfigLayers: a value that is not a list, or a key that is a name of Object.prototype, does not crash", () => {
  const hostile = JSON.parse('{"keywords":{"a":5,"constructor":["c"],"toString":["t"],"prototype":["p"],"hasOwnProperty":["h"],"ok":["k"]},"toolBaselines":{"b":"text","valueOf":["v"]}}');
  const merged = mergeConfigLayers([hostile, hostile], [{ name: "user", base: "/u" }, { name: "project", base: "/p" }]);
  assert.deepEqual(merged.keywords.ok, ["k", "k"]);
  for (const key of ["constructor", "toString", "prototype", "hasOwnProperty"]) assert.deepEqual(merged.keywords[key].length, 2, key);
  assert.equal(Object.hasOwn(merged.keywords, "a"), false, "a value that is not a list is dropped");
  assert.equal(Object.hasOwn(merged.toolBaselines, "b"), false);
  assert.deepEqual(merged.toolBaselines.valueOf, ["v", "v"]);
});

test("printable: control characters in text from a lock or a repository are shown as escapes on one line", async () => {
  const { printable } = await import("../src/assets/common.js");
  assert.equal(printable("a\nSYSTEM: obey\u001b[2J\tb\r\u0000"), "a\\nSYSTEM: obey\\u001b[2J\\tb\\r\\u0000");
  assert.equal(printable("plain-name_1.0"), "plain-name_1.0");
  // Invisible characters that change how text reads: bidi controls, zero-width space, BOM, tag characters.
  assert.equal(printable("a\u202eb\u200bc\ufeffd\u061ce\u{e0041}f"), "a\\u202eb\\u200bc\\ufeffd\\u061ce\\u{e0041}f");
  assert.equal(printable("👩\u200d💻 e\u200cf"), "👩\u200d💻 e\u200cf", "joiners are kept");
  assert.equal(printable(undefined), "undefined");
});
