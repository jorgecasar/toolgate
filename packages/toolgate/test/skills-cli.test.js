import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import { defaultCollection } from "../src/skills/corpus.js";
import { git as hermeticGit } from "./support/git.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-skills-cli-"));

// A qmd that remembers the folder passed to `collection add` and reports it back on `show`.
function fakeQmd() {
  let corpus = null;
  return (bin, args) => {
    if (args[1] === "add") corpus = args[2];
    if (args[1] !== "show") return "";
    if (corpus === null) throw new Error(`Collection not found: ${args[2]}`);
    return `Collection: ${args[2]}\n  Path:     ${corpus}\n`;
  };
}

function setup(cwd, config, execFn) {
  const out = [];
  const err = [];
  const calls = [];
  const exec = execFn ?? fakeQmd();
  return {
    out: () => out.join(""),
    err: () => err.join(""),
    calls,
    deps: {
      cwd,
      // An empty user config dir: the skills the developer installed at the user level must not change what a test counts.
      env: { ...process.env, XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-skills-cli-xdg-")) },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      loadConfigFn: () => config,
      daemon: { status: async () => ({ running: false }) }, // never touch a real daemon
      skills: { execFn: (bin, args) => (calls.push([bin, ...args].join(" ")), exec(bin, args)) },
    },
  };
}

test("skills index reads the configured sources and is a no-op while nothing changed", async () => {
  const t = setup(tmp(), { skills: { sources: [{ dir: FIXTURES }] } });
  assert.equal(await run(["skills", "index"], t.deps), 0);
  assert.match(t.out(), /indexed 2 skills/);
  assert.equal(await run(["skills", "index"], t.deps), 0);
  assert.match(t.out(), /up to date \(2\)/);
  const adds = t.calls.filter((c) => c.includes("collection add"));
  assert.equal(adds.length, 1);
  assert.match(adds[0], /\.toolgate\/skills-index\/corpus --name skills/);

  assert.equal(await run(["skills", "index", "--force"], t.deps), 0);
  assert.equal(t.calls.filter((c) => c.includes("collection add")).length, 2);
});

test("skills uses the default source dirs that exist when none are configured", async () => {
  const cwd = tmp();
  fs.cpSync(FIXTURES, path.join(cwd, ".rulesync", "skills"), { recursive: true });
  const t = setup(cwd, {});
  assert.equal(await run(["skills", "index"], t.deps), 0);
  assert.match(t.out(), /indexed 2 skills/);

  const empty = setup(tmp(), {});
  assert.equal(await run(["skills", "index"], empty.deps), 1);
  assert.match(empty.err(), /no skills sources configured/);
});

test("skills search prints names, --json prints the result, and a missing qmd says so", async () => {
  const cwd = tmp();
  const config = { skills: { sources: [{ dir: FIXTURES }] } };
  const down = () => {
    throw new Error("spawn qmd ENOENT");
  };
  const t = setup(cwd, config, (bin, args) => (args[0] === "query" ? down() : ""));
  assert.equal(await run(["skills", "index"], t.deps), 0);

  assert.equal(await run(["skills", "search", "export", "a", "pdf"], t.deps), 0);
  assert.match(t.out(), /^pdf-export\t.*SKILL\.md$/m);
  assert.match(t.err(), /qmd unavailable: spawn qmd ENOENT; using the _index\.md fallback/);

  const json = setup(cwd, config, (bin, args) => (args[0] === "query" ? down() : ""));
  assert.equal(await run(["skills", "search", "pull", "request", "--json"], json.deps), 0);
  const parsed = JSON.parse(json.out());
  assert.equal(parsed.source, "fallback");
  assert.equal(parsed.results[0].name, "pr-review");
});

test("skills reports bad usage and a colliding collection with exit code 1", async () => {
  const t = setup(tmp(), { skills: { sources: [{ dir: FIXTURES }] } });
  assert.equal(await run(["skills", "bogus"], t.deps), 1);
  assert.match(t.err(), /expected index, search, install, update, remove, status or recommended/);
  assert.equal(await run(["skills", "search"], t.deps), 1);

  const taken = setup(tmp(), { skills: { sources: [{ dir: FIXTURES }] } }, (bin, args) => {
    if (args[1] === "add") throw Object.assign(new Error("failed"), { stderr: "Collection 'skills' already exists." });
    return args[1] === "show" ? "Collection: skills\n  Path:     /elsewhere\n" : "";
  });
  assert.equal(await run(["skills", "index"], taken.deps), 1);
  assert.match(taken.err(), /points at \/elsewhere/);
});

test("skills index registers the project's own collection by default and the configured one when set", async () => {
  const cwd = tmp();
  const byDefault = setup(cwd, { skills: { sources: [{ dir: FIXTURES }] } });
  assert.equal(await run(["skills", "index"], byDefault.deps), 0);
  const name = defaultCollection(cwd);
  assert.match(byDefault.calls.find((c) => c.includes("collection add")), new RegExp(`--name ${name} `));
  assert.ok(byDefault.calls.includes(`qmd embed -c ${name}`));

  const named = setup(tmp(), { skills: { sources: [{ dir: FIXTURES }], collection: "team-skills" } });
  assert.equal(await run(["skills", "index"], named.deps), 0);
  assert.match(named.calls.find((c) => c.includes("collection add")), /--name team-skills /);
});

test("user-level sources do not replace the project's default skills dirs", async () => {
  const cwd = tmp();
  fs.cpSync(FIXTURES, path.join(cwd, ".rulesync", "skills"), { recursive: true });
  const personal = path.join(cwd, "personal");
  fs.mkdirSync(path.join(personal, "mine"), { recursive: true });
  fs.writeFileSync(path.join(personal, "mine", "SKILL.md"), "---\nname: mine\ndescription: my own\n---\n");

  const t = setup(cwd, { skills: { sources: [{ dir: personal, level: "user" }] } });
  assert.equal(await run(["skills", "index"], t.deps), 0);
  assert.match(t.out(), /indexed 3 skills/);

  const card = fs.readFileSync(path.join(cwd, ".toolgate", "skills-index", "corpus", "mine.md"), "utf8");
  assert.match(card, /^- Level: user$/m);
});

test("skills index: an explicit empty project sources list does not bring the default dirs back", async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate", "skills", "a"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate", "skills", "a", "SKILL.md"), "---\nname: a\ndescription: d\n---\n");
  const s = setup(cwd, { skills: { sources: [], declaredLevels: ["project"] } });
  assert.equal(await run(["skills", "index"], s.deps), 1);
  assert.match(s.err(), /no skills sources/);
});

