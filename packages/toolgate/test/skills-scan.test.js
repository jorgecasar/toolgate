import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasDescription } from "../src/assets/common.js";
import { parseCard, writeCorpus } from "../src/skills/corpus.js";
import { listSourceFiles, scanSkills } from "../src/skills/scan.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");
const sources = [{ dir: FIXTURES }];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-scan-"));

test("listSourceFiles: globs are sorted and their metacharacters are escaped", () => {
  const files = listSourceFiles({ dir: FIXTURES, glob: "*/SKILL.md" });
  assert.equal(files.length, 2);
  assert.deepEqual(files, [...files].sort());
  assert.deepEqual(listSourceFiles({ dir: FIXTURES, glob: "(*)/SKILL.md" }), []);
  assert.deepEqual(listSourceFiles({ dir: FIXTURES, glob: "[ab]*/SKILL.md" }), []);
  assert.equal(listSourceFiles({ dir: FIXTURES, glob: "?*/SKILL.md" }).length, 2);
  assert.equal(listSourceFiles({ dir: FIXTURES, glob: "**/SKILL.md" }).length, 2);
});

test("scanSkills: reads every selected skill in a stable order", () => {
  assert.deepEqual(
    scanSkills(sources).map((s) => [s.name, s.mcps]),
    [
      ["pdf-export", ["filesystem", "renderer"]],
      ["pr-review", ["github", "repo"]],
    ]
  );
});

test("scanSkills: fails loudly on missing sources, bad frontmatter and duplicate names", () => {
  assert.throws(() => scanSkills([]), /no skills sources/);
  assert.throws(() => scanSkills([{ dir: path.join(FIXTURES, "nope") }]), /not found/);
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "x"));
  fs.writeFileSync(path.join(dir, "x", "SKILL.md"), "---\ndescription: d\n---\n");
  // a file that cannot be read is skipped and reported, never fatal (a source-level problem still is)
  const scanned = scanSkills([{ dir }]);
  assert.deepEqual(scanned, []);
  assert.deepEqual(scanned.skipped.map((item) => item.reason), ['frontmatter is missing "name"']);
  assert.throws(() => scanSkills([sources[0], sources[0]]), /duplicate skill name/);
});

function skillIn(dir, name, description) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

test("scanSkills: the higher level wins a name clash, and the winner says what it shadows", () => {
  const [user, project, local] = [tmp(), tmp(), tmp()];
  skillIn(user, "review", "personal");
  skillIn(user, "only-mine", "mine");
  skillIn(project, "review", "team");
  skillIn(local, "review", "trial");
  skillIn(project, "build", "team build");

  const skills = scanSkills([
    { dir: local, level: "local" },
    { dir: user, level: "user" },
    { dir: project, level: "project" },
  ]);
  assert.deepEqual(
    skills.map((s) => [s.name, s.level, s.description, s.shadows]),
    [
      ["build", "project", "team build", []],
      ["only-mine", "user", "mine", []],
      ["review", "local", "trial", ["user", "project"]],
    ]
  );

  const withoutLocal = scanSkills([{ dir: user, level: "user" }, { dir: project, level: "project" }]);
  assert.deepEqual(withoutLocal.find((s) => s.name === "review").level, "project");
});

test("scanSkills: a duplicate inside one level is still an error, and an unknown level is rejected", () => {
  const [a, b] = [tmp(), tmp()];
  skillIn(a, "same", "one");
  skillIn(b, "same", "two");
  assert.throws(() => scanSkills([{ dir: a, level: "user" }, { dir: b, level: "user" }]), /duplicate skill name "same"/);
  assert.throws(() => scanSkills([{ dir: a, level: "team" }]), /unknown skills level "team"/);
  assert.equal(scanSkills([{ dir: a }])[0].level, "project");
});

test("a source must name a dir and a glob that stays inside it", () => {
  assert.throws(() => listSourceFiles({}), /needs a dir/);
  assert.throws(() => listSourceFiles({ dir: 3 }), /needs a dir/);
  assert.throws(() => listSourceFiles({ dir: FIXTURES, glob: "../*/SKILL.md" }), /stay inside/);
  assert.throws(() => listSourceFiles({ dir: FIXTURES, glob: "/etc/*" }), /stay inside/);
  assert.throws(() => listSourceFiles({ dir: path.join(FIXTURES, "alpha", "SKILL.md") }), /not found/);
});

test("symlinks are never followed out of the source", () => {
  const root = tmp();
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, "---\nname: leaked\ndescription: from outside\n---\n");

  const linkedFile = path.join(root, "files");
  fs.mkdirSync(path.join(linkedFile, "evil"), { recursive: true });
  fs.symlinkSync(outside, path.join(linkedFile, "evil", "SKILL.md"));
  assert.throws(() => scanSkills([{ dir: linkedFile }]), /symlink and symlinks are not followed/);

  const linkedDir = path.join(root, "dirs");
  fs.mkdirSync(linkedDir);
  fs.cpSync(path.join(FIXTURES, "alpha"), path.join(root, "real"), { recursive: true });
  fs.symlinkSync(path.join(root, "real"), path.join(linkedDir, "alpha"), "dir");
  assert.deepEqual(listSourceFiles({ dir: linkedDir }), []);
});

const bareSkill = (dir, name, frontmatter = `name: ${name}`) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\n${frontmatter}\n---\nbody\n`);
};
test("scanSkills: one skill without a description never hides the others, and the empty ones are told apart", () => {
  const dir = tmp();
  skillIn(dir, "a", "has one");
  bareSkill(dir, "b");
  bareSkill(dir, "c", 'name: c\ndescription: "   "');
  const found = scanSkills([{ dir }]);
  assert.deepEqual(found.map((skill) => skill.name), ["a", "b", "c"]);
  assert.deepEqual(found.map(hasDescription), [true, false, false]);
});
test("scanSkills: an override fills the description of a skill that has none", () => {
  const dir = tmp();
  bareSkill(dir, "b");
  const [skill] = scanSkills([{ dir }], [{ skill: "b", description: "from override" }]);
  assert.equal(skill.description, "from override");
  assert.equal(hasDescription(skill), true);
});
test("a skill without a description is indexed with an empty one: the card keeps its shape", () => {
  const dir = tmp();
  bareSkill(dir, "b");
  const corpus = path.join(tmp(), "corpus");
  writeCorpus(scanSkills([{ dir }]), corpus);
  const card = parseCard(fs.readFileSync(path.join(corpus, "b.md"), "utf8"));
  assert.equal(card.description, "");
  assert.equal(card.path.endsWith("SKILL.md"), true, "the path line after the description is still read as the path");
});
