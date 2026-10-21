import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../src/init.js";
import { run } from "../src/cli.js";
import { appendIgnored } from "../src/gitignore.js";

const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-initdry-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// `installed` are the binaries of this fake machine; qmd is there when listed.
function setup(installed = []) {
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  const calls = [];
  const daemon = [];
  const out = [];
  const execFn = (bin, args = []) => {
    calls.push([bin, ...args].join(" "));
    if (installed.includes(bin)) return "";
    if (bin === "npm") return "";
    throw new Error(`${bin}: not found`);
  };
  const init = (extra = {}) =>
    runInit({
      cwd,
      env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") },
      stdout: { write: (s) => out.push(s) },
      execFn,
      daemon: { ensure: async (options) => (daemon.push(options), { running: true, started: true, url: "http://localhost:8181/mcp" }) },
      skillsDeps: { execFn },
      interactive: false,
      nodeMajor: 24,
      targets: ["claudecode"],
      ...extra,
    }).then((code) => ({ code, text: out.join("") }));
  return { cwd, init, calls, daemon, out };
}
const tree = (cwd) => {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(cwd, full)] = fs.readFileSync(full, "utf8");
      if (entry.isDirectory() && fs.readdirSync(full).length === 0) files[`${path.relative(cwd, full)}/`] = "";
    }
  };
  walk(cwd);
  return files;
};
// The lines of a real run that a dry run says with "would".
const past = (line) =>
  line
    .replace(/^would create/, "created")
    .replace(/^would update/, "updated")
    .replace(/^would set/, "set")
    .replace(/^would install/, "installed")
    .replace(/^would index/, "indexed")
    .replace(/^would keep (.*) \(exists and differs\)/, "kept $1 (already exists and differs)")
    .replace(/^would keep/, "kept");
const linesOf = (text) => text.split("\n").filter((line) => /^ {2}\S/.test(line) && !/^ {2}- /.test(line)).map((line) => line.trim());

test("a dry run writes nothing: no file, no folder, no daemon, no install, no network, and says so", async () => {
  const t = setup(["qmd"]);
  const before = tree(t.cwd);
  const { code, text } = await t.init({ dryRun: true, installQmd: true, agent: "claude-code", targets: ["claudecode", "codexcli"] });
  assert.equal(code, 0);
  assert.deepEqual(tree(t.cwd), before, "the tree is exactly as it was");
  assert.equal(fs.existsSync(path.join(t.cwd, ".toolgate")), false);
  assert.deepEqual(t.daemon, []);
  assert.equal(t.calls.some((call) => call.startsWith("npm ")), false);
  assert.equal(t.calls.some((call) => call.startsWith("qmd collection")), false);
  assert.match(text, /^Dry run: nothing is written, installed or started\./);
  assert.match(text, /would create \.toolgate\/config\.json/);
  assert.match(text, /would create \.rulesync\/rules\/toolgate-router\.md/);
  assert.match(text, /would create rulesync\.jsonc \(targets: claudecode, codexcli\)/);
  assert.match(text, /would create \.gitignore \(\+\d+\)/);
  assert.match(text, /would set defaultAgent claude-code in the local config \(\.toolgate\/config\.local\.json\)/);
  assert.match(text, /would start the qmd daemon/);
});

test("a dry run says the same as the real run with 'would', for every file it would touch", async () => {
  for (const extra of [{}, { agent: "claude-code", targets: ["claudecode", "codexcli"] }, { backend: "regex" }]) {
    const dry = setup(["qmd"]);
    const real = setup(["qmd"]);
    const wouldSay = linesOf((await dry.init({ ...extra, dryRun: true })).text).filter((line) => /^would (create|update|set)/.test(line));
    const did = linesOf((await real.init(extra)).text).filter((line) => /^(created|updated|set) /.test(line));
    assert.ok(wouldSay.length >= 4, `the dry run lists the files: ${wouldSay.join(" | ")}`);
    assert.deepEqual(wouldSay.map(past), did, JSON.stringify(extra));
  }
});