// A real local git repository stands in for the remote: `install` only ever talks to git.
function remote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-remote-"));
  const git = (...args) =>
    hermeticGit(root, ...args);
  git("init", "-q", "-b", "main");
  for (const name of ["alpha", "beta"]) {
    fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill\n---\n`);
  }
  fs.mkdirSync(path.join(root, "skills", "bad"));
  fs.writeFileSync(path.join(root, "skills", "bad", "SKILL.md"), "---\ndescription: no name\n---\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return `file://${root}`;
}

function installDeps(cwd, config, extra = {}) {
  const t = setup(cwd, config);
  t.deps.install = { allowFile: true, cache: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-cache-")), ...extra };
  return t;
}

test("skills install copies a remote repository's skills, reports what it did, and indexes them", async () => {
  const cwd = tmp();
  const t = installDeps(cwd, {});
  assert.equal(await run(["skills", "install", remote()], t.deps), 0);
  assert.match(t.out(), /toolgate: installed 2 skills, updated 0, unchanged 0 from file:\/\/.* \([0-9a-f]{7}\)/);
  assert.match(t.out(), /new: alpha, beta/);
  assert.match(t.out(), /skipped bad: .*missing "name"/);
  assert.match(t.out(), /skills index has 2 skills/);
  assert.ok(fs.existsSync(path.join(cwd, ".toolgate", "skills", "alpha", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(cwd, ".toolgate", "skills.lock.json")));
  assert.ok(t.calls.some((c) => c.includes("collection add")), "the new skills were indexed");
});

test("skills install: names, --exclude and --force are honoured, and a repeat reports unchanged", async () => {
  const cwd = tmp();
  const source = remote();
  const t = installDeps(cwd, {}, { exclude: ["alpha"] });
  assert.equal(await run(["skills", "install", source], t.deps), 0);
  assert.match(t.out(), /new: beta/);
  assert.ok(!fs.existsSync(path.join(cwd, ".toolgate", "skills", "alpha")));

  const again = installDeps(cwd, {}, { exclude: ["alpha"] });
  assert.equal(await run(["skills", "install", source, "beta"], again.deps), 0);
  assert.match(again.out(), /installed 0 skills, updated 0, unchanged 1/);
});

test("skills install adds .toolgate/skills to the project config when it is not one of the sources, and indexes in the same run", async () => {
  const cwd = tmp();
  const t = installDeps(cwd, { skills: { sources: [{ dir: FIXTURES }] } });
  assert.equal(await run(["skills", "install", remote()], t.deps), 0);
  assert.match(t.out(), /added skills\.sources \{"dir":"\.toolgate\/skills"\} to the project config \(\.toolgate\/config\.json\), so these skills are indexed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, ".toolgate/config.json"), "utf8")).skills.sources, [{ dir: ".toolgate/skills" }]);
  assert.ok(t.calls.some((c) => c.includes("collection add")), "the new source is indexed by the same run");
  assert.doesNotMatch(t.out(), /add it with: toolgate config add/);
});
test("skills install that cannot edit the config prints why and the command to run, and indexes nothing", async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  fs.writeFileSync(path.join(cwd, ".toolgate/config.json"), "{ not json");
  const t = installDeps(cwd, { skills: { sources: [{ dir: FIXTURES }] } });
  assert.equal(await run(["skills", "install", remote()], t.deps), 0, "the install itself succeeded");
  assert.match(t.out(), /\.toolgate\/skills is not one of the configured skills sources, so these skills are not indexed \(.*not valid JSON.*\); add it with: toolgate config add skills\.sources/);
  assert.equal(fs.readFileSync(path.join(cwd, ".toolgate/config.json"), "utf8"), "{ not json", "the file is left as it was");
  assert.ok(!t.calls.some((c) => c.includes("collection add")));
});

