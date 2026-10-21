// Problems found in code that was already on main (#102): each test fails without its fix.
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run as cliRun } from "../src/cli.js";
// The daemon is faked by default: with none, `refreshDaemon` would ask the real default port whether a daemon is up (the hermetic guard refuses that).
const run = (argv, deps = {}) => cliRun(argv, { ...deps, daemon: { status: async () => ({ running: false }), ...deps.daemon } });
import { printable } from "../src/assets/common.js";
import { assertCorpusLocation, renderIndex, renderSkill, writeCorpus } from "../src/skills/corpus.js";
import { installSkills } from "../src/skills/install.js";
import { git as hermeticGit } from "./support/git.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-sec-${name}-`)));
  made.push(dir);
  return dir;
};
const git = (cwd, ...args) =>
  hermeticGit(cwd, ...args);
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const SKILL = "---\nname: s\ndescription: d\n---\nbody\n";
const remote = (layout) => {
  const root = tmp("remote");
  git(root, "init", "-q", "-b", "main");
  layout(root);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return `file://${root}`;
};
const install = (layout, projectDir = tmp("project")) => ({ projectDir, ...installSkills({ spec: remote(layout), projectDir, cache: tmp("cache"), allowFile: true }) });
const licenseTexts = (projectDir) => {
  const dir = path.join(projectDir, ".toolgate/skills/.licenses");
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, "utf8")).join("");
};
const withSkill = (root) => put(root, "skills/s/SKILL.md", SKILL);

// ---- source licenses

test("a LICENSE that is a symlink, to a file or to a folder, is not copied, and is reported", () => {
  const secret = tmp("secret");
  put(secret, "id_rsa", "TOP-SECRET-KEY\n");
  const { projectDir, licensesSkipped } = install((root) => {
    withSkill(root);
    fs.symlinkSync(path.join(secret, "id_rsa"), path.join(root, "LICENSE"));
    fs.symlinkSync(secret, path.join(root, "COPYING"));
    put(root, "NOTICE", "kept\n");
  });
  const text = licenseTexts(projectDir);
  assert.ok(!text.includes("TOP-SECRET"), "the file the symlink points at was copied");
  assert.ok(text.includes("kept"), "a regular NOTICE is still kept");
  assert.deepEqual(licensesSkipped.map((s) => [s.name, s.reason]).sort(), [["COPYING", "is a symlink"], ["LICENSE", "is a symlink"]]);
});

test("a dangling license symlink does not stop the install", () => {
  const { projectDir, installed } = install((root) => {
    withSkill(root);
    fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "LICENSE"));
  });
  assert.deepEqual(installed, ["s"]);
  assert.ok(fs.existsSync(path.join(projectDir, ".toolgate/skills/s/SKILL.md")));
});

test("a license is copied up to 256 KiB and not beyond", () => {
  const exact = install((root) => (withSkill(root), put(root, "LICENSE", "x".repeat(256 * 1024))));
  assert.equal(licenseTexts(exact.projectDir).length, 256 * 1024);
  const over = install((root) => (withSkill(root), put(root, "LICENSE", "x".repeat(256 * 1024 + 1))));
  assert.equal(licenseTexts(over.projectDir), "");
  assert.match(over.licensesSkipped[0].reason, /larger than/);
});

test("a symlink planted where the license is written is replaced, never written through", () => {
  for (const shape of ["file", "slug folder", "licenses folder"]) {
    const victim = tmp("victim");
    put(victim, "LICENSE", "PRECIOUS ORIGINAL");
    const projectDir = tmp("project");
    const spec = remote((root) => (withSkill(root), put(root, "LICENSE", "remote license text")));
    // the same source installed once tells where its licenses go; then the destination is replaced by a link
    installSkills({ spec, projectDir, cache: tmp("cache"), allowFile: true });
    const licenses = path.join(projectDir, ".toolgate/skills/.licenses");
    const slugDir = path.join(licenses, fs.readdirSync(licenses)[0]);
    if (shape === "file") (fs.rmSync(path.join(slugDir, "LICENSE")), fs.symlinkSync(path.join(victim, "LICENSE"), path.join(slugDir, "LICENSE")));
    if (shape === "slug folder") (fs.rmSync(slugDir, { recursive: true }), fs.symlinkSync(victim, slugDir));
    if (shape === "licenses folder") (fs.rmSync(licenses, { recursive: true }), fs.symlinkSync(victim, licenses));
    const before = fs.readdirSync(victim).sort();
    installSkills({ spec, projectDir, cache: tmp("cache"), allowFile: true, force: true });
    assert.equal(fs.readFileSync(path.join(victim, "LICENSE"), "utf8"), "PRECIOUS ORIGINAL", shape);
    if (shape !== "file") assert.deepEqual(fs.readdirSync(victim).sort(), before, `${shape}: nothing new in the folder the link points at`);
  }
});

