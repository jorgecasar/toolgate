import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeCorpus } from "../src/skills/corpus.js";
import { scanSkills } from "../src/skills/scan.js";
import { searchIndex, searchSkills } from "../src/skills/search.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");
const sources = [{ dir: FIXTURES }];

const made = [];
const tmp = (prefix = "toolgate-search-") => (made.push(fs.mkdtempSync(path.join(os.tmpdir(), prefix))), made.at(-1));
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const skill = (name, description) => ({ name, description, tags: ["t"], mcps: [], path: `/s/${name}/SKILL.md` });

test("writeCorpus: one file per skill plus _index.md; rejects unsafe names", () => {
  const dir = tmp();
  writeCorpus(scanSkills(sources), dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["_index.md", "pdf-export.md", "pr-review.md"]);
  assert.match(fs.readFileSync(path.join(dir, "_index.md"), "utf8"), /\*\*pr-review\*\* — Review a pull request/);
  assert.throws(() => writeCorpus([skill("../x", "d")], dir), /unsafe skill name/);
  assert.throws(() => writeCorpus([skill("_index", "d")], dir), /unsafe skill name/);
  assert.throws(() => writeCorpus([skill("index", "d")], dir), /unsafe skill name/);
});

test("searchIndex: a multi-line description and a pipe in it still parse and match", () => {
  const dir = tmp();
  writeCorpus([skill("report", "Build a report\nwith charts | and tables"), skill("other", "Unrelated")], dir);
  const [hit] = searchIndex("charts tables", dir);
  assert.equal(hit.name, "report");
  assert.equal(hit.description, "Build a report with charts | and tables");
  assert.deepEqual(searchIndex("nothing matches here", dir), []);
});

test("searchSkills: qmd results win, get a skill name, and the catalog is filtered out", () => {
  const execFn = () =>
    JSON.stringify([
      { file: "qmd://skills/pr-review.md", score: 0.9, snippet: "s" },
      { file: "qmd://skills/_index.md", score: 0.5 },
      { file: "qmd://skills/index.md", score: 0.5 }, // how qmd reports the catalog
    ]);
  const dir = tmp();
  writeCorpus([{ ...skill("pr-review", "Review a PR"), level: "local", shadows: ["user"] }], dir);
  const found = searchSkills("review a PR", { corpusDir: dir, execFn });
  assert.equal(found.source, "qmd");
  assert.deepEqual(found.results, [
    { name: "pr-review", kind: "skill", level: "local", shadows: ["user"], file: "qmd://skills/pr-review.md", score: 0.9, snippet: "s" },
  ]);
  assert.throws(() => searchSkills("  ", { corpusDir: dir, execFn }), /non-empty/);
});

test("searchSkills: asks qmd for the collection and limit it was given", () => {
  const calls = [];
  const execFn = (bin, args) => (calls.push([bin, ...args]), "[]");
  searchSkills("pdf", { corpusDir: "/none", execFn, qmdBin: "qmd-test", collection: "mine", limit: 3 });
  assert.deepEqual(calls, [["qmd-test", "query", "pdf", "-c", "mine", "--json", "-n", "3"]]);
});

test("searchSkills: falls back to the _index.md keyword match and says so", () => {
  const dir = tmp();
  writeCorpus(scanSkills(sources), dir);
  const execFn = () => {
    throw new Error("spawn qmd ENOENT");
  };
  const found = searchSkills("export a pdf report", { corpusDir: dir, execFn });
  assert.equal(found.source, "fallback");
  assert.match(found.reason, /qmd unavailable: spawn qmd ENOENT/);
  assert.deepEqual(
    found.results.map((r) => r.name),
    ["pdf-export"]
  );
  assert.throws(() => searchSkills("x", { corpusDir: tmp(), execFn }), /run "toolgate skills index"/);
});

test("searchSkills: an unreadable card is reported in warnings", () => {
  const dir = tmp("tg-search-");
  const execFn = () => JSON.stringify([{ file: "qmd://skills/gone.md", score: 0.5, snippet: "s" }]);
  const result = searchSkills("x review", { corpusDir: dir, collection: "skills", execFn });
  assert.equal(result.source, "qmd");
  assert.equal(result.results[0].level, undefined);
  assert.match(result.warnings[0], /gone\.md unreadable/);
});

test("searchIndex: an index written before levels existed still parses", () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "_index.md"),
    "# Skills index\n\n- **old** — Reviews a PR | tags: review | mcps: none | path: /s/old/SKILL.md\n"
  );
  const [hit] = searchIndex("review pull", dir);
  assert.equal(hit.name, "old");
  assert.equal(hit.level, "project");
});