test("skills install reports an index that could not be built without failing the install", async () => {
  const t = installDeps(tmp(), {}, {});
  const broken = setup(tmp(), {}, (bin, args) => {
    if (args[0] === "update") throw new Error("qmd exploded");
    return "";
  });
  broken.deps.install = t.deps.install;
  assert.equal(await run(["skills", "install", remote()], broken.deps), 0);
  assert.match(broken.out(), /not indexed yet \(qmd exploded\); run: toolgate skills index/);
});

test("skills install: usage, a bad source, and a source with nothing installable exit 1", async () => {
  const t = installDeps(tmp(), {});
  assert.equal(await run(["skills", "install"], t.deps), 1);
  assert.match(t.err(), /usage: toolgate skills install/);
  assert.equal(await run(["skills", "install", "file:///etc"], installDeps(tmp(), {}).deps), 1);

  const bad = installDeps(tmp(), {});
  bad.deps.install.allowFile = false;
  assert.equal(await run(["skills", "install", "file:///etc/passwd"], bad.deps), 1);
  assert.match(bad.err(), /not a supported skills source/);
});

test("skills install retries the index when nothing new was installed, so a failed first index is not forgotten", async () => {
  const cwd = tmp();
  const source = remote();
  let failing = true;
  const flaky = (bin, args) => {
    if (failing && args[0] === "update") throw new Error("qmd timed out");
    return "";
  };
  const first = setup(cwd, {}, flaky);
  first.deps.install = installDeps(cwd, {}).deps.install;
  assert.equal(await run(["skills", "install", source], first.deps), 0);
  assert.match(first.out(), /not indexed yet \(qmd timed out\)/);

  failing = false;
  const second = setup(cwd, {}, (bin, args) => (args[1] === "show" ? "Collection: x\n  Path:     /elsewhere\n" : ""));
  second.deps.install = first.deps.install;
  assert.equal(await run(["skills", "install", source], second.deps), 0);
  assert.match(second.out(), /unchanged 2/);
  assert.match(second.out(), /skills index has 2 skills/);
});

test("skills index restarts a managed daemon that serves fewer documents than the corpus, and says so", async () => {
  const cwd = tmp();
  const config = { skills: { sources: [{ dir: FIXTURES }] } };
  const t = setup(cwd, config);
  const steps = [];
  let served = 1;
  t.deps.fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    const result = body.method === "tools/call" ? { structuredContent: { collections: [{ name: defaultCollection(cwd), documents: served }] } } : {};
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json", "mcp-session-id": "s" }),
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
    };
  };
  let up = true;
  t.deps.daemon = {
    status: async () => ({ running: up }),
    stop: () => (steps.push("stop"), (up = false), { ok: true, message: "Stopped." }),
    ensure: async () => (steps.push("start"), (served = 3), (up = true), { running: true, started: true }),
  };

  assert.equal(await run(["skills", "index"], t.deps), 0);
  assert.deepEqual(steps, ["stop", "start"]);
  assert.match(t.out(), /indexed 2 skills/);
  assert.match(t.out(), /restarting it/);
  assert.match(t.out(), /qmd daemon restarted/);

  steps.length = 0;
  assert.equal(await run(["skills", "index"], t.deps), 0);
  assert.deepEqual(steps, [], "a daemon that now agrees is left alone");
});

