import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyChange,
  editConfigFile,
  formatConfig,
  ignoredWhat,
  isIgnored,
  isTracked,
  parseValue,
  parseValueFor,
  readConfigFile,
  trackedAndMissing,
  validPort,
  writeConfigFile,
} from "../src/configFile.js";

const REPO_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".toolgate", "config.json");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-configfile-")), "config.json");
const change = (data, action, key, value, layer) => applyChange(data, { action, key, value, layer });

test("set: scalars of each type, creating the parents that are missing", () => {
  const data = {};
  assert.equal(change(data, "set", "router.backend", "qmd"), true);
  assert.equal(change(data, "set", "router.minScore", 0.6), true);
  assert.equal(change(data, "set", "client.defersToolSchemas", null), true);
  assert.equal(change(data, "set", "skills.collection", "my-collection"), true);
  assert.equal(change(data, "set", "serverMeta.repo.tier", "cheap"), true);
  assert.equal(change(data, "set", "serverMeta.repo.install", "npx repo-mcp"), true);
  assert.deepEqual(data, {
    router: { backend: "qmd", minScore: 0.6 },
    client: { defersToolSchemas: null },
    skills: { collection: "my-collection" },
    serverMeta: { repo: { tier: "cheap", install: "npx repo-mcp" } },
  });
});

test("set: a value of the wrong type or outside the allowed ones is refused and names the key", () => {
  const data = {};
  assert.throws(() => change(data, "set", "router.backend", "elasticsearch"), /router\.backend: expected one of "qmd", "regex"/);
  assert.throws(() => change(data, "set", "router.minScore", "high"), /router\.minScore: expected a number/);
  assert.throws(() => change(data, "set", "skills.collection", ""), /skills\.collection: expected a non-empty string/);
  assert.throws(() => change(data, "set", "skills.userLevel", "no"), /skills\.userLevel: expected true or false/);
  assert.throws(() => change(data, "set", "baseline", ["ok", 3]), /baseline: expected a list of a non-empty string/);
  assert.deepEqual(data, {}, "a refused change leaves the data untouched");
});

test("set: a key toolgate does not manage is refused, and so are paths that could pollute prototypes", () => {
  const data = {};
  assert.throws(() => change(data, "set", "router.backnd", "qmd"), /"router\.backnd" is not a key toolgate manages/);
  assert.throws(() => change(data, "set", "nonsense", 1), /not a key toolgate manages/);
  for (const key of ["__proto__.polluted", "router.constructor", "keywords.prototype", "", "a..b"]) {
    assert.throws(() => change(data, "set", key, "x"), /not a valid key|not a key toolgate manages/);
  }
  assert.equal({}.polluted, undefined);
});

test("add and remove: lists of strings and of objects, without duplicates", () => {
  const data = {};
  assert.equal(change(data, "add", "baseline", "docs"), true);
  assert.equal(change(data, "add", "baseline", "docs"), false);
  assert.equal(change(data, "add", "keywords.repo", "pull request"), true);
  assert.equal(change(data, "add", "skills.sources", { dir: "skills", glob: "*/SKILL.md" }), true);
  assert.equal(change(data, "add", "skills.sources", { dir: "skills", glob: "*/SKILL.md" }), false);
  assert.equal(change(data, "add", "skills.sources", { dir: "more" }), true);
  assert.deepEqual(data.skills.sources, [{ dir: "skills", glob: "*/SKILL.md" }, { dir: "more" }]);

  assert.equal(change(data, "remove", "skills.sources", { dir: "more" }), true);
  assert.equal(change(data, "remove", "skills.sources", { dir: "more" }), false);
  assert.deepEqual(data.skills.sources, [{ dir: "skills", glob: "*/SKILL.md" }]);
});

