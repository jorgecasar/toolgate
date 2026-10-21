import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { COMMAND_KIND, commandKind, hashFile, installCommands } from "../src/commands/install.js";
import { installAssets, readLock, replaceUnit, sameFile } from "../src/skills/install.js";
import { writeCorpus } from "../src/skills/corpus.js";
import { syncCollection } from "../src/skills/collection.js";
import { scanCommands } from "../src/skills/scan.js";
import { git as hermeticGit } from "./support/git.js";
import { SKIP_AS_ROOT } from "./support/skips.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-cmd-${name}-`));
const git = (cwd, ...args) =>
  hermeticGit(cwd, ...args);
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const REVIEW =
  "---\ndescription: Review a pull request\nargument-hint: <number>\nallowed-tools: Bash(gh:*)\nmodel: opus\n---\nReview PR $ARGUMENTS.\nStatus: !`git status`\nRead @docs/guide.md first.\n";
const COMMIT = "---\ndescription: Write a commit message\n---\nCommit what changed.\n";

// A real git repository, as for skills: the install code only ever talks to git.
function remoteRepo(layout = (root) => {
  put(root, "commands/review.md", REVIEW);
  put(root, "commands/git/commit.md", COMMIT);
  put(root, "commands/bad.md", "---\nname: bad\ndescription: d\n---\n");
  put(root, "commands/notes.txt", "not a command\n");
  put(root, "README.md", "# a repository\n");
  put(root, "LICENSE.md", "MIT License\n");
  fs.symlinkSync("review.md", path.join(root, "commands/link.md"));
}) {
  const root = tmp("remote");
  git(root, "init", "-q", "-b", "main");
  layout(root);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return {
    root,
    spec: `file://${root}`,
    commit: () => git(root, "rev-parse", "HEAD").trim(),
    commitAll: (message) => (git(root, "add", "-A"), git(root, "commit", "-q", "-m", message)),
  };
}
const project = () => ({ projectDir: tmp("project"), cache: tmp("cache"), allowFile: true });
const install = (remote, env, extra = {}) => installCommands({ spec: remote.spec, ...env, ...extra });
const read = (env, file) => fs.readFileSync(path.join(env.projectDir, file), "utf8");
const exists = (env, file) => fs.existsSync(path.join(env.projectDir, file));