// ---- corpusDir

const project = () => {
  const cwd = tmp("project");
  put(cwd, "skills/s/SKILL.md", SKILL);
  put(cwd, "README.md", "precious readme");
  put(cwd, "src/a.js", "precious code");
  put(cwd, "_index.md", "# planted by the repository\n");
  return cwd;
};
const index = async (cwd, corpusDir) => {
  const err = [];
  const code = await run(["skills", "index"], {
    cwd,
    env: {},
    stdout: { write() {} },
    stderr: { write: (s) => err.push(s) },
    loadConfigFn: () => ({ skills: { sources: [{ dir: "skills" }], ...(corpusDir === undefined ? {} : { corpusDir }) } }),
    skills: { execFn: () => "" },
  });
  return { code, err: err.join("") };
};

test("`skills index` refuses a corpusDir outside <project>/.toolgate, even when the repository planted an _index.md there", async () => {
  const outside = tmp("outside");
  put(outside, "_index.md", "x");
  put(outside, "victim.md", "victim");
  const home = tmp("home");
  put(home, "_index.md", "x");
  put(home, "file.txt", "home file");
  for (const corpusDir of [".", "", "./", "..", ".toolgate", "src", outside, home, "../sibling"]) {
    const cwd = project();
    const { code, err } = await index(cwd, corpusDir);
    assert.equal(code, 1, JSON.stringify(corpusDir));
    assert.match(err, /corpusDir must be a folder inside/, JSON.stringify(corpusDir));
    assert.ok(fs.existsSync(path.join(cwd, "README.md")) && fs.existsSync(path.join(cwd, "src/a.js")) && fs.existsSync(path.join(cwd, "skills/s/SKILL.md")), JSON.stringify(corpusDir));
  }
  assert.equal(fs.readFileSync(path.join(outside, "victim.md"), "utf8"), "victim");
  assert.equal(fs.readFileSync(path.join(home, "file.txt"), "utf8"), "home file");
});

test("`skills index` refuses a corpusDir that goes through a symlink, whether the corpus folder or a parent is the link", async () => {
  const outside = tmp("outside");
  put(outside, "_index.md", "x");
  put(outside, "victim.md", "victim");
  for (const shape of ["corpus folder", "parent folder", ".toolgate itself"]) {
    const cwd = project();
    if (shape === "corpus folder") (fs.mkdirSync(path.join(cwd, ".toolgate/skills-index"), { recursive: true }), fs.symlinkSync(outside, path.join(cwd, ".toolgate/skills-index/corpus")));
    if (shape === "parent folder") (fs.mkdirSync(path.join(cwd, ".toolgate")), fs.symlinkSync(outside, path.join(cwd, ".toolgate/skills-index")));
    if (shape === ".toolgate itself") fs.symlinkSync(outside, path.join(cwd, ".toolgate"));
    const { code, err } = await index(cwd);
    assert.equal(code, 1, shape);
    assert.match(err, /symlink/, shape);
    assert.equal(fs.readFileSync(path.join(outside, "victim.md"), "utf8"), "victim", shape);
  }
});

test("the default corpus folder, and a folder of your own inside .toolgate, keep working", async () => {
  const cwd = project();
  assert.equal((await index(cwd)).code, 0);
  assert.equal((await index(cwd)).code, 0, "a second run clears and rewrites the corpus it made");
  assert.ok(fs.existsSync(path.join(cwd, ".toolgate/skills-index/corpus/_index.md")));
  assert.equal((await index(cwd, ".toolgate/mine/corpus")).code, 0);
  assert.doesNotThrow(() => assertCorpusLocation(path.join(cwd, ".toolgate/not/yet/there"), cwd));
});

const SKILL_ITEM = { name: "s", description: "d", tags: [], mcps: [], path: "/s" };
const CMD_ITEM = { name: "c", kind: "command", description: "d", tags: [], mcps: [], path: "/c" };
const generated = (item) => renderSkill(item); // a card exactly as toolgate writes it
const MARKED = (item) => `<!-- toolgate card 2 -->\n${renderSkill(item)}`;

