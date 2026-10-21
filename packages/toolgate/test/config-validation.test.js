// Values a config may hold that are not what the key needs (#240 T3c): a rule template that is no text file, sources that are no list,
// a commands folder that is the whole project. Each is dropped like any invalid key and said; none crashes a command.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configLayerPaths, loadConfig, mergeConfigLayers } from "../src/config.js";
import { run } from "../src/cli.js";
import { MAX_RULE_BYTES, readRuleText, ruleTemplateInvalid } from "../src/ruleText.js";
import { ignoredWarnings } from "../src/router.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cv-")));
  made.push(dir);
  return dir;
};
const WHY = "it must be a non-empty text file of at most 64 KiB";
// A project and a user config folder, with the files of both.
function setup({ user = {}, project = {}, files = {} } = {}) {
  const cwd = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(user));
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), JSON.stringify(project));
  const env = { HOME: home, TOOLGATE_DEFAULTS: path.join(home, "config.json") };
  return { cwd, home, env, layers: configLayerPaths({ cwd, env, homedir: home }) };
}
const noQmd = () => {
  throw new Error("no qmd here");
};
const cli = async (args, { cwd, env }) => {
  const out = [];
  const err = [];
  const code = await run(args, { cwd, env: { ...env, PATH: "" }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, daemon: { status: async () => ({ running: false }) }, init: { execFn: noQmd }, skills: { execFn: noQmd }, doctor: { homedir: env.HOME, execFn: () => { throw new Error("ENOENT"); }, daemon: { status: async () => ({ running: false }) } } });
  return { code, out: out.join(""), err: err.join("") };
};