test("install commands: copies the normalized form, reports what it skipped, and writes its own lock", () => {
  const remote = remoteRepo();
  const env = project();
  const result = install(remote, env);
  assert.deepEqual([result.installed, result.updated, result.unchanged], [["git-commit", "review"], [], []]);
  assert.deepEqual(result.skipped.map((s) => s.name).sort(), ["bad", "link"]);
  assert.match(result.skipped.find((s) => s.name === "bad").reason, /has no body/);
  assert.match(result.skipped.find((s) => s.name === "link").reason, /symlink/);

  const copy = read(env, ".toolgate/commands/review.md");
  assert.match(copy, /^---\nname: "review"\ndescription: "Review a pull request"\nargument-hint: "<number>"\n---\n/);
  assert.doesNotMatch(copy, /allowed-tools|model:|!`|@docs/);
  assert.match(copy, /\(run `git status` and use its output here\)/);
  assert.match(copy, /\(read `docs\/guide\.md`\)/);
  assert.match(copy, /\$ARGUMENTS/);
  assert.ok(exists(env, ".toolgate/commands/git-commit.md"));

  const lock = readLock(path.join(env.projectDir, ".toolgate/commands.lock.json"), "commands");
  assert.deepEqual(Object.keys(lock.commands), ["git-commit", "review"]);
  assert.deepEqual(lock.commands.review, {
    source: remote.spec,
    commit: remote.commit(),
    path: "commands/review.md",
    hash: hashFile(path.join(env.projectDir, ".toolgate/commands/review.md")),
    dropped: ["allowed-tools", "model"],
  });
  assert.equal(lock.commands["git-commit"].dropped, undefined, "an entry with nothing dropped says nothing");
  assert.equal(lock.sources[remote.spec].path, "commands");
  assert.ok(!exists(env, ".toolgate/skills.lock.json"), "the skills lock is not touched");
  assert.ok(exists(env, ".toolgate/commands/.licenses"), "the license is kept next to the commands");
});

test("install commands: the licenses folder is not scanned as commands", () => {
  const remote = remoteRepo();
  const env = project();
  install(remote, env);
  const found = scanCommands([{ dir: path.join(env.projectDir, ".toolgate/commands") }]);
  assert.deepEqual(found.map((c) => c.name), ["git-commit", "review"]);
});

test("install commands again: an unchanged source is not rewritten, a changed one is updated, an edited copy is kept", () => {
  const remote = remoteRepo();
  const env = project();
  install(remote, env);
  const again = install(remote, env);
  assert.deepEqual([again.installed, again.updated, again.unchanged], [[], [], ["git-commit", "review"]]);

  put(remote.root, "commands/git/commit.md", COMMIT.replace("changed", "staged"));
  remote.commitAll("edit");
  const changed = install(remote, env);
  assert.deepEqual([changed.updated, changed.unchanged], [["git-commit"], ["review"]]);

  fs.appendFileSync(path.join(env.projectDir, ".toolgate/commands/review.md"), "my own line\n");
  put(remote.root, "commands/review.md", REVIEW + "more\n");
  remote.commitAll("edit again");
  const blocked = install(remote, env);
  assert.match(blocked.skipped.find((s) => s.name === "review").reason, /edited since it was installed/);
  assert.match(read(env, ".toolgate/commands/review.md"), /my own line/);
  assert.deepEqual(install(remote, env, { force: true }).updated, ["review"]);
});

test("install commands: a command the user already has is not replaced without --force", () => {
  const remote = remoteRepo();
  const env = project();
  put(env.projectDir, ".toolgate/commands/review.md", "mine\n");
  const result = install(remote, env);
  assert.deepEqual(result.installed, ["git-commit"]);
  assert.match(result.skipped.find((s) => s.name === "review").reason, /not installed by toolgate/);
  assert.equal(read(env, ".toolgate/commands/review.md"), "mine\n");
});

test("install commands: the default folders are tried, and top-level markdown files are never commands", () => {
  const claude = remoteRepo((root) => put(root, ".claude/commands/review.md", REVIEW));
  assert.deepEqual(install(claude, project()).installed, ["review"]);

  const readmeOnly = remoteRepo((root) => (put(root, "README.md", "# hi\n"), put(root, "CHANGELOG.md", "# log\n")));
  assert.throws(() => install(readmeOnly, project()), /no commands folder found/);

  const empty = remoteRepo((root) => put(root, "commands/.keep", ""));
  assert.throws(() => install(empty, project()), /no commands found .*<name>\.md files in commands/);
});

test("install commands: names pick commands, --exclude drops them, and an unknown name lists what is available", () => {
  const remote = remoteRepo();
  assert.deepEqual(install(remote, project(), { names: ["review"] }).installed, ["review"]);
  assert.deepEqual(install(remote, project(), { exclude: ["review"] }).installed, ["git-commit"]);
  assert.throws(() => install(remote, project(), { names: ["nope"] }), /not found in .*: nope \(available: git-commit, review\)/);
});

test("install commands: a name that clashes with the bridge command or the catalog is skipped", () => {
  const remote = remoteRepo((root) => {
    put(root, "commands/toolgate.md", COMMIT);
    put(root, "commands/index.md", COMMIT);
    put(root, "commands/ok.md", COMMIT);
  });
  const result = install(remote, project());
  assert.deepEqual(result.installed, ["ok"]);
  assert.deepEqual(result.skipped.map((s) => s.name).sort(), ["index", "toolgate"]);
});

test("install commands: the dialect says how the bodies are written, and an unknown one is refused", () => {
  const remote = remoteRepo((root) => put(root, "commands/greet.md", "---\ndescription: Greet\n---\nHello $ARGUMENTS\n"));
  const env = project();
  assert.deepEqual(install(remote, env, { dialect: "codex" }).installed, ["greet"]);
  assert.match(read(env, ".toolgate/commands/greet.md"), /Hello \$ARGUMENTS/);
  assert.throws(() => commandKind("nope"), /unknown command dialect "nope"/);
  assert.equal(Object.isFrozen(COMMAND_KIND), true);
});

function setup(cwd, config) {
  const out = [];
  const err = [];
  const calls = [];
  let corpus = null;
  const execFn = (bin, args) => {
    calls.push([bin, ...args].join(" "));
    if (args[1] === "add") corpus = args[2];
    if (args[1] === "show") return `Collection: ${args[2]}\n  Path:     ${corpus}\n`;
    return "";
  };
  return {
    out: () => out.join(""),
    err: () => err.join(""),
    calls,
    deps: {
      cwd,
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      loadConfigFn: () => config,
      daemon: { status: async () => ({ running: false }) },
      skills: { execFn },
      install: { allowFile: true, cache: tmp("cli-cache") },
    },
  };
}

test("toolgate commands install, list and search: installed commands are indexed and found as commands", async () => {
  const cwd = tmp("cli");
  const remote = remoteRepo();
  const t = setup(cwd, {});
  assert.equal(await run(["commands", "install", remote.spec], t.deps), 0);
  assert.match(t.out(), /installed 2 commands, updated 0, unchanged 0 from file:\/\//);
  assert.match(t.out(), /new: git-commit, review/);
  assert.match(t.out(), /skipped bad: .*has no body/);
  assert.match(t.out(), /skills index has 0 skills and 2 commands/);
  assert.ok(t.calls.some((c) => c.includes("collection add")));

  const listing = setup(cwd, {});
  assert.equal(await run(["commands", "list"], listing.deps), 0);
  assert.match(listing.out(), /^\/git-commit\t.*git-commit\.md$/m);
  assert.match(listing.out(), /^\/review\t/m);
  const json = setup(cwd, {});
  assert.equal(await run(["commands", "list", "--json"], json.deps), 0);
  assert.deepEqual(JSON.parse(json.out()).map((c) => [c.name, c.argumentHint]), [["git-commit", undefined], ["review", "<number>"]]);

  const found = setup(cwd, {});
  assert.equal(await run(["commands", "index"], found.deps), 0);
  const search = setup(cwd, {});
  assert.equal(await run(["commands", "search", "review", "a", "pull", "request"], search.deps), 0);
  assert.match(search.out(), /^\/review\t/m);
});

test("toolgate commands: --dialect, a missing source, an unknown action and no commands at all", async () => {
  const cwd = tmp("cli");
  const t = setup(cwd, {});
  const remote = remoteRepo((root) => put(root, "commands/greet.md", "---\ndescription: Greet\n---\nHello $ARGUMENTS\n"));
  assert.equal(await run(["commands", "install", remote.spec, "--dialect", "codex"], t.deps), 0);
  assert.match(fs.readFileSync(path.join(cwd, ".toolgate/commands/greet.md"), "utf8"), /Hello \$ARGUMENTS/);

  const none = setup(tmp("cli"), {});
  assert.equal(await run(["commands", "list"], none.deps), 0);
  assert.match(none.out(), /no commands found/);
  assert.equal(await run(["commands", "install"], none.deps), 1);
  assert.match(none.err(), /usage: toolgate commands install/);
  assert.equal(await run(["commands", "nope"], none.deps), 1);
  assert.match(none.err(), /expected install, update, status, import, bridge, list, index or search/);
});

test("toolgate commands install adds .toolgate/commands to the project config when it is not one of the sources", async () => {
  const cwd = tmp("cli");
  const other = tmp("others");
  const t = setup(cwd, { commands: { sources: [{ dir: other }] } });
  assert.equal(await run(["commands", "install", remoteRepo().spec], t.deps), 0);
  assert.match(t.out(), /added commands\.sources \{"dir":"\.toolgate\/commands"\} to the project config/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, ".toolgate/config.json"), "utf8")).commands.sources, [{ dir: ".toolgate/commands" }]);
});
test("toolgate commands install that cannot edit the config prints why and the command to run", async () => {
  const cwd = tmp("cli");
  const other = tmp("others");
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  fs.writeFileSync(path.join(cwd, ".toolgate/config.json"), "{ not json");
  const t = setup(cwd, { commands: { sources: [{ dir: other }] } });
  assert.equal(await run(["commands", "install", remoteRepo().spec], t.deps), 0);
  assert.match(t.out(), /\.toolgate\/commands is not one of the configured commands sources.*not valid JSON.*toolgate config add commands\.sources/);
});

test("install commands: a name too long for the filesystem is skipped, and the others and the lock still go through", () => {
  const remote = remoteRepo((root) => {
    put(root, "commands/ok.md", COMMIT);
    put(root, "commands/long.md", `---\nname: ${"a".repeat(252)}\ndescription: d\n---\nbody\n`);
  });
  const env = project();
  const result = install(remote, env);
  assert.deepEqual(result.installed, ["ok"]);
  assert.match(result.skipped.find((s) => s.name === "long").reason, /over the install limit of 100/);
  assert.deepEqual(Object.keys(readLock(path.join(env.projectDir, ".toolgate/commands.lock.json"), "commands").commands), ["ok"]);
  assert.deepEqual(install(remote, env).unchanged, ["ok"]);
});

test("install: a unit that cannot be written is reported and the lock keeps the rest", () => {
  const remote = remoteRepo();
  const env = project();
  const kind = { ...COMMAND_KIND, copy: (file, to, item) => (item.name === "review" ? fs.writeFileSync("/nonexistent-dir/x", "") : COMMAND_KIND.copy(file, to, item)) };
  const result = installAssets(kind, { spec: remote.spec, ...env });
  assert.deepEqual(result.installed, ["git-commit"]);
  assert.match(result.skipped.find((s) => s.name === "review").reason, /could not be written: ENOENT/);
  assert.deepEqual(Object.keys(readLock(path.join(env.projectDir, ".toolgate/commands.lock.json"), "commands").commands), ["git-commit"]);
  assert.ok(!exists(env, ".toolgate/commands/review.md") && !fs.readdirSync(path.join(env.projectDir, ".toolgate/commands")).some((n) => n.includes(".installing-")));
});

test("install commands: a commands folder that is a symlink leaving the repository is refused", () => {
  const outside = tmp("outside");
  put(outside, "private.md", COMMIT);
  const remote = remoteRepo((root) => fs.symlinkSync(outside, path.join(root, "commands")));
  const env = project();
  assert.throws(() => install(remote, env), /commands is a symlink that leaves the repository/);
  assert.ok(!exists(env, ".toolgate/commands/private.md"));

  const inside = remoteRepo((root) => {
    put(root, "real/review.md", REVIEW);
    fs.symlinkSync("real", path.join(root, "commands"));
  });
  assert.deepEqual(install(inside, project()).installed, ["review"]);
});

test("install commands: Foo and foo are one name on a case-insensitive filesystem, so only the first is kept", () => {
  const remote = remoteRepo((root) => {
    put(root, "commands/a.md", COMMIT.replace("---\ndescription", "---\nname: Foo\ndescription"));
    put(root, "commands/b.md", COMMIT.replace("---\ndescription", "---\nname: foo\ndescription"));
  });
  const result = install(remote, project());
  assert.equal(result.installed.length, 1);
  assert.match(result.skipped[0].reason, /already provided by/);
});

test("install commands: the dialect is recorded with the source, and --dialect with no value is an error", async () => {
  const remote = remoteRepo();
  const env = project();
  install(remote, env, { dialect: "codex" });
  assert.equal(readLock(path.join(env.projectDir, ".toolgate/commands.lock.json"), "commands").sources[remote.spec].dialect, "codex");

  const t = setup(tmp("cli"), {});
  assert.equal(await run(["commands", "install", remote.spec, "--dialect"], t.deps), 1);
  assert.match(t.err(), /unknown command dialect ""/);
});

test("toolgate commands install: control characters of a repository never reach the output", async () => {
  const remote = remoteRepo((root) => {
    put(root, "commands/ok.md", COMMIT);
    put(root, "commands/bad\u001b[31m.md", "no frontmatter\n");
  });
  const t = setup(tmp("cli"), {});
  await run(["commands", "install", remote.spec], t.deps);
  assert.doesNotMatch(t.out(), /\u001b/);
  assert.match(t.out(), /skipped bad\\u001b\[31m:/);
});

test("a skill or command already stored with a long name still indexes: the cap is only for what an install writes", () => {
  const long = "a".repeat(150);
  const corpus = path.join(tmp("corpus"), "corpus");
  writeCorpus([{ name: long, description: "d", tags: [], mcps: [], path: "/s/SKILL.md" }, { name: long, kind: "command", description: "d", tags: [], mcps: [], path: "/c.md" }], corpus);
  assert.ok(fs.existsSync(path.join(corpus, `${long}.md`)) && fs.existsSync(path.join(corpus, "commands", `${long}.md`)));
});

test("install: names over 100 characters are skipped for skills and commands, and exactly 100 is installed", () => {
  const remote = remoteRepo((root) => {
    put(root, `commands/${"b".repeat(100)}.md`, COMMIT);
    put(root, `commands/${"c".repeat(101)}.md`, COMMIT);
  });
  const result = install(remote, project());
  assert.deepEqual(result.installed, ["b".repeat(100)]);
  assert.match(result.skipped[0].reason, /over the install limit of 100/);
});

test("install commands: a name that differs only in case from a stored or locked one is skipped, with or without --force", () => {
  const first = remoteRepo((root) => put(root, "commands/a.md", "---\nname: Foo\ndescription: first\n---\nfirst body\n"));
  const second = remoteRepo((root) => put(root, "commands/a.md", "---\nname: foo\ndescription: second\n---\nsecond body\n"));
  const env = project();
  install(first, env);
  for (const force of [false, true]) {
    const result = install(second, env, { force });
    assert.deepEqual(result.installed, []);
    assert.match(result.skipped[0].reason, /differs only in case from the installed "Foo"/);
  }
  assert.match(read(env, ".toolgate/commands/Foo.md"), /first body/);
  assert.deepEqual(install(first, env).unchanged, ["Foo"], "the stored command is not flagged as edited");
});

test("install commands: without --dialect a source keeps the dialect it was installed with", () => {
  const remote = remoteRepo((root) => put(root, "commands/greet.md", "---\ndescription: Greet\n---\nHello $ARGUMENTS\n"));
  const env = project();
  assert.deepEqual(install(remote, env, { dialect: "codex" }).installed, ["greet"]);
  const again = install(remote, env);
  assert.deepEqual(again.unchanged, ["greet"]);
  assert.equal(readLock(path.join(env.projectDir, ".toolgate/commands.lock.json"), "commands").sources[remote.spec].dialect, "codex");
  assert.match(read(env, ".toolgate/commands/greet.md"), /Hello \$ARGUMENTS/);
});

test("replaceUnit: when the new copy cannot be written the old one is still there, and nothing is left in the store", () => {
  const root = tmp("replace");
  put(root, ".toolgate/commands/unit.md", "old\n");
  const kind = { copy: () => { throw new Error("boom"); }, fileName: (name) => `${name}.md` };
  assert.throws(() => replaceUnit(kind, { root, storeDir: path.join(".toolgate", "commands"), name: "unit", from: "x" }), /boom/);
  assert.equal(fs.readFileSync(path.join(root, ".toolgate/commands/unit.md"), "utf8"), "old\n");
  assert.deepEqual(fs.readdirSync(path.join(root, ".toolgate/commands")), ["unit.md"]);
});

test("install commands: a commands folder that is a symlink to the repository root is refused", () => {
  const remote = remoteRepo((root) => {
    put(root, "README.md", "# hi\n");
    put(root, "other.md", COMMIT);
    fs.symlinkSync(".", path.join(root, "commands"));
  });
  assert.throws(() => install(remote, project()), /commands is a symlink to the repository root/);
});

test("a hand-written command with a long name is read and indexed: the cap is an install limit, not a reading one", () => {
  const dir = tmp("handwritten");
  const name = "x".repeat(150);
  put(dir, `${name}.md`, COMMIT);
  assert.deepEqual(scanCommands([{ dir }]).map((c) => c.name), [name]);
  const corpusDir = path.join(dir, "corpus");
  const result = syncCollection({ sources: [], commandSources: [{ dir }], corpusDir, stateFile: path.join(dir, "state.json"), collection: "c", execFn: (bin, args) => (args[1] === "show" ? `Path: ${corpusDir}` : "") });
  assert.equal(result.commands, 1);
  assert.ok(fs.existsSync(path.join(corpusDir, "commands", `${name}.md`)));
});

const renamedRepo = () => remoteRepo((root) => put(root, "commands/a.md", "---\nname: foo\ndescription: d\n---\nbody\n"));
const rename = (remote) => {
  put(remote.root, "commands/a.md", "---\nname: Foo\ndescription: d\n---\nbody\n");
  remote.commitAll("rename");
};
const storeFiles = (env) => fs.readdirSync(path.join(env.projectDir, ".toolgate/commands")).filter((n) => n.endsWith(".md"));
const caseInsensitive = (env) => fs.existsSync(path.join(env.projectDir, ".toolgate/commands", "FOO.md"));
const lockOf = (env) => readLock(path.join(env.projectDir, ".toolgate/commands.lock.json"), "commands");

test("install commands: a case-only rename by the same source is skipped with a clear message, and nothing is deleted", () => {
  const remote = renamedRepo();
  const env = project();
  install(remote, env);
  const before = lockOf(env);
  rename(remote);
  const result = install(remote, env);
  assert.deepEqual([result.installed, result.updated], [[], []]);
  assert.match(result.skipped[0].reason, /renamed upstream from "foo"; remove the installed foo\.md by hand and install again/);
  assert.deepEqual(storeFiles(env), ["foo.md"]);
  assert.deepEqual(lockOf(env).commands, before.commands);
});

test("install commands: an edited copy survives a case-only rename, with and without --force on a case-sensitive store", () => {
  const remote = renamedRepo();
  const env = project();
  install(remote, env);
  fs.appendFileSync(path.join(env.projectDir, ".toolgate/commands/foo.md"), "my own line\n");
  rename(remote);
  install(remote, env);
  assert.match(read(env, ".toolgate/commands/foo.md"), /my own line/);
  install(remote, env, { force: true });
  if (!caseInsensitive(env)) assert.match(read(env, ".toolgate/commands/foo.md"), /my own line/, "a different file is never touched");
});

test("install commands: --force rewrites a case-only rename in place where the filesystem ignores case, and skips it where it does not", () => {
  const remote = renamedRepo();
  const env = project();
  install(remote, env);
  rename(remote);
  const result = install(remote, env, { force: true });
  if (caseInsensitive(env)) {
    assert.deepEqual([result.installed.concat(result.updated), result.skipped], [["Foo"], []]);
    assert.deepEqual(storeFiles(env), ["Foo.md"]);
    assert.deepEqual(Object.keys(lockOf(env).commands), ["Foo"]);
    assert.deepEqual(install(remote, env).unchanged, ["Foo"]);
  } else {
    assert.deepEqual(result.installed.concat(result.updated), []);
    assert.deepEqual(storeFiles(env), ["foo.md"]);
    assert.deepEqual(Object.keys(lockOf(env).commands), ["foo"]);
  }
});

test("install commands: a source offering both foo and Foo is installed the same way every time", () => {
  const remote = remoteRepo((root) => {
    put(root, "commands/a.md", "---\nname: Foo\ndescription: d\n---\nbody A\n");
    put(root, "commands/b.md", "---\nname: foo\ndescription: d\n---\nbody B\n");
  });
  const env = project();
  const first = install(remote, env);
  const second = install(remote, env);
  assert.equal(first.installed.length, 1);
  assert.deepEqual([second.installed, second.updated, second.unchanged.length], [[], [], 1]);
  assert.deepEqual(Object.keys(lockOf(env).commands), first.installed);
});

test("install commands: a stored file that is not in the lock still counts for a case clash, dot names included", () => {
  const source = remoteRepo((root) => put(root, "commands/a.md", "---\nname: .Hidden\ndescription: d\n---\nb\n"));
  const env = project();
  put(env.projectDir, ".toolgate/commands/.hidden.md", "mine\n");
  const result = install(source, env);
  assert.deepEqual(result.installed, []);
  assert.match(result.skipped[0].reason, /differs only in case from the installed ".hidden"/);
  assert.equal(read(env, ".toolgate/commands/.hidden.md"), "mine\n");
});

test("install: a case-only rename is rewritten in place only when the old and the new spelling are the same file", () => {
  // A store whose names do not collapse (a case-sensitive volume) is simulated by a kind that keeps
  // `Foo` in a file of its own: the old `foo.md` is then a different file, and must be left alone.
  const remote = renamedRepo();
  const env = project();
  install(remote, env);
  rename(remote);
  const kind = { ...COMMAND_KIND, fileName: (name) => (name === "Foo" ? "Foo-elsewhere.md" : `${name}.md`) };
  const result = installAssets(kind, { spec: remote.spec, ...env, force: true });
  assert.deepEqual([result.installed, result.updated], [[], []]);
  assert.match(result.skipped[0].reason, /renamed upstream from "foo"/);
  assert.ok(!exists(env, ".toolgate/commands/Foo-elsewhere.md"));
  assert.deepEqual(Object.keys(lockOf(env).commands), ["foo"]);
});

test("sameFile: a path and its hard link are one file, two files with the same content are not, a missing one is none", () => {
  const dir = tmp("same");
  put(dir, "a", "x");
  put(dir, "b", "x");
  fs.linkSync(path.join(dir, "a"), path.join(dir, "c"));
  assert.equal(sameFile(path.join(dir, "a"), path.join(dir, "c")), true);
  assert.equal(sameFile(path.join(dir, "a"), path.join(dir, "b")), false);
  assert.equal(sameFile(path.join(dir, "a"), path.join(dir, "missing")), false);
});

test("install commands: a refused default folder is passed over for the next one, but --path stays an error", () => {
  const remote = remoteRepo((root) => {
    fs.symlinkSync(".", path.join(root, "commands"));
    put(root, ".claude/commands/review.md", REVIEW);
  });
  assert.deepEqual(install(remote, project()).installed, ["review"]);
  assert.throws(() => install(remote, project(), { subdir: "commands" }), /commands is a symlink to the repository root/);
  const onlyBad = remoteRepo((root) => fs.symlinkSync(".", path.join(root, "commands")));
  assert.throws(() => install(onlyBad, project()), /commands is a symlink to the repository root/);
});

test("install commands: when nothing could be written the lock does not move to the new commit", { skip: SKIP_AS_ROOT }, () => {
  const remote = remoteRepo();
  const env = project();
  install(remote, env);
  const lockFile = path.join(env.projectDir, ".toolgate/commands.lock.json");
  const before = readLock(lockFile, "commands");
  put(remote.root, "commands/review.md", REVIEW + "more\n");
  put(remote.root, "commands/git/commit.md", COMMIT + "more\n");
  remote.commitAll("change both");
  const store = path.join(env.projectDir, ".toolgate/commands");
  fs.chmodSync(store, 0o500);
  try {
    const result = install(remote, env);
    assert.deepEqual([result.installed, result.updated], [[], []]);
    assert.match(result.skipped.find((s) => s.name === "review").reason, /could not be written: (EACCES|EPERM)/);
  } finally {
    fs.chmodSync(store, 0o700);
  }
  assert.deepEqual(readLock(lockFile, "commands"), before);
});

test("install commands: after the installed foo.md is removed by hand, Foo installs, with or without --force", () => {
  for (const force of [false, true]) {
    const remote = renamedRepo();
    const env = project();
    install(remote, env);
    rename(remote);
    assert.match(install(remote, env).skipped[0].reason, /remove the installed foo\.md by hand/);
    fs.rmSync(path.join(env.projectDir, ".toolgate/commands/foo.md"));
    const result = install(remote, env, { force });
    assert.deepEqual([result.installed, result.skipped], [["Foo"], []], `force ${force}`);
    assert.deepEqual(Object.keys(lockOf(env).commands), ["Foo"], "the stale entry for foo is dropped");
    assert.deepEqual(install(remote, env).unchanged, ["Foo"]);
  }
});

test("install commands: what was not kept and what has no equivalent is in the lock and printed, never silent", async () => {
  const remote = remoteRepo((root) => {
    put(root, "commands/deploy.md", "---\ndescription: Deploy\nallowed-tools: Bash\nmodel: opus\n---\nDeploy $TARGET with !`make deploy`.\n");
    put(root, "commands/plain.md", COMMIT);
  });
  const env = project();
  const t = setup(tmp("cli"), {});
  assert.equal(await run(["commands", "install", remote.spec], t.deps), 0);
  assert.match(t.out(), /^  deploy: not kept \(never copied into the store\): allowed-tools, model$/m);
  assert.match(t.out(), /^  deploy: placeholders with no equivalent, left as text: \$TARGET$/m);
  assert.doesNotMatch(t.out(), /plain: not kept/);
  const here = install(remote, env);
  assert.deepEqual(here.notes.deploy, ["not kept (never copied into the store): allowed-tools, model", "placeholders with no equivalent, left as text: $TARGET"]);
  const stored = readLock(path.join(env.projectDir, ".toolgate/commands.lock.json"), "commands").commands;
  assert.deepEqual([stored.deploy.dropped, stored.deploy.unsupported, stored.plain.dropped], [["allowed-tools", "model"], ["$TARGET"], undefined]);
  // A lock whose list is not a list of strings is reported, not trusted.
  const file = path.join(env.projectDir, ".toolgate/commands.lock.json");
  const broken = JSON.parse(fs.readFileSync(file, "utf8"));
  broken.commands.deploy.dropped = "model";
  fs.writeFileSync(file, JSON.stringify(broken));
  assert.match(readLock(file, "commands").invalid.join(";"), /commands\.deploy has a dropped of the wrong type/);
});