test("writeCorpus removes only files toolgate wrote: cards in the old shape and with the format marker, never a user's markdown", () => {
  const dir = tmp("corpus");
  put(dir, "_index.md", renderIndex([]));
  put(dir, "old.md", generated({ ...SKILL_ITEM, name: "old" }));
  put(dir, "marked.md", MARKED({ ...SKILL_ITEM, name: "marked" }));
  put(dir, "commands/old-cmd.md", generated({ ...CMD_ITEM, name: "old-cmd" }));
  put(dir, "notes.md", "# my notes\n\nmine\n");
  put(dir, "README.md", "# readme\n- Tags: none\n- Path: /x\n");
  put(dir, "commands/SKILL.md", "---\nname: commands\ndescription: user skill\n---\nbody\n");
  put(dir, "keep.txt", "mine");
  writeCorpus([SKILL_ITEM], dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["README.md", "_index.md", "commands", "keep.txt", "notes.md", "s.md"]);
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "# my notes\n\nmine\n");
  assert.deepEqual(fs.readdirSync(path.join(dir, "commands")), ["SKILL.md"], "a folder of the user's called commands keeps its file");
});

test("a hostile folder with a planted _index.md loses nothing it did not get from toolgate, even when writeCorpus is called directly", () => {
  const dir = tmp("planted");
  put(dir, "_index.md", "# Skills index\n\nplanted by the repository\n");
  put(dir, "mine.md", "# mine\n\nimportant text\n");
  writeCorpus([SKILL_ITEM], dir);
  assert.equal(fs.readFileSync(path.join(dir, "mine.md"), "utf8"), "# mine\n\nimportant text\n");
  // a skill that has the name of a file of the user's is refused instead of overwriting it
  put(dir, "x.md", "# x\n\nuser file\n");
  assert.throws(() => writeCorpus([{ ...SKILL_ITEM, name: "x" }], dir), /x\.md exists and was not written by toolgate; refusing to overwrite it/);
  assert.equal(fs.readFileSync(path.join(dir, "x.md"), "utf8"), "# x\n\nuser file\n");
});

test("a catalog that toolgate did not write, or a folder where the catalog goes, stops the run before anything is removed", () => {
  const foreign = tmp("foreign");
  put(foreign, "_index.md", "---\ntitle: Hugo section\n---\n");
  put(foreign, "old.md", generated({ ...SKILL_ITEM, name: "old" }));
  assert.throws(() => writeCorpus([SKILL_ITEM], foreign), /not a catalog written by toolgate; refusing to overwrite it/);
  assert.ok(fs.existsSync(path.join(foreign, "old.md")), "the generated card was not removed either");
  const folder = tmp("folder");
  fs.mkdirSync(path.join(folder, "_index.md"));
  put(folder, "old.md", generated({ ...SKILL_ITEM, name: "old" }));
  assert.throws(() => writeCorpus([SKILL_ITEM], folder), /is a folder; refusing to use/);
  assert.ok(fs.existsSync(path.join(folder, "old.md")));
});

test("a symlink where a card, the catalog or the commands folder goes is removed, not followed", () => {
  const victim = tmp("victim");
  put(victim, "victim.md", "victim");
  put(victim, "cards/c.md", "victim card");
  const dir = tmp("corpus");
  fs.symlinkSync(path.join(victim, "victim.md"), path.join(dir, "_index.md"));
  fs.symlinkSync(path.join(victim, "cards"), path.join(dir, "commands"));
  fs.symlinkSync(path.join(victim, "victim.md"), path.join(dir, "s.md"));
  writeCorpus([SKILL_ITEM, CMD_ITEM], dir);
  assert.equal(fs.readFileSync(path.join(victim, "victim.md"), "utf8"), "victim");
  assert.equal(fs.readFileSync(path.join(victim, "cards/c.md"), "utf8"), "victim card");
  assert.ok(!fs.lstatSync(path.join(dir, "commands")).isSymbolicLink());
});

test("a run interrupted midway leaves a folder the next run can rewrite", () => {
  const dir = tmp("interrupted");
  // `shadows` is read only when the card of the skill is written, after the catalog.
  const failing = { ...SKILL_ITEM, get shadows() { throw new Error("interrupted"); } };
  assert.throws(() => writeCorpus([failing], dir), /interrupted/);
  writeCorpus([SKILL_ITEM], dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["_index.md", "s.md"]);
});

