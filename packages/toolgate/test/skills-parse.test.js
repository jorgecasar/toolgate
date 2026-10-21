import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractRequiredMcps, parseFrontmatter, parseSkill } from "../src/skills/parse.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");

function skillFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-parse-"));
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, content);
  return file;
}

test("parseFrontmatter: scalars, inline lists, block lists and folded text", () => {
  const { data, body } = parseFrontmatter(
    "---\na: 'x'\nb: [1, 2]\nc:\n  - p\n  - q\nd: >-\n  one\n  two\n---\nrest"
  );
  assert.deepEqual(data, { a: "x", b: [1, 2], c: ["p", "q"], d: "one two" });
  assert.equal(body, "rest");
});

test("parseFrontmatter: no frontmatter keeps the whole text; a non-mapping header fails loudly", () => {
  assert.deepEqual(parseFrontmatter("# Just a body"), { data: {}, body: "# Just a body" });
  assert.deepEqual(parseFrontmatter("---\n---\nbody"), { data: {}, body: "body" });
  assert.throws(() => parseFrontmatter("---\n- a\n- b\n---\n"), /must be a YAML mapping/);
});

test("extractRequiredMcps: heading variants and section boundaries", () => {
  const body = "## Required MCP\n- `one`\n### Other\n- skip\n# required mcps\n* two\n## Requirements\n- no";
  assert.deepEqual(extractRequiredMcps(body), ["one", "two"]);
});

test("parseSkill: mcps come from the frontmatter or from the Required MCPs section", () => {
  const declared = parseSkill(path.join(FIXTURES, "alpha", "SKILL.md"));
  assert.deepEqual(
    [declared.name, declared.tags, declared.mcps],
    ["pdf-export", ["pdf", "export"], ["filesystem", "renderer"]]
  );

  const fromBody = parseSkill(path.join(FIXTURES, "beta", "SKILL.md"));
  assert.deepEqual(
    [fromBody.name, fromBody.tags, fromBody.mcps],
    ["pr-review", ["git", "review"], ["github", "repo"]]
  );
});

test("parseSkill: bad input fails loudly and names the file", () => {
  const missing = skillFile("---\ndescription: d\n---\n");
  assert.throws(() => parseSkill(missing), new RegExp(`${missing}: frontmatter is missing "name"`));

  const malformed = skillFile("---\nname: [unclosed\n---\n");
  assert.throws(() => parseSkill(malformed), new RegExp(malformed));

  const badTags = skillFile("---\nname: x\ndescription: y\ntags: [1, 2]\n---\n");
  assert.throws(() => parseSkill(badTags), /"tags" must be a list of strings/);
});
