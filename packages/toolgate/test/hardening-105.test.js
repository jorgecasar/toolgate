// Small hardenings from #104 / #105: the size of a fetched repository, the temp file of a config write, and plain text in overrides.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_CHECKOUT_BYTES, assertCheckoutSize, fetchSource } from "../src/skills/remote.js";
import { editConfigFile, isValidOverride, writeConfigFile } from "../src/configFile.js";
import { git, isolateGitConfig } from "./support/git.js";
isolateGitConfig();

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-h-${name}-`)));
  made.push(dir);
  return dir;
};

test("the default limit is 200 MB, and a fetch that does not name one uses it", () => {
  assert.equal(MAX_CHECKOUT_BYTES, 200 * 1024 * 1024);
  const dir = tmp("default");
  fs.writeFileSync(path.join(dir, "f"), Buffer.alloc(1024 * 1024));
  assert.doesNotThrow(() => assertCheckoutSize(dir, "https://x.test/a/b"), "1 MB is far under the default");
  assert.ok(fs.existsSync(dir));
});

test("a fetched repository over the limit is removed from the cache and refused; one under it is kept", () => {
  const remote = tmp("remote");
  git(remote, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(remote, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.mkdirSync(path.join(remote, "skills/a"), { recursive: true });
  fs.writeFileSync(path.join(remote, "skills/a/SKILL.md"), "---\nname: a\ndescription: a\n---\nb\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-q", "-m", "x");
  const url = `file://${remote}`;
  const cache = tmp("cache");
  assert.throws(() => fetchSource({ url, cache, allowFile: true, maxBytes: 1024 * 1024 }), /is larger than 1 MB once fetched, so it was removed from the cache/);
  assert.deepEqual(fs.readdirSync(cache), [], "nothing is left in the cache");
  const kept = fetchSource({ url, cache, allowFile: true, maxBytes: 10 * 1024 * 1024 });
  assert.ok(fs.existsSync(path.join(kept.dir, "skills/a/SKILL.md")));
  const link = tmp("link");
  fs.symlinkSync(path.join(remote, "big.bin"), path.join(link, "big-link"));
  assert.doesNotThrow(() => assertCheckoutSize(link, url, 1024), "a link is not followed, so it adds nothing");
  assert.throws(() => assertCheckoutSize(remote, `https://user:secret@x.test/${"a".repeat(5)}`, 1024), (err) => !/secret/.test(err.message) && /larger than 0 MB/.test(err.message));
});

test("writeConfigFile never writes through a link planted at a predictable temp name, and still replaces a linked config", () => {
  const dir = tmp("cfg");
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "keep me");
  const file = path.join(dir, "config.json");
  fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
  writeConfigFile(file, { baseline: ["x"] });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { baseline: ["x"] });
  fs.unlinkSync(`${file}.${process.pid}.tmp`);
  const target = path.join(dir, "target.json");
  fs.writeFileSync(target, "{}");
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  writeConfigFile(file, { baseline: ["y"] });
  assert.equal(fs.readFileSync(target, "utf8"), "{}", "the link target is not written");
  assert.ok(!fs.lstatSync(file).isSymbolicLink());
  // Not even by an edit of the project or the local layer, which is what a cloned repository could ask for.
  for (const layer of ["project", "local"]) {
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    editConfigFile(file, { action: "set", key: "defaultAgent", value: "codex", layer });
    assert.equal(fs.readFileSync(target, "utf8"), "{}", `${layer}: the link target is not written`);
    assert.ok(!fs.lstatSync(file).isSymbolicLink(), layer);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no temp file is left behind");
});

test("an override is plain text: control characters, line breaks and separators are refused in every field", () => {
  const ok = { skill: "x", description: "A plain description", tags: ["a-b"], mcps: ["github"] };
  assert.equal(isValidOverride(ok), true);
  for (const bad of ["a\nb", "a\u001b[31mb", "a\u0007", "a\tb", "a\u007fb", "a\u0085b", "a b", "a b"]) {
    assert.equal(isValidOverride({ ...ok, description: bad }), false, `description ${JSON.stringify(bad)}`);
    assert.equal(isValidOverride({ ...ok, tags: [bad] }), false, `tags ${JSON.stringify(bad)}`);
    assert.equal(isValidOverride({ ...ok, mcps: [bad] }), false, `mcps ${JSON.stringify(bad)}`);
    assert.equal(isValidOverride({ ...ok, skill: bad }), false, `skill ${JSON.stringify(bad)}`);
  }
  assert.equal(isValidOverride({ skill: "x", description: "Ünïcode and emoji ✓ are fine" }), true);
});