test("`skills index` never deletes the user's files in toolgate's own folders, whichever corpusDir a repository picks", async () => {
  const cases = [
    [".toolgate/rules", (cwd) => { put(cwd, ".toolgate/rules/_index.md", "planted"); put(cwd, ".toolgate/rules/notes.md", "# notes\n"); put(cwd, ".toolgate/rules/README.md", "# readme\n"); }, [".toolgate/rules/notes.md", ".toolgate/rules/README.md"]],
    [".toolgate/mine/foo", (cwd) => { put(cwd, ".toolgate/mine/foo/_index.md", "# Skills index\n"); put(cwd, ".toolgate/mine/foo/SKILL.md", SKILL); put(cwd, ".toolgate/mine/foo/README.md", "# readme\n"); }, [".toolgate/mine/foo/SKILL.md", ".toolgate/mine/foo/README.md"], 0],
    [".toolgate/skills", (cwd) => { put(cwd, ".toolgate/skills/_index.md", "# Skills index\n"); put(cwd, ".toolgate/skills/commands/SKILL.md", SKILL); }, [".toolgate/skills/commands/SKILL.md"]],
    [".toolgate/skills/foo", (cwd) => { put(cwd, ".toolgate/skills/foo/_index.md", "# Skills index\n"); put(cwd, ".toolgate/skills/foo/SKILL.md", SKILL); put(cwd, ".toolgate/skills/foo/README.md", "# r\n"); }, [".toolgate/skills/foo/SKILL.md", ".toolgate/skills/foo/README.md"]],
    [".toolgate/commands", (cwd) => { put(cwd, ".toolgate/commands/_index.md", "# Skills index\n"); put(cwd, ".toolgate/commands/a.md", "# a\n"); }, [".toolgate/commands/a.md"]],
    [".toolgate/skills-index", (cwd) => { put(cwd, ".toolgate/skills-index/_index.md", "# Skills index\n"); put(cwd, ".toolgate/skills-index/state.json", "{}"); }, [".toolgate/skills-index/state.json"]],
  ];
  for (const [corpusDir, prepare, survivors, expected = 1] of cases) {
    const cwd = project();
    prepare(cwd);
    const { code } = await index(cwd, corpusDir);
    assert.equal(code, expected, corpusDir);
    for (const file of survivors) assert.ok(fs.existsSync(path.join(cwd, file)), `${corpusDir}: ${file}`);
  }
  // a folder of its own with a planted catalog that looks like ours: it works, and the user's markdown is still there
  const cwd = project();
  put(cwd, ".toolgate/rules/_index.md", "# Skills index\n");
  put(cwd, ".toolgate/rules/notes.md", "# notes\n");
  assert.equal((await index(cwd, ".toolgate/rules")).code, 0);
  assert.equal(fs.readFileSync(path.join(cwd, ".toolgate/rules/notes.md"), "utf8"), "# notes\n");
});

test("the error for a corpusDir prints no terminal escapes", async () => {
  const { err } = await index(project(), "\u001b[2Jx");
  assert.doesNotMatch(err, /\u001b/);
  assert.match(err, /corpusDir must be a folder inside/);
});

test("a license temporary name nobody can predict, and a symlinked store or .toolgate is refused (and no license is written through it)", () => {
  const victim = tmp("victim");
  const projectDir = tmp("project");
  for (const link of [".toolgate", ".toolgate/skills"]) {
    fs.rmSync(path.join(projectDir, ".toolgate"), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(path.join(projectDir, link)), { recursive: true });
    fs.symlinkSync(victim, path.join(projectDir, link));
    // The whole install is refused (assertPlainStore), so not even the license can be written through the link.
    assert.throws(() => installSkills({ spec: remote((root) => (withSkill(root), put(root, "LICENSE", "text"))), projectDir, cache: tmp("cache"), allowFile: true }), /is a symlink/, link);
    assert.deepEqual(fs.readdirSync(victim), [], link);
  }
  const ok = tmp("project");
  const spec = remote((root) => (withSkill(root), put(root, "LICENSE", "text")));
  installSkills({ spec, projectDir: ok, cache: tmp("cache"), allowFile: true });
  const slugDir = path.join(ok, ".toolgate/skills/.licenses", fs.readdirSync(path.join(ok, ".toolgate/skills/.licenses"))[0]);
  put(slugDir, `LICENSE.writing-${process.pid}`, "planted");
  assert.doesNotThrow(() => installSkills({ spec, projectDir: ok, cache: tmp("cache"), allowFile: true, force: true }));
  assert.deepEqual(fs.readdirSync(slugDir).sort(), [`LICENSE`, `LICENSE.writing-${process.pid}`].sort());
});

test("the messages about a corpusDir, from the check and from the command, carry no terminal escapes of their own", async () => {
  assert.throws(() => assertCorpusLocation("\u001b[2Jx", tmp("p")), (error) => !/\u001b/.test(error.message) && /must be a folder inside/.test(error.message));
  assert.throws(() => assertCorpusLocation(path.join(tmp("p"), ".toolgate", "skills", "\u001b[2Jx"), path.dirname(tmp("q"))), (error) => !/\u001b/.test(error.message));
  const cwd = tmp("p");
  put(cwd, "dup/a/SKILL.md", SKILL);
  put(cwd, "dup/b\u001b[31m/SKILL.md", SKILL);
  const err = [];
  const code = await run(["skills", "index"], { cwd, env: {}, stdout: { write() {} }, stderr: { write: (s) => err.push(s) }, loadConfigFn: () => ({ skills: { sources: [{ dir: "dup" }] } }), skills: { execFn: () => "" } });
  assert.equal(code, 1);
  assert.match(err.join(""), /duplicate skill name/);
  assert.doesNotMatch(err.join(""), /\u001b/);
});