test("ruleTemplateInvalid: a value that is no path, or a file that exists and is empty, binary or too long; a missing file is not judged", () => {
  const cwd = tmp();
  const file = (name, bytes) => (fs.writeFileSync(path.join(cwd, name), bytes), name);
  for (const bad of [5, null, "", {}, ["x"], true, undefined]) assert.equal(ruleTemplateInvalid(bad, cwd), true, String(bad));
  assert.equal(ruleTemplateInvalid(file("empty.md", ""), cwd), true);
  assert.equal(ruleTemplateInvalid(file("nul.md", Buffer.from("rule\0text")), cwd), true);
  assert.equal(ruleTemplateInvalid(file("big.md", Buffer.alloc(MAX_RULE_BYTES + 1, "a")), cwd), true);
  assert.equal(ruleTemplateInvalid(file("edge.md", Buffer.alloc(MAX_RULE_BYTES, "a")), cwd), false, "exactly 64 KiB is allowed");
  assert.equal(ruleTemplateInvalid(file("ok.md", "Use toolgate need.\n"), cwd), false);
  assert.equal(ruleTemplateInvalid("absent.md", cwd), false, "reading it to use it says it is not there");
  assert.equal(ruleTemplateInvalid(".", cwd), false, "a folder is for the reader to refuse");
  assert.equal(ruleTemplateInvalid("whatever", undefined), false, "without a folder to resolve against only the type is checked");
  assert.equal(ruleTemplateInvalid(5, undefined), true);
});
test("readRuleText refuses an empty, binary or too long file with the same words", () => {
  const cwd = tmp();
  const read = (bytes) => (fs.writeFileSync(path.join(cwd, "r.md"), bytes), () => readRuleText(path.join(cwd, "r.md")));
  assert.throws(read(""), new RegExp(WHY));
  assert.throws(read(Buffer.from("a\0b")), new RegExp(WHY));
  assert.throws(read(Buffer.alloc(MAX_RULE_BYTES + 1, "a")), new RegExp(WHY));
  assert.equal(read("text\n")(), "text\n");
});
test("a rule.template that is no text file is dropped at load with reason invalid, in every trusted layer; an earlier valid one stays", () => {
  const p = setup({ files: { "good.md": "A rule.\n", "empty.md": "", "bin.md": Buffer.from("a\0") } });
  for (const bad of [5, null, "", ["x"], "empty.md", "bin.md"]) {
    const merged = mergeConfigLayers([{ rule: { template: "good.md" } }, null, { rule: { template: bad } }], [{ name: "user", base: p.home }, { name: "project", base: p.cwd }, { name: "local", base: p.cwd, tracked: () => false }]);
    assert.deepEqual(merged.rule, { template: "good.md" }, `${JSON.stringify(bad)}: the earlier valid one stays`);
    assert.deepEqual(merged.ignored, [{ key: "rule.template", layer: "local", reason: "invalid" }], JSON.stringify(bad));
    const alone = mergeConfigLayers([{ rule: { template: bad } }], [{ name: "user", base: p.home }, { name: "project", base: p.cwd }]);
    assert.equal(alone.rule, undefined, `${JSON.stringify(bad)}: nothing is chosen`);
  }
  assert.deepEqual(ignoredWarnings({ ignored: [{ key: "rule.template", layer: "user", reason: "invalid" }] }), [`rule.template in the user config is ignored: ${WHY}`]);
});
test("a user config with a rule.template of 5 does not crash init or need: the built-in text is used and the key is said to be ignored", async () => {
  const p = setup({ user: { rule: { template: 5 } } });
  const need = await cli(["need", "open a pull request", "--json"], p);
  assert.equal(need.code, 0, need.err);
  assert.ok(JSON.parse(need.out).warnings.includes(`rule.template in the user config is ignored: ${WHY}`));
  const init = await cli(["init", "--yes", "--backend", "regex"], p);
  assert.equal(init.code, 0, init.out + init.err);
  assert.doesNotMatch(init.out + init.err, /TypeError|at .*\.js:\d+/, "no stack trace");
  assert.match(init.out, new RegExp(`rule\\.template in the user config is ignored: ${WHY}`));
  assert.match(fs.readFileSync(path.join(p.cwd, ".rulesync/rules/toolgate-router.md"), "utf8"), /toolgate need/);
});
test("a rule.template file that is empty, binary or over 64 KiB is ignored with the agreed warning, and the built-in text is written", async () => {
  for (const [name, bytes] of [["empty.md", ""], ["bin.md", Buffer.from("rule\0text")], ["big.md", Buffer.alloc(MAX_RULE_BYTES + 1, "a")]]) {
    const p = setup({ files: { [name]: bytes } });
    fs.writeFileSync(p.env.TOOLGATE_DEFAULTS, JSON.stringify({ rule: { template: path.join(p.cwd, name) } }));
    const init = await cli(["init", "--yes", "--backend", "regex"], p);
    assert.equal(init.code, 0, `${name}: ${init.out}${init.err}`);
    assert.match(init.out, new RegExp(`rule\\.template in the user config is ignored: ${WHY}`), name);
    assert.match(fs.readFileSync(path.join(p.cwd, ".rulesync/rules/toolgate-router.md"), "utf8"), /toolgate need/, name);
  }
});
test("a skills.sources that is not a list is dropped at load and said: a warning in need, an error in doctor, never 'skills are indexed'", async () => {
  const p = setup({ user: { skills: { sources: "s" } } });
  const merged = loadConfig(p.layers);
  assert.equal(merged.skills.sources, undefined);
  assert.deepEqual(merged.ignored, [{ key: "skills.sources", layer: "user", reason: "invalid" }]);
  assert.deepEqual(ignoredWarnings(merged), ["skills.sources in the user config is ignored: it must be a list"]);
  const need = await cli(["need", "x", "--json"], p);
  assert.ok(JSON.parse(need.out).warnings.includes("skills.sources in the user config is ignored: it must be a list"));
  const doctor = await cli(["doctor", "--json"], p);
  const checks = JSON.parse(doctor.out).checks;
  const found = checks.filter((c) => c.id === "skills.sources");
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "error");
  assert.equal(found[0].message, "skills.sources must be a list");
  assert.match(found[0].hint, /^fix it in the user config: toolgate config add skills\.sources '\{"dir":"<folder>"\}' --user$/);
  assert.equal(doctor.code, 1);
  assert.deepEqual(checks.filter((c) => c.id === "config.ignored" && /skills\.sources/.test(c.message)), [], "not said twice");
  const ok = setup({ user: { skills: { sources: [{ dir: "s" }] } } });
  assert.deepEqual(loadConfig(ok.layers).ignored ?? [], []);
  const trusted = mergeConfigLayers([{ skills: { sources: "s", allowedHosts: ["a.example"] } }], [{ name: "user", base: "/" }]);
  assert.deepEqual(trusted.skills.allowedHosts, ["a.example"], "a trusted allowedHosts beside the bad sources is kept");
});
