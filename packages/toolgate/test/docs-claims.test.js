// The docs say what the code does (#243 T4): each claim that was wrong is pinned, so it does not come back.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const doc = (name) => fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "docs", name), "utf8");
const started = doc("getting-started.md");
test("getting-started: a local config counts only when git does not version it", () => {
  assert.doesNotMatch(started, /your local \(gitignored\) config/);
  assert.equal(started.match(/your local config \(when git does not version it/g)?.length, 2, "router.qmdUrl and qmd.bin both say it");
});
test("getting-started: a skill needs a name, not a description", () => {
  assert.doesNotMatch(started, /`name` and `description` are required/);
  assert.match(started, /`name` is required\. A skill without a `description` is still indexed, but `toolgate doctor` reports it/);
});
test("getting-started: rule.template is not expanded and a relative path is relative to the project", () => {
  assert.match(started, /The path is not expanded: a `~` typed on the command line is expanded by your shell/);
  assert.match(started, /A relative path is relative to the project folder, not to the config file that holds it\./);
});
test("getting-started: installed copies are not executable, and a skill runs its scripts with an interpreter", () => {
  assert.match(started, /installed copies are not executable \(on purpose\): a skill runs its scripts with an interpreter \(`node script\.js`, `sh script\.sh`\)/i);
});
test("DESIGN and the SPEC: the cheap tier has no policy to configure, and the catalog is matched by words", () => {
  for (const name of ["DESIGN.md", "SPEC-dynamic-activation-and-routing.md"]) {
    const text = doc(name);
    assert.doesNotMatch(text, /cheap tier from policy/i, name);
    assert.doesNotMatch(text, /\(semantic \+ keyword\)/, name);
    assert.match(text, /`serverMeta` marks `tier: "cheap"`/, name);
    assert.match(text, /Match the catalog by the words of the prompt/, name);
  }
  assert.doesNotMatch(doc("SPEC-dynamic-activation-and-routing.md"), /the router and policy can reason/);
});
test("every doc that names the minimum Node says 20.6, which is what engines.node and --import need", () => {
  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
  assert.match(read("docs", "getting-started.md"), /^- Node 20\.6 or newer, and git\.$/m);
  assert.match(read("docs", "qmd-integration.md"), /^- Node 20\.6 or newer\.$/m);
  assert.match(read("docs", "SPEC-adapter-contract.md"), /^Node >= 20\.6, ESM,/m);
  assert.match(read(".rulesync", "rules", "overview.md"), /\(Node 20\.6 or later,/);
  assert.match(read(".toolgate", "skills", "architect-brief", "SKILL.md"), /ES modules, Node 20\.6 or later,/);
  for (const manifest of ["package.json", "packages/toolgate/package.json"]) assert.match(JSON.parse(read(manifest)).engines.node, /^>=20\.6$/, manifest);
});