const caseInsensitive = (() => {
  const probe = tmp("case");
  fs.writeFileSync(path.join(probe, "Probe"), "x");
  return fs.existsSync(path.join(probe, "probe"));
})();

test("toolgate's own folders are recognised under another spelling of their name, and so are the folders the project reads from", () => {
  const cwd = tmp("p");
  fs.mkdirSync(path.join(cwd, ".toolgate/skills/commands"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".toolgate/skills-index"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".toolgate/my-skills"), { recursive: true });
  for (const dir of [".toolgate/Skills", ".toolgate/SKILLS/commands", ".toolgate/Skills-Index", ".toolgate/COMMANDS", ".toolgate/Config.json"]) {
    assert.throws(() => assertCorpusLocation(path.join(cwd, dir), cwd), /overlaps/, dir);
  }
  // a folder the project reads skills from (a configured source) is no corpus either, but the corpus may be inside one
  assert.throws(() => assertCorpusLocation(path.join(cwd, ".toolgate/my-skills"), cwd, [path.join(cwd, ".toolgate/my-skills")]), /is, or holds/);
  assert.doesNotThrow(() => assertCorpusLocation(path.join(cwd, ".toolgate/my-skills/corpus"), cwd, [path.join(cwd, ".toolgate/my-skills")]));
  assert.doesNotThrow(() => assertCorpusLocation(path.join(cwd, ".toolgate/my-skills"), cwd, []));
  assert.doesNotThrow(() => assertCorpusLocation(path.join(cwd, ".toolgate/skills-index/corpus"), cwd));
});

test("the same file under another spelling is found by identity too (filesystems that ignore case)", { skip: !caseInsensitive && "this filesystem is case-sensitive" }, () => {
  const cwd = tmp("p");
  fs.mkdirSync(path.join(cwd, ".toolgate/skills/commands"), { recursive: true });
  // the name check alone would also stop this; identity is what stops a spelling the name check does not know
  const area = path.join(cwd, ".toolgate/skills");
  assert.equal(fs.statSync(path.join(cwd, ".toolgate/SKILLS")).ino, fs.statSync(area).ino);
  assert.throws(() => assertCorpusLocation(path.join(cwd, ".toolgate/SKILLS"), cwd, []), /overlaps/);
});

test("`skills index` with a configured source folder inside .toolgate refuses to use it as the corpus", async () => {
  const cwd = project();
  put(cwd, ".toolgate/my-skills/s/SKILL.md", SKILL);
  const err = [];
  const code = await run(["skills", "index"], {
    cwd, env: {}, stdout: { write() {} }, stderr: { write: (s) => err.push(s) },
    loadConfigFn: () => ({ skills: { sources: [{ dir: ".toolgate/my-skills" }], corpusDir: ".toolgate/my-skills" } }),
    skills: { execFn: () => "" },
  });
  assert.equal(code, 1);
  assert.match(err.join(""), /is, or holds, .*a folder the project reads skills or commands from/);
  assert.ok(fs.existsSync(path.join(cwd, ".toolgate/my-skills/s/SKILL.md")));
});

test("a `commands` file where the commands folder goes stops the run before any card is removed", () => {
  const dir = tmp("corpus");
  put(dir, "old.md", generated({ ...SKILL_ITEM, name: "old" }));
  put(dir, "commands", "i am a file");
  assert.throws(() => writeCorpus([SKILL_ITEM], dir), /commands is a file; refusing to use/);
  assert.ok(fs.existsSync(path.join(dir, "old.md")));
});

test("a card with the format marker is removed whatever its size, and so is an old-shape card too big to read whole; a big file of the user's that is not one stays", () => {
  const dir = tmp("corpus");
  const fields = "\n\n- Tags: none\n- Required MCPs: none\n- Level: project\n- Shadows: user\n- Path: /x\n";
  put(dir, "big-marked.md", `${MARKED({ ...SKILL_ITEM, name: "big-marked" })}${"x".repeat(300 * 1024)}`);
  put(dir, "big-old.md", `# big-old\n\n${"word ".repeat(70000)}${fields}`);
  put(dir, "big-old-command.md", `# big-old-command\n\n${"word ".repeat(70000)}\n\n- Tags: none\n- Required MCPs: none\n- Kind: command\n- Argument hint: <x>\n- Level: project\n- Path: /x\n`);
  put(dir, "big-notes.md", `# my notes\n\n${"word ".repeat(70000)}\n\nthe end of my notes\n`);
  put(dir, "big-no-title.md", `${"word ".repeat(70000)}${fields}`);
  put(dir, "big-fields-in-the-middle.md", `# mine\n\n${fields}${"word ".repeat(70000)}\nmore text\n`);
  writeCorpus([SKILL_ITEM], dir);
  for (const gone of ["big-marked.md", "big-old.md", "big-old-command.md"]) assert.ok(!fs.existsSync(path.join(dir, gone)), gone);
  for (const kept of ["big-notes.md", "big-no-title.md", "big-fields-in-the-middle.md"]) assert.ok(fs.existsSync(path.join(dir, kept)), kept);
});