test("skills install --local keeps the store out of git and indexes it as the local level", async () => {
  const { runSkills, settings } = await import("../src/skills/cli.js");
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-remote-"));
  const run = (...args) => hermeticGit(remoteRoot, ...args);
  fs.mkdirSync(path.join(remoteRoot, "skills/alpha"), { recursive: true });
  fs.writeFileSync(path.join(remoteRoot, "skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: the alpha skill\n---\nbody\n");
  run("init", "-q", "-b", "main");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-proj-"));
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  const env = { ...process.env, XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-xdg-")), XDG_CACHE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-cache-")) };
  const code = runSkills(["install", `file://${remoteRoot}`], { cwd, config: {}, env, level: "local", install: { allowFile: true }, deps: { execFn: () => "" }, ...io });
  assert.equal(code, 0, out.join(""));
  assert.ok(fs.existsSync(path.join(cwd, ".toolgate/skills.local/alpha/SKILL.md")));
  const ignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
  assert.match(ignore, /\.toolgate\/skills\.local\//);
  assert.match(ignore, /\.toolgate\/skills\.local\.lock\.json/);
  assert.deepEqual(settings({}, cwd, env).sources.map((s) => [path.basename(s.dir), s.level]), [["skills.local", "local"]]);
  assert.deepEqual(settings({ skills: { disabledLevels: ["local"] } }, cwd, env).sources, []);
});

function remoteWithAlpha() {
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-remote-"));
  const run = (...args) => hermeticGit(remoteRoot, ...args);
  fs.mkdirSync(path.join(remoteRoot, "skills/alpha"), { recursive: true });
  fs.writeFileSync(path.join(remoteRoot, "skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: the alpha skill\n---\nbody\n");
  run("init", "-q", "-b", "main");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return `file://${remoteRoot}`;
}

async function installAt(level, { cwd, config = {}, gitignore } = {}) {
  const { runSkills } = await import("../src/skills/cli.js");
  const dir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-proj-"));
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
  const out = [];
  const env = { ...process.env, XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-xdg-")), XDG_CACHE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-cache-")) };
  const code = runSkills(["install", remoteWithAlpha()], { cwd: dir, config, env, level, install: { allowFile: true }, deps: { execFn: () => "" }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } });
  return { code, text: out.join(""), dir, env };
}

test("skills install --user writes the user store and lock and keeps .gitignore out of it", async () => {
  const { code, env, dir } = await installAt("user");
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(env.XDG_CONFIG_HOME, "toolgate/skills/alpha/SKILL.md")));
  assert.ok(fs.existsSync(path.join(env.XDG_CONFIG_HOME, "toolgate/skills.lock.json")));
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
});

test("skills install --local appends to an existing .gitignore once, with or without a final newline", async () => {
  for (const initial of ["node_modules", "node_modules\n"]) {
    const first = await installAt("local", { gitignore: initial });
    const file = path.join(first.dir, ".gitignore");
    const once = fs.readFileSync(file, "utf8");
    assert.equal(once.split("\n").filter((l) => l === ".toolgate/skills.local/").length, 1);
    assert.ok(once.startsWith("node_modules\n"));
    await installAt("local", { cwd: first.dir });
    assert.equal(fs.readFileSync(file, "utf8"), once, "a second install changes nothing");
  }
});

test("skills install says so when the project switched the level off", async () => {
  const { text } = await installAt("user", { config: { skills: { disabledLevels: ["user"] } } });
  assert.match(text, /switched the user level off/);
});