const skill = (cwd, name) => {
  fs.mkdirSync(path.join(cwd, ".toolgate/skills", name), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody\n`);
};

test("a file that exists and differs is 'would keep', as the real run says 'kept'; the pair is the same line", async () => {
  const dry = setup();
  const real = setup();
  for (const t of [dry, real]) {
    fs.mkdirSync(path.join(t.cwd, ".rulesync/rules"), { recursive: true });
    fs.writeFileSync(path.join(t.cwd, ".rulesync/rules/toolgate-router.md"), "my own rule\n");
    fs.writeFileSync(path.join(t.cwd, "rulesync.jsonc"), '{ "targets": ["claudecode"], }\n');
  }
  const wouldSay = linesOf((await dry.init({ dryRun: true })).text).filter((line) => /^would keep/.test(line));
  const did = linesOf((await real.init()).text).filter((line) => /^kept /.test(line));
  assert.deepEqual(wouldSay, ["would keep .rulesync/rules/toolgate-router.md (exists and differs)", "would keep rulesync.jsonc (targets: claudecode)"]);
  assert.deepEqual(wouldSay.map(past), did);
  assert.equal(fs.readFileSync(path.join(dry.cwd, ".rulesync/rules/toolgate-router.md"), "utf8"), "my own rule\n");
});

test("with skills to index the dry run counts them the way the index does: 'would index N skills', as the real run says 'indexed N skills'", async () => {
  const dry = setup(["qmd"]);
  const real = setup(["qmd"]);
  for (const t of [dry, real]) {
    skill(t.cwd, "one");
    skill(t.cwd, "two");
  }
  const wouldSay = linesOf((await dry.init({ dryRun: true })).text).filter((line) => /^would index/.test(line));
  assert.deepEqual(wouldSay, ["would index 2 skills"]);
  const did = linesOf((await real.init()).text).filter((line) => /^indexed/.test(line));
  assert.deepEqual(wouldSay.map(past), did);
  // Commands are counted the way the index counts them: "N skills and M commands".
  const withCommand = setup(["qmd"]);
  const realWithCommand = setup(["qmd"]);
  for (const t of [withCommand, realWithCommand]) {
    skill(t.cwd, "one");
    fs.mkdirSync(path.join(t.cwd, ".toolgate/commands"), { recursive: true });
    fs.writeFileSync(path.join(t.cwd, ".toolgate/commands/ship.md"), "---\ndescription: a command\n---\nDo it.\n");
  }
  const withCommandSays = linesOf((await withCommand.init({ dryRun: true })).text).filter((line) => /^would index/.test(line));
  assert.deepEqual(withCommandSays, ["would index 1 skill and 1 command"]);
  assert.deepEqual(withCommandSays.map(past), linesOf((await realWithCommand.init()).text).filter((line) => /^indexed/.test(line)));
  // One skill is singular, and a skill that cannot be read is said, not thrown.
  const one = setup(["qmd"]);
  skill(one.cwd, "only");
  assert.match((await one.init({ dryRun: true })).text, /would index 1 skill\n/);
  const broken = setup(["qmd"]);
  // two folders with one name is a problem of the source itself, which still stops the index (a single bad file is skipped)
  for (const folder of ["one", "two"]) {
    fs.mkdirSync(path.join(broken.cwd, `.toolgate/skills/${folder}`), { recursive: true });
    fs.writeFileSync(path.join(broken.cwd, `.toolgate/skills/${folder}/SKILL.md`), "---\nname: dup\ndescription: d\n---\n");
  }
  const unreadable = await broken.init({ dryRun: true });
  assert.equal(unreadable.code, 0);
  assert.match(unreadable.text, /would try to index the skills, which cannot be read yet \(/);
});

test("on a project that is already set up a dry run reports it as unchanged and still changes nothing", async () => {
  const t = setup(["qmd"]);
  await t.init();
  const before = tree(t.cwd);
  const { text } = await t.init({ dryRun: true });
  assert.deepEqual(tree(t.cwd), before);
  assert.match(text, /unchanged \.toolgate\/config\.json/);
  assert.match(text, /unchanged \.rulesync\/rules\/toolgate-router\.md/);
  assert.match(text, /\.gitignore already lists/);
  assert.doesNotMatch(text, /would create/);
});

test("a dry run installs no recommended skill and no qmd, and says what it would", async () => {
  const t = setup();
  const { code, text } = await t.init({ dryRun: true, installRecommended: ["addyosmani/agent-skills"], installQmd: true, install: { allowFile: true } });
  assert.equal(code, 0);
  assert.match(text, /would install recommended:addyosmani\/agent-skills/);
  assert.match(text, /would install qmd \(npm install -g @tobilu\/qmd\)/);
  assert.equal(fs.existsSync(path.join(t.cwd, ".toolgate")), false);
  assert.equal(t.calls.some((call) => call.startsWith("npm ")), false);
});

test("a dry run asks no question, even in a terminal", async () => {
  const t = setup();
  const asked = [];
  const { code, text } = await t.init({ dryRun: true, interactive: true, ask: async (q) => (asked.push(q), "y") });
  assert.equal(code, 0);
  assert.deepEqual(asked, []);
  assert.match(text, /no agent was found installed/);
});

test("a dry run fails like init does on bad input, and still writes nothing", async () => {
  const t = setup();
  const { code, text } = await t.init({ dryRun: true, agent: "emacs" });
  assert.equal(code, 1);
  assert.match(text, /unknown agent "emacs"/);
  assert.deepEqual(fs.readdirSync(t.cwd), [".git"]);
});

test("the dry run does not depend on the agents installed here: same lines with 0, 1 or 3 agents (minus the informational section)", async () => {
  const shot = async (installed) => {
    const t = setup(installed);
    const { text } = await t.init({ dryRun: true, targets: ["claudecode"], agent: "claude-code" });
    // The /toolgate command is about the agents installed here, so its lines differ by design.
    return text.split(t.cwd).join("<project>").replace(/\nFound on this machine[\s\S]*?(?=\n\S|$)/, "").replace(/^ {2}would write .*\n/gm, "").replace(/^ {2}\/toolgate command: .*\n/gm, "").replace(/^ {2}- (after init writes it, restart|codex reads).*\n/gm, "");
  };
  const none = await shot(["qmd"]);
  assert.equal(await shot(["qmd", "codex"]), none);
  assert.equal(await shot(["qmd", "claude", "codex", "opencode"]), none);
});

test("toolgate init --dry-run from the command line writes nothing and does not restart the daemon", async () => {
  const t = setup();
  const out = [];
  const status = [];
  const code = await run(["init", "--dry-run"], {
    cwd: t.cwd,
    env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache") },
    stdout: { write: (s) => out.push(s) },
    stderr: { write() {} },
    daemon: { status: async () => (status.push("status"), { running: true }), ensure: async () => ({ running: true }) },
    init: { execFn: () => { throw new Error("none"); }, interactive: false },
  });
  assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(t.cwd), [".git"]);
  assert.deepEqual(status, [], "no daemon refresh after a dry run");
  assert.match(out.join(""), /Dry run: nothing is written/);
});

test("appendIgnored with dryRun counts what it would add and writes nothing", () => {
  const cwd = tmp("ignore");
  assert.deepEqual(appendIgnored(cwd, ["a", "b"], { header: "# x", dryRun: true }), { created: true, added: 2 });
  assert.equal(fs.existsSync(path.join(cwd, ".gitignore")), false);
  fs.writeFileSync(path.join(cwd, ".gitignore"), "a\n");
  assert.deepEqual(appendIgnored(cwd, ["a", "b"], { header: "# x", dryRun: true }), { created: false, added: 1 });
  assert.equal(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"), "a\n");
});
