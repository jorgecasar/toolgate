// The website's home page includes regions of README.md (#275): a missing marker would render an empty section without failing the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("every region the home page includes is opened and closed once in README.md, with text inside", () => {
  const index = read("docs", "index.md");
  const readme = read("README.md");
  const included = [...index.matchAll(/<!--@include: \.\.\/README\.md#([\w-]+)-->/g)].map((m) => m[1]);
  assert.deepEqual(included, ["problem", "what", "quickstart"]);
  for (const name of included) {
    const opened = [...readme.matchAll(new RegExp(`^<!-- #region ${name} -->$`, "gm"))];
    const closed = [...readme.matchAll(new RegExp(`^<!-- #endregion ${name} -->$`, "gm"))];
    assert.equal(opened.length, 1, `${name}: opened once`);
    assert.equal(closed.length, 1, `${name}: closed once`);
    assert.ok(opened[0].index < closed[0].index, `${name}: opened before it is closed`);
    const body = readme.slice(opened[0].index + opened[0][0].length, closed[0].index);
    assert.ok(body.trim().length > 200, `${name}: text between the markers`);
    assert.doesNotMatch(body, /\]\((?!https?:)/, `${name}: no relative link, which would resolve from docs/ on the home page`);
  }
});

test("the site settings are a base path, a repository URL and a branch", () => {
  const site = JSON.parse(read("packages", "website", "site.config.json"));
  assert.deepEqual(Object.keys(site).sort(), ["base", "branch", "repoUrl"]);
  assert.match(site.base, /^\/.*\/$/);
  assert.match(site.repoUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
});