test("--user and --local together are refused", async () => {
  const err = [];
  const code = await run(["skills", "status", "--user", "--local"], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-both-")), stdout: { write() {} }, stderr: { write: (s) => err.push(s) }, deps: { env: { ...process.env } } });
  assert.equal(code, 1);
  assert.match(err.join(""), /choose one of --user and --local/);
});

test("skills install --local: when every skill is skipped nothing is added to .gitignore", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-noignore-"));
  fs.mkdirSync(path.join(cwd, ".toolgate/skills.local/alpha"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate/skills.local/alpha/SKILL.md"), "---\nname: alpha\ndescription: mine\n---\nmine\n");
  const { code, text } = await installAt("local", { cwd });
  assert.equal(code, 1, text);
  assert.match(text, /skipped alpha/);
  assert.equal(fs.existsSync(path.join(cwd, ".gitignore")), false);
});

test("skills update: --source without a value is a usage error; a dry run does not reindex", async () => {
  const { runSkills } = await import("../src/skills/cli.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-upd-cli-"));
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  assert.equal(runSkills(["update"], { cwd, config: {}, sourceFilter: "", ...io }), 1);
  assert.match(out.join(""), /--source needs a value/);
  const calls = [];
  const code = runSkills(["update"], { cwd, config: {}, dryRun: true, deps: { execFn: (...args) => (calls.push(args), "") }, ...io });
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
});

test("skills update --user: the user store is found through the CLI instead of failing on the config directory", async () => {
  const { runSkills } = await import("../src/skills/cli.js");
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  const env = { ...process.env, XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-xdg-")) };
  const code = runSkills(["update"], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-upd-user-")), config: {}, level: "user", dryRun: true, env, ...io });
  assert.equal(code, 0, out.join(""));
  assert.match(out.join(""), /nothing installed at the user level/);
});

test("skills remove through runSkills: --json, exit code and a reindex only when something went", async () => {
  const { runSkills } = await import("../src/skills/cli.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-rm-cli-"));
  const out = [];
  const calls = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) }, deps: { execFn: (...args) => (calls.push(args), "") } };
  assert.equal(runSkills(["remove", "nope"], { cwd, config: {}, ...io }), 1);
  assert.deepEqual(calls, [], "nothing removed, nothing reindexed");
  out.length = 0;
  assert.equal(runSkills(["remove", "nope"], { cwd, config: {}, json: true, ...io }), 1);
  assert.equal(JSON.parse(out.join("")).refused[0].name, "nope");
});