test("licenses are written under a name nobody can predict, and the temporary file is removed when the rename fails", () => {
  const names = [];
  const original = fs.writeFileSync;
  const write = mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (/LICENSE\.writing-/.test(String(file))) names.push(path.basename(String(file)));
    return original(file, ...rest);
  });
  try {
    const spec = remote((root) => (withSkill(root), put(root, "LICENSE", "text")));
    const projectDir = tmp("project");
    installSkills({ spec, projectDir, cache: tmp("cache"), allowFile: true });
    installSkills({ spec, projectDir, cache: tmp("cache"), allowFile: true, force: true });
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1], "two runs, two names");
    for (const name of names) assert.match(name, /^LICENSE\.writing-[0-9a-f]{12}$/);
  } finally {
    write.mock.restore();
  }
  const originalRename = fs.renameSync;
  const rename = mock.method(fs, "renameSync", (from, to) => {
    if (/LICENSE\.writing-/.test(String(from))) throw new Error("rename failed");
    return originalRename(from, to);
  });
  const projectDir = tmp("project");
  try {
    assert.throws(() => installSkills({ spec: remote((root) => (withSkill(root), put(root, "LICENSE", "text"))), projectDir, cache: tmp("cache"), allowFile: true }), /rename failed/);
  } finally {
    rename.mock.restore();
  }
  const slug = path.join(projectDir, ".toolgate/skills/.licenses");
  const left = fs.readdirSync(slug, { recursive: true }).map(String).filter((f) => f.includes("LICENSE.writing-"));
  assert.deepEqual(left, [], "the temporary file is gone");
});

test("a license that is a folder is skipped with a reason, and `skills install` prints what it left out", async () => {
  const outcome = install((root) => {
    withSkill(root);
    put(root, "LICENSE/inside.txt", "x");
    put(root, "COPYING", "kept");
  });
  assert.deepEqual(outcome.licensesSkipped.map((l) => [l.name, l.reason]), [["LICENSE", "is not a regular file"]]);

  const cwd = tmp("p");
  const out = [];
  const spec = remote((root) => (withSkill(root), fs.symlinkSync(path.join(tmp("secret"), "nowhere"), path.join(root, "LICENSE"))));
  const code = await run(["skills", "install", spec], {
    cwd, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, loadConfigFn: () => ({}),
    daemon: { status: async () => ({ running: false }) },
    skills: { execFn: () => "" }, install: { allowFile: true, cache: tmp("cache") },
  });
  assert.equal(code, 0);
  assert.match(out.join(""), /license LICENSE not kept: is a symlink/);
});

// "é" written as one character, and as "e" plus a combining accent: the same name to APFS, two names to a string comparison
const composed = "m" + String.fromCharCode(0xe9);
const decomposed = "me" + String.fromCharCode(0x301);
const normalizationInsensitive = (() => {
  const probe = tmp("norm");
  fs.mkdirSync(path.join(probe, composed));
  return fs.existsSync(path.join(probe, decomposed));
})();

test("a source reached under a spelling the name check cannot see is found by identity: the corpus is it, or holds it", { skip: !normalizationInsensitive && "this filesystem keeps the two spellings apart" }, () => {
  const cwd = tmp("p");
  fs.mkdirSync(path.join(cwd, ".toolgate", composed, "inner"), { recursive: true });
  const source = path.join(cwd, ".toolgate", composed);
  // the corpus folder is the source under the other spelling
  assert.throws(() => assertCorpusLocation(path.join(cwd, ".toolgate", decomposed), cwd, [source]), /is, or holds/);
  // the corpus folder holds the source, under the other spelling
  assert.throws(() => assertCorpusLocation(path.join(cwd, ".toolgate", decomposed), cwd, [path.join(source, "inner")]), /is, or holds/);
  // inside the source is fine, whichever spelling
  assert.doesNotThrow(() => assertCorpusLocation(path.join(cwd, ".toolgate", decomposed, "inner"), cwd, [source]));
  assert.doesNotThrow(() => assertCorpusLocation(path.join(cwd, ".toolgate", "elsewhere"), cwd, [source]));
});

