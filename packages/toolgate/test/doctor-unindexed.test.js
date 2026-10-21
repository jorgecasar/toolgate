// doctor in a checkout that has skills but no index, and a Step 0 rule that rulesync has not generated (a new git worktree, #197).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRule, checkSkills } from "../src/doctor/checks.js";
import { step0NotGenerated } from "../src/rulesyncSetup.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-d197-")));
  made.push(dir);
  return dir;
};
const put = (cwd, rel, text = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), text);
};
const SKILL = "---\nname: demo\ndescription: Demo skill\n---\nBody\n";
const skillsCtx = (cwd, config = {}) => ({ cwd, config, env: { HOME: tmp(), XDG_CONFIG_HOME: tmp() }, homedir: tmp() });
const INDEX = path.join(".toolgate", "skills-index", "corpus", "_index.md");
const SOURCE = path.join(".rulesync", "rules", "toolgate-router.md");
const CLAUDE = path.join(".claude", "rules", "toolgate-router.md");
const notGenerated = (findings) => findings.filter((f) => f.message.includes("was not generated"));
test("skills and no index: skills.index warns with its fix, and the ok skills line is not printed", () => {
  const cwd = tmp();
  put(cwd, ".toolgate/skills/demo/SKILL.md", SKILL);
  const findings = checkSkills(skillsCtx(cwd));
  const found = findings.filter((f) => f.id === "skills.index");
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "warn");
  assert.equal(found[0].message, "skills exist but are not indexed in this checkout");
  assert.equal(found[0].hint ?? found[0].fix, "toolgate skills index");
  assert.ok(!findings.some((f) => f.id === "skills" && f.level === "ok"), "no 'skills are indexed' line");
});
test("with an index, or with no skills, there is no skills.index finding and the ok line stays", () => {
  const indexed = tmp();
  put(indexed, ".toolgate/skills/demo/SKILL.md", SKILL);
  put(indexed, INDEX, "# index\n");
  const withIndex = checkSkills(skillsCtx(indexed));
  assert.ok(!withIndex.some((f) => f.id === "skills.index"));
  const empty = checkSkills(skillsCtx(tmp()));
  assert.deepEqual(empty.map((f) => f.id), ["skills"]);
  assert.equal(empty[0].level, "ok");
});
test("skills.corpusDir is the folder doctor checks for the index", () => {
  const cwd = tmp();
  put(cwd, ".toolgate/skills/demo/SKILL.md", SKILL);
  put(cwd, INDEX, "# index\n");
  const config = { skills: { corpusDir: "elsewhere" } };
  assert.ok(checkSkills(skillsCtx(cwd, config)).some((f) => f.id === "skills.index"));
});
test("the other skills findings are unchanged next to skills.index", () => {
  const cwd = tmp();
  put(cwd, ".toolgate/skills/demo/SKILL.md", SKILL);
  put(cwd, ".toolgate/skills/other/SKILL.md", "---\nname: renamed\ndescription: d\n---\n");
  const ids = checkSkills(skillsCtx(cwd)).map((f) => `${f.id}:${f.level}`);
  assert.ok(ids.includes("skills.index:warn") && ids.includes("skills.name:error"), ids.join(" "));
});
test("rule.step0: a target whose generated file is missing is reported, and the source is not counted as loaded", () => {
  const cwd = tmp();
  put(cwd, SOURCE);
  put(cwd, "rulesync.jsonc", '{ "targets": ["claudecode"] }');
  const findings = checkRule({ cwd });
  const found = notGenerated(findings);
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "warn");
  assert.equal(found[0].message, "the Step 0 rule was not generated for claudecode (.rulesync source found)");
  assert.equal(found[0].hint ?? found[0].fix, "npx rulesync generate");
  assert.ok(!findings.some((f) => f.level === "ok"), "no 'loads at session start' line for the source");
});
test("rule.step0: once the generated file exists the ok line is back and nothing is reported", () => {
  const cwd = tmp();
  put(cwd, SOURCE);
  put(cwd, CLAUDE);
  put(cwd, "rulesync.jsonc", '{ "targets": ["claudecode"] }');
  const findings = checkRule({ cwd });
  assert.deepEqual(notGenerated(findings), []);
  assert.deepEqual(findings.map((f) => `${f.level}:${f.message}`).sort(), [`ok:${CLAUDE} is present and loads at session start`, `ok:${SOURCE} is present and loads at session start`]);
});
test("rule.step0: each missing target is reported, the ones in the map only; * is every target with a Step 0 file", () => {
  const cwd = tmp();
  put(cwd, SOURCE);
  put(cwd, "rulesync.jsonc", '{\n  // a comment\n  "targets": ["claudecode", "opencode", "codexcli", "unknown",],\n}\n');
  assert.deepEqual(step0NotGenerated(cwd), ["claudecode", "opencode"], "codexcli has no Step 0 file and unknown is not a target");
  put(cwd, ".opencode/memories/toolgate-router.md");
  assert.deepEqual(step0NotGenerated(cwd), ["claudecode"]);
  put(cwd, "rulesync.jsonc", '{ "targets": ["*"] }');
  assert.deepEqual(step0NotGenerated(cwd), ["claudecode", "antigravity-cli"]);
  put(cwd, "rulesync.jsonc", '{ "targets": ["claudecode", "claudecode"] }');
  assert.deepEqual(step0NotGenerated(cwd), ["claudecode"], "once");
});
test("rule.step0: no rulesync.jsonc, an unparseable one, or one without targets: no finding, the ok line as today", () => {
  for (const jsonc of [null, "not json at all {{", '{ "delete": false }', '{ "targets": "claudecode" }']) {
    const cwd = tmp();
    put(cwd, SOURCE);
    if (jsonc !== null) put(cwd, "rulesync.jsonc", jsonc);
    const findings = checkRule({ cwd });
    assert.deepEqual(notGenerated(findings), [], String(jsonc));
    assert.deepEqual(findings.map((f) => f.level), ["ok"], String(jsonc));
  }
});
test("rule.step0: the paths: error and the not found error are unchanged", () => {
  const cwd = tmp();
  put(cwd, SOURCE, '---\npaths: ["src/**"]\n---\nrule\n');
  put(cwd, "rulesync.jsonc", '{ "targets": ["claudecode"] }');
  const findings = checkRule({ cwd });
  assert.ok(findings.some((f) => f.level === "error" && /"paths:" frontmatter/.test(f.message)));
  assert.equal(notGenerated(findings).length, 1);
  const none = checkRule({ cwd: tmp() });
  assert.deepEqual(none.map((f) => `${f.level}:${f.message}`), ["error:the Step 0 rule (toolgate-router.md) was not found"]);
});
test("rule.step0: without the rulesync source, a generated file alone is judged as today", () => {
  const cwd = tmp();
  put(cwd, CLAUDE);
  put(cwd, "rulesync.jsonc", '{ "targets": ["claudecode", "opencode"] }');
  const findings = checkRule({ cwd });
  assert.deepEqual(notGenerated(findings), []);
  assert.deepEqual(findings.map((f) => f.level), ["ok"]);
});
test("rulesync.jsonc: a large hostile file is read in linear time (no backtracking)", () => {
  const cwd = tmp();
  put(cwd, "rulesync.jsonc", '"targets":['.repeat(Math.floor((256 * 1024) / 11)));
  const started = performance.now();
  assert.deepEqual(step0NotGenerated(cwd), []);
  assert.ok(performance.now() - started < 1000, "a 256 KB file of unclosed lists is answered at once");
  put(cwd, "rulesync.jsonc", `${'"targets" '.repeat(20000)}{ "targets"  :\n [ "claudecode" ] }`);
  assert.deepEqual(step0NotGenerated(cwd), ["claudecode"], "a key without a list before the real one does not hide it");
});