test("skills remove --user: the user store is found through the CLI and a skill that is not there is refused for that level", async () => {
  const { runSkills } = await import("../src/skills/cli.js");
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  const env = { ...process.env, XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-xdg-")) };
  const code = runSkills(["remove", "nope"], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-rm-user-")), config: {}, level: "user", env, ...io });
  assert.equal(code, 1);
  assert.doesNotMatch(out.join(""), /not known/);
  assert.match(out.join(""), /not installed by toolgate at the user level/);
});

test("skills remove --json: stdout is the JSON result alone, the reindex note goes to stderr", async () => {
  const { runSkills } = await import("../src/skills/cli.js");
  const { hashDir, writeLock } = await import("../src/skills/install.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-rm-json-"));
  const dir = path.join(cwd, ".toolgate/skills/alpha");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: alpha\ndescription: the alpha skill\n---\nbody\n");
  writeLock(path.join(cwd, ".toolgate/skills.lock.json"), { sources: {}, skills: { alpha: { source: "github:o/r", commit: "a".repeat(40), path: "skills/alpha", hash: hashDir(dir) } } });
  const out = [];
  const err = [];
  const code = runSkills(["remove", "alpha"], { cwd, config: {}, json: true, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, deps: { execFn: () => "" } });
  assert.equal(code, 0, err.join(""));
  assert.deepEqual(JSON.parse(out.join("")).removed, ["alpha"]);
  assert.match(err.join(""), /skills index has|not indexed yet/);
});

function remoteWithMcps() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-remote-"));
  const git = (...args) => hermeticGit(root, ...args);
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(root, "skills", "needs-server"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "needs-server", "SKILL.md"), "---\nname: needs-server\ndescription: a skill that needs a server\nmcps: [chrome-devtools]\n---\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return `file://${root}`;
}
test("skills install --catalog builds the catalog entry of each server the installed skills require, and only then", async () => {
  const built = [];
  const buildFn = async ({ serverFilter }) => (built.push(serverFilter), { rows: [], code: 0 });
  const source = remoteWithMcps();
  const without = installDeps(tmp(), {});
  without.deps.catalog = { buildFn };
  assert.equal(await run(["skills", "install", source], without.deps), 0);
  assert.deepEqual(built, [], "without --catalog nothing is started");
  const withFlag = installDeps(tmp(), {});
  withFlag.deps.catalog = { buildFn };
  assert.equal(await run(["skills", "install", source, "--catalog"], withFlag.deps), 0);
  assert.deepEqual(built, ["chrome-devtools"]);
});
function remoteWithoutMcps() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-remote-"));
  const git = (...args) => hermeticGit(root, ...args);
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(root, "skills", "plain"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "plain", "SKILL.md"), "---\nname: plain\ndescription: a skill with no server of its own\n---\n");
  fs.mkdirSync(path.join(root, "skills", "needs-server"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "needs-server", "SKILL.md"), "---\nname: needs-server\ndescription: a skill that needs a server\nmcps: [chrome-devtools]\n---\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return `file://${root}`;
}
const builtBy = async (config, args = []) => {
  const built = [];
  const t = installDeps(tmp(), config);
  t.deps.catalog = { buildFn: async ({ serverFilter }) => (built.push(serverFilter), { rows: [], code: 0 }) };
  const code = await run(["skills", "install", remoteWithoutMcps(), "--catalog", ...args], t.deps);
  return { built, code };
};
test("skills install --catalog also builds the servers an override gives an installed skill, once, and nothing for a skill that was not installed", async () => {
  const { built, code } = await builtBy({ skills: { overrides: [{ skill: "plain", mcps: ["srv"] }, { skill: "not-installed", mcps: ["other"] }] } }, ["plain"]);
  assert.equal(code, 0);
  assert.deepEqual(built, ["srv"], "the skill has no server of its own: the override's is built; the override of a skill that was not installed builds nothing");
  const both = await builtBy({ skills: { overrides: [{ skill: "needs-server", mcps: ["chrome-devtools", "extra"] }, { skill: "plain", mcps: ["extra"] }] } });
  assert.deepEqual([...both.built].sort(), ["chrome-devtools", "extra"], "the same server from the skill and from overrides is built once");
});
test("skills install --catalog reads the effective override: a later layer wins key by key; one without mcps adds nothing", async () => {
  const merged = await builtBy({ skills: { overrides: [{ skill: "plain", mcps: ["from-user"] }, { skill: "plain", mcps: ["from-project"] }] } }, ["plain"]);
  assert.deepEqual(merged.built, ["from-project"], "the override of the higher layer replaces the lower one's mcps");
  const tagsOnly = await builtBy({ skills: { overrides: [{ skill: "plain", mcps: ["srv"] }, { skill: "plain", tags: ["x"] }] } }, ["plain"]);
  assert.deepEqual(tagsOnly.built, ["srv"], "an override of other keys keeps the mcps of the lower one");
  const none = await builtBy({ skills: { overrides: [{ skill: "plain", tags: ["x"] }] } }, ["plain"]);
  assert.deepEqual(none.built, []);
  const odd = await builtBy({ skills: { overrides: [null, { skill: "plain", mcps: "not-a-list" }, { skill: "plain", mcps: [3, "ok"] }] } }, ["plain"]);
  assert.deepEqual(odd.built, ["ok"]);
});
test("skills install without --catalog starts nothing, whatever the overrides say", async () => {
  const built = [];
  const t = installDeps(tmp(), { skills: { overrides: [{ skill: "plain", mcps: ["srv"] }] } });
  t.deps.catalog = { buildFn: async ({ serverFilter }) => (built.push(serverFilter), { rows: [], code: 0 }) };
  assert.equal(await run(["skills", "install", remoteWithoutMcps(), "plain"], t.deps), 0);
  assert.deepEqual(built, []);
});
test("skills install --catalog on a skill that is already installed and unchanged still builds the server of its override", async () => {
  const built = [];
  const cwd = tmp();
  const source = remoteWithoutMcps();
  const config = { skills: { overrides: [{ skill: "plain", mcps: ["srv"] }] } };
  const first = installDeps(cwd, config);
  first.deps.catalog = { buildFn: async ({ serverFilter }) => (built.push(serverFilter), { rows: [], code: 0 }) };
  assert.equal(await run(["skills", "install", source, "plain", "--catalog"], first.deps), 0);
  const again = installDeps(cwd, config);
  again.deps.catalog = first.deps.catalog;
  assert.equal(await run(["skills", "install", source, "plain", "--catalog"], again.deps), 0);
  assert.match(again.out(), /unchanged 1/);
  assert.deepEqual(built, ["srv", "srv"]);
});