test("a source that is the project (`.`) does not lock the index: the default corpus may sit inside a source", async () => {
  for (const config of [
    { skills: { sources: [{ dir: "." }] } },
    { skills: { sources: [{ dir: "." }] }, commands: { sources: [{ dir: "." }] } },
    { skills: { sources: [{ dir: "SELF" }] } },
  ]) {
    const cwd = tmp("p");
    put(cwd, "myskill/SKILL.md", "---\nname: myskill\ndescription: d\n---\nbody\n");
    const out = [];
    const err = [];
    const resolved = JSON.parse(JSON.stringify(config).replace("SELF", cwd));
    const ctx = { cwd, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, loadConfigFn: () => resolved, skills: { execFn: () => "" } };
    assert.equal(await run(["skills", "index"], ctx), 0, `${JSON.stringify(config)}: ${err.join("")}`);
    assert.match(out.join(""), /indexed 1 skill/);
    // the cards the first run wrote are not read as skills or commands, nor do they change the fingerprint: nothing to redo
    assert.equal(await run(["skills", "index"], ctx), 0, err.join(""));
    assert.equal(await run(["skills", "index", "--force"], ctx), 0, err.join(""));
    assert.match(out.join(""), /indexed 1 skill( and 1 command)?\n$/, "a forced run reads the same skills");
  }
});

test("a corpus that is a source, or holds one, is refused with the rule that fired; one inside a source is fine", () => {
  const cwd = tmp("p");
  const mine = path.join(cwd, ".toolgate", "mine");
  fs.mkdirSync(path.join(mine, "inner"), { recursive: true });
  assert.throws(() => assertCorpusLocation(mine, cwd, [mine]), /is, or holds, .*a folder the project reads skills or commands from/);
  assert.throws(() => assertCorpusLocation(mine, cwd, [path.join(mine, "inner")]), /is, or holds, .*a folder the project reads/);
  assert.doesNotThrow(() => assertCorpusLocation(path.join(mine, "inner", "corpus"), cwd, [mine]));
  assert.doesNotThrow(() => assertCorpusLocation(path.join(cwd, ".toolgate", "skills-index", "corpus"), cwd, [cwd]));
  assert.throws(() => assertCorpusLocation(path.join(cwd, ".toolgate", "skills"), cwd, []), /which toolgate keeps for something else/, "the other rule keeps its own message");
  // a source that does not exist yet (it is only configured) is still not a place for the corpus
  const planned = path.join(cwd, ".toolgate", "planned");
  assert.throws(() => assertCorpusLocation(planned, cwd, [planned]), /is, or holds/);
  assert.throws(() => assertCorpusLocation(path.join(cwd, ".toolgate", "PLANNED"), cwd, [planned]), /is, or holds/, "whatever the case");
});

// a qmd that remembers the folder given to `collection add` and reports it back, so the index can tell it is current
function fakeQmd() {
  let corpus = null;
  return (bin, args) => {
    if (args[1] === "add") corpus = args[2];
    if (args[1] !== "show") return "";
    if (corpus === null) throw new Error(`Collection not found: ${args[2]}`);
    return `Collection: ${args[2]}\n  Path:     ${corpus}\n`;
  };
}
const indexTwice = async (cwd, config, args = []) => {
  const exec = fakeQmd();
  const lines = [];
  for (let i = 0; i < 3; i++) {
    const out = [];
    const err = [];
    const code = await run(["skills", "index", ...(i === 2 ? args : [])], { cwd, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, loadConfigFn: () => config, skills: { execFn: exec } });
    assert.equal(code, 0, err.join(""));
    lines.push(out.join("").trim());
  }
  return lines;
};

test("with the corpus inside a commands source, the second and third `skills index` say it is up to date: the cards do not change the fingerprint", async () => {
  const cwd = tmp("p");
  put(cwd, "cmds/a.md", "---\ndescription: first\n---\nbody\n");
  put(cwd, "cmds/b.md", "---\ndescription: second\n---\nbody\n");
  const [first, second, third] = await indexTwice(cwd, { commands: { sources: [{ dir: "." }] } });
  assert.match(first, /indexed 0 skills and 2 commands/);
  assert.match(second, /up to date/);
  assert.match(third, /up to date/);
});

test("the corpus is left out of a source whatever glob the source has, and however the source spells the folder", async () => {
  // a glob of the user's that matches the cards, for skills too
  const cwd = tmp("p");
  put(cwd, "notes/x.md", "---\nname: x\ndescription: d\n---\nbody\n");
  const lines = await indexTwice(cwd, { skills: { sources: [{ dir: ".", glob: "**/*.md" }] } }, ["--force"]);
  assert.match(lines[0], /indexed 1 skill/);
  assert.match(lines[1], /up to date/);
  assert.match(lines[2], /indexed 1 skill/, "a forced run reads only the skill, not the cards");
});