test("add: an element of the wrong shape is refused, and a key that is not a list says to use set", () => {
  const data = {};
  assert.throws(() => change(data, "add", "skills.sources", "skills"), /skills\.sources: expected an object like/);
  assert.throws(() => change(data, "add", "skills.sources", { dir: "x", extra: 1 }), /expected an object like/);
  assert.throws(() => change(data, "add", "router.bindings", { skill: "x" }), /expected an object like/);
  assert.throws(() => change(data, "add", "router.backend", "qmd"), /router\.backend is not a list; use "config set"/);
  data.baseline = "docs";
  assert.throws(() => change(data, "add", "baseline", "repo"), /baseline: the current value is not a list/);
});

test("remove of the last element deletes the key, and unset prunes the objects it empties", () => {
  const data = { keywords: { repo: ["pull request"] }, router: { backend: "qmd" } };
  assert.equal(change(data, "remove", "keywords.repo", "pull request"), true);
  assert.deepEqual(data, { router: { backend: "qmd" } });

  const nested = { serverMeta: { repo: { tier: "cheap" } }, baseline: ["docs"] };
  assert.equal(change(nested, "unset", "serverMeta.repo.tier"), true);
  assert.deepEqual(nested, { baseline: ["docs"] }, "serverMeta.repo and serverMeta are gone, not left as {}");
});

test("unset: a missing key is a no-op, and any existing key can be removed, managed or not", () => {
  const data = { legacy: { old: true }, router: { backend: "qmd" } };
  assert.equal(change(data, "unset", "router.minScore"), false);
  assert.equal(change(data, "unset", "nothing.here"), false);
  assert.equal(change(data, "unset", "legacy"), true);
  assert.deepEqual(data, { router: { backend: "qmd" } });
});

test("every change is idempotent: repeating it changes nothing", () => {
  const data = {};
  const steps = [
    ["set", "router.backend", "qmd"],
    ["add", "baseline", "docs"],
    ["add", "skills.sources", { dir: "s" }],
  ];
  for (const [action, key, value] of steps) {
    assert.equal(change(data, action, key, value), true);
    const after = structuredClone(data);
    assert.equal(change(data, action, key, value), false, `${action} ${key} the second time`);
    assert.deepEqual(data, after);
  }
  for (const [, key, value] of steps.slice(1)) {
    change(data, "remove", key, value);
    assert.equal(change(data, "remove", key, value), false);
  }
});

test("an object in the way of a path is refused, not overwritten", () => {
  const data = { router: "qmd" };
  assert.throws(() => change(data, "set", "router.backend", "qmd"), /"router" is not an object/);
  assert.deepEqual(data, { router: "qmd" });
});

test("the project-only switches are refused in the user and local layers", () => {
  for (const layer of ["user", "local"]) {
    assert.throws(() => change({}, "set", "skills.userLevel", false, layer), /only counts in the project layer/);
    assert.throws(() => change({}, "unset", "skills.localLevel", undefined, layer), /only counts in the project layer/);
  }
  const data = {};
  assert.equal(change(data, "set", "skills.userLevel", false, "project"), true);
  assert.deepEqual(data, { skills: { userLevel: false } });
});

test("unknown keys in the file survive a change, and key order is kept", () => {
  const file = tmp();
  fs.writeFileSync(file, '{\n  "zeta": { "keep": [1, 2] },\n  "router": { "backend": "regex" },\n  "alpha": true\n}\n');
  const result = editConfigFile(file, { action: "set", key: "router.backend", value: "qmd" });
  assert.deepEqual(result, { changed: true, created: false });
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(written), ["zeta", "router", "alpha"]);
  assert.deepEqual(written, { zeta: { keep: [1, 2] }, router: { backend: "qmd" }, alpha: true });
});

