// The repository's own housekeeping (#243 T5): what git ignores, the brief the architect reads, the Node version the scripts
// need, and the script that proves the suite leaves the qmd index alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS_LOCAL_IGNORED } from "../src/commands/install.js";
import { LOCAL_IGNORED } from "../src/skills/install.js";
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const json = (...parts) => JSON.parse(read(...parts));
test("the repository's .gitignore lists what the local levels of skills and commands write", () => {
  const lines = new Set(read(".gitignore").split("\n").map((line) => line.trim()));
  for (const entry of [...LOCAL_IGNORED, ...COMMANDS_LOCAL_IGNORED]) assert.ok(lines.has(entry), `${entry} is not in .gitignore`);
});
test("the architect brief: XDG_STATE_HOME in the disposable environment, the commands as bullets under 'Commands: spec and plan', a blank line before the skills", () => {
  const brief = read(".toolgate", "skills", "architect-brief", "SKILL.md");
  assert.match(brief, /disposable HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME and XDG_STATE_HOME;/);
  const lines = brief.split("\n");
  const heading = lines.indexOf("## Commands: spec and plan");
  assert.ok(heading > 0 && !brief.includes("/spec and /plan"), "the heading");
  assert.equal(lines[heading - 1], "", "a blank line before the heading");
  const skills = lines.indexOf("## Skills (read by path)");
  assert.ok(skills > heading + 1);
  assert.equal(lines[skills - 1], "", "a blank line before ## Skills");
  const body = lines.slice(heading + 1, skills - 1);
  assert.ok(body.length >= 4 && body.every((line) => line.startsWith("- ")), "every line of the section is a bullet");
});
test("project-context carries no rulesync leftover", () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(read(".toolgate", "skills", "project-context", "SKILL.md"))[1];
  assert.doesNotMatch(front, /^targets:/m);
  assert.match(front, /^name: project-context$/m);
});
test("engines.node is the minimum the scripts need: --import is Node 20.6", () => {
  const atLeast = (range) => {
    const [major, minor = 0] = /^>=(\d+)(?:\.(\d+))?/.exec(range).slice(1).map(Number);
    return major > 20 || (major === 20 && minor >= 6);
  };
  const files = [["package.json"], ["packages", "toolgate", "package.json"]];
  for (const file of files) {
    const manifest = json(...file);
    assert.ok(Object.values(manifest.scripts ?? {}).some((script) => /--import\b/.test(script)), `${file.join("/")} uses --import`);
    assert.ok(atLeast(manifest.engines.node), `${file.join("/")}: engines.node is ${manifest.engines.node}`);
  }
});
test("check-qmd-index fails, and says why, when there is no qmd; and it is an npm script", { skip: process.platform === "win32" }, () => {
  assert.equal(json("package.json").scripts["check:qmd-index"], "sh scripts/check-qmd-index.sh");
  const bin = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "toolgate-hy-"));
  try {
    // A PATH with the shell tools and nothing else: no qmd, and the suite is never started.
    for (const tool of ["sh", "mktemp", "rm", "mkdir", "diff", "dirname", "cat"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found) fs.symlinkSync(found, path.join(bin, tool));
    }
    const result = spawnSync(path.join(bin, "sh"), [path.join(root, "scripts", "check-qmd-index.sh")], { encoding: "utf8", env: { PATH: bin, HOME: bin } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^check-qmd-index: qmd is not on PATH; this check needs a real qmd to list the collections$/m);
    assert.doesNotMatch(result.stdout + result.stderr, /collections are the same/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