test("a source spelled with another case still leaves the corpus out (filesystems that ignore case)", { skip: !caseInsensitive && "this filesystem is case-sensitive" }, async () => {
  const cwd = tmp("p");
  put(cwd, "cmds/a.md", "---\ndescription: first\n---\nbody\n");
  const shouting = path.join(path.dirname(cwd), path.basename(cwd).toUpperCase());
  assert.ok(fs.existsSync(shouting));
  const lines = await indexTwice(cwd, { commands: { sources: [{ dir: shouting }] } });
  assert.match(lines[1], /up to date/);
});

test("`.toolgate/skills-index` is refused on the very first index, before its state file exists", () => {
  const cwd = tmp("p");
  assert.throws(() => assertCorpusLocation(path.join(cwd, ".toolgate", "skills-index"), cwd, []), /which toolgate keeps for something else/);
  assert.throws(() => assertCorpusLocation(path.join(cwd, ".toolgate", "SKILLS-INDEX"), cwd, []), /which toolgate keeps for something else/);
});

// How a hidden character is shown: \n, \r and \t as such, the rest as \uXXXX (\u{XXXXX} above U+FFFF)
const escaped = (code) => ({ 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t" })[code] ?? (code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`);

test("printable shows, one class at a time, what makes text read differently from what it is, and keeps legitimate text", () => {
  for (const code of [0x0a, 0x0d, 0x09, 0x1b, 0x00, 0x1f]) assert.equal(printable("a" + String.fromCodePoint(code) + "b"), `a${escaped(code)}b`, `line breaks, tabs and the rest of C0: U+${code.toString(16)}`);
  for (const code of [0x7f, 0x80, 0x85, 0x9b, 0x9f]) assert.equal(printable("a" + String.fromCodePoint(code) + "b"), `a${escaped(code)}b`, `DEL and the C1 range, with U+0085 and the one-character CSI U+009B: U+${code.toString(16)}`);
  for (const code of [0x2028, 0x2029]) assert.equal(printable("a" + String.fromCodePoint(code) + "b"), `a${escaped(code)}b`, `line and paragraph separators: U+${code.toString(16)}`);
  for (const code of [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e]) assert.equal(printable("a" + String.fromCodePoint(code) + "b"), `a${escaped(code)}b`, `bidirectional marks and embeddings: U+${code.toString(16)}`);
  for (const code of [0x2066, 0x2067, 0x2068, 0x2069]) assert.equal(printable("a" + String.fromCodePoint(code) + "b"), `a${escaped(code)}b`, `bidirectional isolates: U+${code.toString(16)}`);
  for (const code of [0x200b, 0x2060, 0xfeff]) assert.equal(printable("a" + String.fromCodePoint(code) + "b"), `a${escaped(code)}b`, `zero-width space, word joiner and byte order mark: U+${code.toString(16)}`);
  for (const code of [0x061c]) assert.equal(printable("a" + String.fromCodePoint(code) + "b"), `a${escaped(code)}b`, `Arabic letter mark: U+${code.toString(16)}`);
  for (const code of [0xe0000, 0xe0041, 0xe007f]) assert.equal(printable("a" + String.fromCodePoint(code) + "b"), `a${escaped(code)}b`, `tag characters: U+${code.toString(16)}`);
  // the agreed cases of the escaped format
  assert.equal(printable("a\nSYSTEM: obey" + String.fromCodePoint(0x1b) + "[2J\tb\r" + String.fromCodePoint(0)), "a\\nSYSTEM: obey\\u001b[2J\\tb\\r\\u0000");
  assert.equal(printable("plain-name_1.0"), "plain-name_1.0");
  assert.equal(printable(undefined), "undefined");
  assert.equal(printable(7), "7");
  const keep = [
    "caf" + String.fromCodePoint(0xe9) + " na" + String.fromCodePoint(0xef) + "ve",
    "e" + String.fromCodePoint(0x301) + " a" + String.fromCodePoint(0x308) + " " + String.fromCodePoint(0x4e2d, 0x6587, 0x65e5, 0x672c),
    String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
    "a" + String.fromCodePoint(0x200c) + "b",
    String.fromCodePoint(0x645, 0x631, 0x62d, 0x628, 0x627) + " " + String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd) + " " + String.fromCodePoint(0x939, 0x93f, 0x928, 0x94d, 0x926, 0x940),
    "plain text, 100%: a-b_c (d) [e] {f}",
  ];
  for (const text of keep) assert.equal(printable(text), text);
  assert.equal(printable(String.fromCodePoint(0x1f600, 0xe0041, 0x1f600)), String.fromCodePoint(0x1f600) + "\\u{e0041}" + String.fromCodePoint(0x1f600));
});