test("a no-op does not rewrite the file, and a missing file is created only when something changes", () => {
  const file = tmp();
  assert.deepEqual(editConfigFile(file, { action: "unset", key: "router.backend" }), { changed: false, created: false });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(editConfigFile(file, { action: "set", key: "router.backend", value: "qmd" }), { changed: true, created: true });

  fs.writeFileSync(file, '{"router":{"backend":"qmd"}}'); // deliberately not in the formatted style
  assert.deepEqual(editConfigFile(file, { action: "set", key: "router.backend", value: "qmd" }), { changed: false, created: false });
  assert.equal(fs.readFileSync(file, "utf8"), '{"router":{"backend":"qmd"}}', "unchanged means byte for byte");
});

test("a file that cannot be parsed, or is not an object, is never overwritten", () => {
  const file = tmp();
  for (const content of ["{ nope", "[1, 2]", "null", '"text"']) {
    fs.writeFileSync(file, content);
    assert.throws(() => editConfigFile(file, { action: "set", key: "router.backend", value: "qmd" }), (err) => {
      assert.ok(err.message.includes(file), "the error names the file");
      assert.match(err.message, /left untouched/);
      return true;
    });
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
});

test("readConfigFile: a missing file is an empty config that does not exist yet", () => {
  assert.deepEqual(readConfigFile(path.join(os.tmpdir(), "toolgate-nope", "config.json")), { data: {}, exists: false });
});

test("formatConfig: round-trips the repo's own committed config byte for byte", () => {
  const original = fs.readFileSync(REPO_CONFIG, "utf8");
  const { data } = readConfigFile(REPO_CONFIG);
  const file = tmp();
  writeConfigFile(file, data);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("formatConfig: short lists stay inline, long ones and lists of objects wrap, empties are compact", () => {
  assert.equal(formatConfig({ a: ["x", "y"], b: [], c: {} }), '{\n  "a": ["x", "y"],\n  "b": [],\n  "c": {}\n}');
  const long = Array.from({ length: 12 }, (_, i) => `server-number-${i}`);
  assert.match(formatConfig({ baseline: long }), /"baseline": \[\n {4}"server-number-0",\n/);
  assert.equal(
    formatConfig({ skills: { sources: [{ dir: "a" }] } }),
    '{\n  "skills": {\n    "sources": [\n      {\n        "dir": "a"\n      }\n    ]\n  }\n}'
  );
});

test("parseValue: JSON when it parses, the plain string otherwise", () => {
  assert.equal(parseValue("0.6"), 0.6);
  assert.equal(parseValue("true"), true);
  assert.equal(parseValue("null"), null);
  assert.deepEqual(parseValue('{"dir":"x"}'), { dir: "x" });
  assert.deepEqual(parseValue('["a","b"]'), ["a", "b"]);
  assert.equal(parseValue("qmd"), "qmd");
  assert.equal(parseValue("pull request"), "pull request");
  assert.equal(parseValue('{"broken"'), '{"broken"');
});

test("a string-typed value stays text when it parses as another JSON type", () => {
  assert.equal(parseValueFor("keywords.repo", "add", "2024"), "2024");
  assert.equal(parseValueFor("router.skillsCollection", "set", "123"), "123");
  assert.equal(parseValueFor("router.minScore", "set", "0.5"), 0.5);
});

test("unset ignores inherited properties and unmanaged keys", () => {
  assert.equal(applyChange({}, { action: "unset", key: "toString" }), false);
  assert.throws(() => applyChange({ skills: {} }, { action: "unset", key: "skills" }), /whole section/);
  assert.equal(applyChange({ keywords: {} }, { action: "unset", key: "keywords.toString" }), false);
});

test("router.qmdUrl and source levels are managed, unknown binding keys are refused", () => {
  assert.equal(applyChange({}, { action: "set", key: "router.qmdUrl", value: null, layer: "user" }), true);
  assert.throws(() => applyChange({}, { action: "add", key: "router.bindings", value: { pattern: "x", skil: "y" } }));
  assert.equal(applyChange({}, { action: "add", key: "skills.sources", value: { dir: "t", level: "user" } }), true);
});

test("qmd.port takes a whole number from 1 to 65535, in the user and local layers only", () => {
  for (const layer of ["user", "local"]) {
    const data = {};
    assert.equal(change(data, "set", "qmd.port", 18282, layer), true);
    assert.deepEqual(data.qmd, { port: 18282 });
  }
  assert.throws(() => change({}, "set", "qmd.port", 18282, "project"), /qmd\.port is ignored in the project layer.*use --user or --local/);
  for (const bad of [0, 70000, 1.5, "abc", -1]) assert.throws(() => change({}, "set", "qmd.port", bad, "user"), /qmd\.port: expected a whole number from 1 to 65535/, String(bad));
  assert.equal(parseValueFor("qmd.port", "set", "18282"), 18282);
});

test("validPort: the value for a whole number from 1 to 65535, null for anything else", () => {
  for (const ok of [1, 8181, 65535]) assert.equal(validPort(ok), ok, String(ok));
  for (const bad of [0, -1, 65536, 70000, 1.5, NaN, Infinity, "8181", null, undefined, true]) assert.equal(validPort(bad), null, String(bad));
  assert.equal(validPort(65535), 65535, "the upper bound is a port");
  assert.throws(() => change({}, "set", "qmd.port", 65536, "user"), /qmd\.port: expected a whole number from 1 to 65535/);
  assert.equal(change({}, "set", "qmd.port", 65535, "user"), true);
});

const gitExit = (status) => () => {
  throw Object.assign(new Error(`git exited ${status}`), { status });
};
test("git: only exit 1 means 'not tracked'; 128 depends on a .git entry; any other code or no code is not an answer, and fails closed", () => {
  const file = tmp();
  assert.equal(isTracked(file, { execFn: () => "" }), true);
  assert.equal(isTracked(file, { execFn: gitExit(1) }), false, "git said: not tracked");
  assert.equal(isTracked(file, { execFn: gitExit(128) }), false, "not a repository, and no .git above");
  for (const status of [2, 129, 255]) assert.equal(isTracked(file, { execFn: gitExit(status) }), true, `exit ${status}`);
  assert.equal(isTracked(file, { execFn: () => { throw new Error("spawn git ENOENT"); } }), true, "git missing");
  assert.equal(trackedAndMissing(path.join(path.dirname(file), "absent.json"), { execFn: gitExit(129) }), false, "for a missing file the doubt is 'not tracked'");
});
test("unset works in the project layer for a key that set refuses there: a hostile value can be removed without editing by hand", () => {
  for (const [key, value] of [["router.qmdUrl", "https://evil.example/mcp"], ["rule.template", "evil.md"], ["qmd.bin", "/tmp/evil"], ["qmd.port", 9], ["skills.allowedHosts", ["evil.example"]]]) {
    const data = JSON.parse(JSON.stringify(Object.fromEntries([[key.split(".")[0], { [key.split(".")[1]]: value }]])));
    assert.equal(change(data, "unset", key, undefined, "project"), true, key);
    assert.deepEqual(data, {}, key);
    assert.throws(() => change({}, "set", key, value, "project"), /is ignored in the project layer/, `${key}: set stays refused`);
  }
  assert.throws(() => change({}, "add", "skills.allowedHosts", "evil.example", "project"), /is ignored in the project layer/);
  assert.throws(() => change({}, "remove", "skills.allowedHosts", "evil.example", "project"), /is ignored in the project layer/);
});
test("an edit of the user config, which is a link into a dotfiles folder, is made where it points: the link stays, the target changes, and the mode is kept", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-link-"));
  for (const mode of [0o600, 0o444, 0o640, 0o644]) {
    const target = path.join(dir, `dotfiles-${mode.toString(8)}.json`);
    fs.writeFileSync(target, '{ "defaultAgent": "codex" }\n');
    fs.chmodSync(target, mode);
    const link = path.join(dir, `config-${mode.toString(8)}.json`);
    fs.symlinkSync(path.basename(target), link);
    const result = editConfigFile(link, { action: "set", key: "defaultAgent", value: "claude-code", layer: "user" });
    assert.equal(result.changed, true);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${mode.toString(8)}: the link is still a link`);
    assert.equal(fs.readlinkSync(link), path.basename(target));
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { defaultAgent: "claude-code" });
    assert.equal(fs.statSync(target).mode & 0o777, mode, `${mode.toString(8)}: the mode of the target is kept`);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no temporary file is left");
});
test("a plain config keeps its mode on edit; a new one is created as before; a link to nothing is left untouched and said", { skip: process.platform === "win32" }, () => {
  const file = tmp();
  fs.writeFileSync(file, "{}\n");
  fs.chmodSync(file, 0o600);
  writeConfigFile(file, { defaultAgent: "codex" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const fresh = tmp();
  writeConfigFile(fresh, { defaultAgent: "codex" });
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o666 & ~process.umask(), "a new file gets the default mode");
  const dir = path.dirname(file);
  const dangling = path.join(dir, "dangling.json");
  fs.symlinkSync(path.join(dir, "nowhere.json"), dangling);
  assert.throws(() => writeConfigFile(dangling, { a: 1 }, { followLinks: true }), /is a link to a file that does not exist, and was left untouched/);
  assert.ok(fs.lstatSync(dangling).isSymbolicLink(), "the link is still there");
  assert.ok(!fs.existsSync(path.join(dir, "nowhere.json")), "nothing was created behind it");
});
test("only the user layer is written through a link: the project and local layers replace it, and keep the mode", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-layers-"));
  for (const layer of ["project", "local"]) {
    const victim = path.join(dir, `${layer}-victim.json`);
    fs.writeFileSync(victim, '{ "keep": true }\n');
    fs.chmodSync(victim, 0o600);
    const link = path.join(dir, `${layer}.json`);
    fs.symlinkSync(victim, link);
    editConfigFile(link, { action: "set", key: "defaultAgent", value: "codex", layer });
    assert.deepEqual(JSON.parse(fs.readFileSync(victim, "utf8")), { keep: true }, `${layer}: the file the link pointed at is untouched`);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), false, `${layer}: the link was replaced`);
    assert.equal(fs.statSync(link).mode & 0o777, 0o600, `${layer}: the replacement keeps the mode of what it replaced`);
  }
});
test("each key a repository may not set says its own reason: where the prompts go, what the agent is told, the program, the port, the hosts", () => {
  assert.equal(ignoredWhat("router.qmdUrl"), "a repository must not choose where your prompts go");
  assert.equal(ignoredWhat("rule.template"), "a repository must not choose what the agent is told");
  assert.equal(ignoredWhat("qmd.bin"), "a repository must not choose which program toolgate runs");
  assert.equal(ignoredWhat("qmd.port"), "a repository must not choose which port toolgate manages");
  assert.equal(ignoredWhat("skills.allowedHosts"), "a repository must not choose which hosts a lock may name");
  assert.throws(() => change({}, "set", "router.qmdUrl", "null", "project"), /^Error: router\.qmdUrl is ignored in the project layer \(a repository must not choose where your prompts go\); use --user or --local$/);
  assert.throws(() => change({}, "set", "rule.template", "x.md", "project"), /^Error: rule\.template is ignored in the project layer \(a repository must not choose what the agent is told\); use --user or --local$/);
});

test("isIgnored is true only when git says so: any doubt, a missing git or a repository that is not one is false", () => {
  const file = path.join(os.tmpdir(), "x", "CLAUDE.md");
  const exit = (status) => () => {
    throw Object.assign(new Error(`git exited ${status}`), { status });
  };
  assert.equal(isIgnored(file, { execFn: () => "" }), true);
  for (const status of [1, 128, 129, 255]) assert.equal(isIgnored(file, { execFn: exit(status) }), false, `exit ${status}`);
  assert.equal(isIgnored(file, { execFn: () => { throw new Error("spawn git ENOENT"); } }), false);
});
