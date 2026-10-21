import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detect, runInit } from "../src/init.js";
import { tierZeroRegistry } from "./support/tierZeroRegistry.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");

const project = ({ git = true } = {}) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-init-"));
  if (git) fs.mkdirSync(path.join(cwd, ".git"));
  return cwd;
};
const read = (cwd, file) => fs.readFileSync(path.join(cwd, file), "utf8");
const has = (cwd, file) => fs.existsSync(path.join(cwd, file));

// A qmd that is installed and remembers its collections like the real one.
function qmdInstalled() {
  const calls = [];
  let corpus = null;
  return {
    calls,
    execFn: (bin, args) => {
      calls.push([bin, ...args].join(" "));
      if (args[1] === "add") corpus = args[2];
      if (args[1] !== "show") return "";
      if (corpus === null) throw new Error("Collection not found");
      return `Collection: ${args[2]}\n  Path:     ${corpus}\n`;
    },
  };
}
const noQmd = () => {
  throw new Error("spawn qmd ENOENT");
};
const daemonUp = (seen = []) => ({
  ensure: async (opts) => (seen.push(opts), { running: true, started: true, url: "http://localhost:8181/mcp" }),
});

function setup(cwd, { execFn, daemon = daemonUp(), env = {}, registry } = {}) {
  const out = [];
  return {
    out: () => out.join(""),
    run: () =>
      runInit({
        // never a real listener in 8181-8281: the probe of the port is the test's own
        probePort: async () => true,
        cwd,
        env: { TOOLGATE_DEFAULTS: path.join(cwd, "no-user.json"), ...env },
        stdout: { write: (s) => out.push(s) },
        execFn,
        registry,
        daemon,
        skillsDeps: { execFn },
      }),
  };
}

test("detect: reports git, rulesync, config and skill folders without asking", () => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, ".rulesync", "skills"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), "{}");
  assert.deepEqual(detect({ cwd, execFn: () => "" }), {
    git: true,
    qmd: true,
    rulesync: true,
    config: true,
    skillDirs: [path.join(".rulesync", "skills")],
  });
  assert.deepEqual(detect({ cwd: project({ git: false }), execFn: noQmd }), {
    git: false,
    qmd: false,
    rulesync: false,
    config: false,
    skillDirs: [],
  });
});

test("init in an empty project: config, Step 0 rule, .gitignore and daemon, and it says what is left", async () => {
  const cwd = project();
  const qmd = qmdInstalled();
  const seen = [];
  const t = setup(cwd, { execFn: qmd.execFn, daemon: daemonUp(seen) });
  assert.equal(await t.run(), 0);

  assert.deepEqual(JSON.parse(read(cwd, ".toolgate/config.json")), { router: { backend: "qmd" } });
  const rule = read(cwd, ".rulesync/rules/toolgate-router.md");
  assert.match(rule, /^---\ntargets: \["\*"\]\n[\s\S]*# Toolgate Step 0 router/);
  assert.ok(!has(cwd, ".claude/rules"), "rulesync writes the agents' rule files, init does not");
  assert.deepEqual(JSON.parse(read(cwd, "rulesync.jsonc")), { $schema: "https://github.com/dyoshikawa/rulesync/releases/latest/download/config-schema.json", targets: ["claudecode", "codexcli", "opencode", "antigravity-cli"], features: ["rules"] });
  const ignore = read(cwd, ".gitignore");
  for (const line of [".toolgate/config.local.json", ".toolgate/state.json", ".toolgate/skills-index/", ".qmd/"]) {
    assert.match(ignore, new RegExp(`^${line.replace(/[./]/g, "\\$&")}$`, "m"));
  }
  assert.deepEqual(seen, [{ port: 8181, qmdBin: "qmd" }]);
  assert.match(t.out(), /created \.toolgate\/config\.json/);
  assert.match(t.out(), /qmd daemon started on http:\/\/localhost:8181\/mcp/);
  assert.match(t.out(), /no skills yet: add them under \.toolgate\/skills/);
  assert.match(t.out(), /toolgate route --prompt/);
  assert.ok(!qmd.calls.some((c) => c.includes("collection add")), "no skills, so nothing to index");
});

test("init indexes the skills it finds, and reports it", async () => {
  const cwd = project();
  fs.cpSync(FIXTURES, path.join(cwd, ".toolgate", "skills"), { recursive: true });
  const qmd = qmdInstalled();
  const t = setup(cwd, { execFn: qmd.execFn });
  assert.equal(await t.run(), 0);
  assert.match(t.out(), /indexed 2 skills/);
  assert.ok(qmd.calls.some((c) => c.includes("collection add")));
  assert.ok(!/no skills yet/.test(t.out()));
});

test("init is safe to re-run: nothing it wrote before is overwritten, and a changed file is kept", async () => {
  const cwd = project();
  const qmd = qmdInstalled();
  await setup(cwd, { execFn: qmd.execFn }).run();

  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), '{ "router": { "backend": "regex" }, "mine": true }\n');
  fs.appendFileSync(path.join(cwd, ".rulesync", "rules", "toolgate-router.md"), "\nmy own note\n");
  const gitignore = read(cwd, ".gitignore");

  const again = setup(cwd, { execFn: qmd.execFn });
  assert.equal(await again.run(), 0);
  assert.match(read(cwd, ".toolgate/config.json"), /"mine": true/);
  assert.match(read(cwd, ".rulesync/rules/toolgate-router.md"), /my own note/);
  assert.equal(read(cwd, ".gitignore"), gitignore);
  assert.match(again.out(), /kept \.toolgate\/config\.json \(already exists and differs\)/);
  assert.match(again.out(), /kept \.rulesync\/rules\/toolgate-router\.md/);
  assert.match(again.out(), /kept rulesync\.jsonc \(targets: claudecode, codexcli, opencode, antigravity-cli\)/);
  assert.match(again.out(), /\.gitignore already lists/);

  const third = setup(cwd, { execFn: qmd.execFn });
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), '{\n  "router": {\n    "backend": "qmd"\n  }\n}\n');
  fs.writeFileSync(path.join(cwd, ".rulesync", "rules", "toolgate-router.md"), fs.readFileSync(path.join(ROOT, ".rulesync/rules/toolgate-router.md")));
  await third.run();
  assert.match(third.out(), /unchanged \.toolgate\/config\.json/);
  assert.match(third.out(), /unchanged \.rulesync\/rules\/toolgate-router\.md/);
});

test("init appends to an existing .gitignore without touching what is there", async () => {
  const cwd = project();
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n.qmd/");
  await setup(cwd, { execFn: qmdInstalled().execFn }).run();
  const lines = read(cwd, ".gitignore").split("\n");
  assert.equal(lines[0], "node_modules/");
  assert.equal(lines.filter((l) => l === ".qmd/").length, 1, ".qmd/ is not duplicated");
  assert.ok(lines.includes("# toolgate") && lines.includes(".toolgate/skills-index/"));
});

test("without qmd the qmd backend is still chosen, nothing is started, and it says how to get qmd", async () => {
  const cwd = project({ git: false });
  const seen = [];
  const t = setup(cwd, { execFn: noQmd, daemon: daemonUp(seen) });
  assert.equal(await t.run(), 0);
  assert.deepEqual(JSON.parse(read(cwd, ".toolgate/config.json")), { router: { backend: "qmd" } }, "the backend is a choice of the flags, not of this machine");
  assert.deepEqual(seen, []);
  assert.match(t.out(), /qmd was not found.*keywords only.*npm install -g @tobilu\/qmd/);
  assert.match(t.out(), /not a git repository/);
  assert.ok(!/successfully/i.test(t.out()));
});

test("a daemon that does not start is reported without failing the init", async () => {
  const cwd = project();
  const daemon = { ensure: async () => ({ running: false, reason: "qmd mcp did not answer" }) };
  const t = setup(cwd, { execFn: qmdInstalled().execFn, daemon });
  assert.equal(await t.run(), 0);
  assert.match(t.out(), /qmd daemon not running \(qmd mcp did not answer\)/);
});

test("in a project that uses rulesync the rule goes to .rulesync/rules with its header", async () => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, ".rulesync"));
  const t = setup(cwd, { execFn: qmdInstalled().execFn });
  await t.run();
  const rule = read(cwd, ".rulesync/rules/toolgate-router.md");
  assert.match(rule, /^---\ntargets: \["\*"\]\n/);
  assert.ok(!rule.includes("globs"));
  assert.ok(!has(cwd, ".claude/rules/toolgate-router.md"), "generated files are left to rulesync");
  assert.match(t.out(), /run `rulesync generate`/);
});

test("the repo's own rulesync rule is the shipped template plus the rulesync header", () => {
  const template = fs.readFileSync(path.join(ROOT, "packages/toolgate/templates/step0-rule.md"), "utf8");
  const own = fs.readFileSync(path.join(ROOT, ".rulesync/rules/toolgate-router.md"), "utf8");
  assert.ok(own.endsWith(template), "keep .rulesync/rules/toolgate-router.md in sync with templates/step0-rule.md");
});

test("the rulesync reminder only appears when the rule was just written", async () => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, ".rulesync"));
  const qmd = qmdInstalled();
  const first = setup(cwd, { execFn: qmd.execFn });
  await first.run();
  assert.match(first.out(), /run `rulesync generate`/);

  const second = setup(cwd, { execFn: qmd.execFn });
  await second.run();
  assert.match(second.out(), /unchanged \.rulesync\/rules\/toolgate-router\.md/);
  assert.ok(!/rulesync generate/.test(second.out()), "an unchanged rule needs no generate");
});

test("with router.qmdUrl null in the user config, init starts no daemon, says so, and still indexes the skills", async () => {
  for (const dryRun of [false, true]) {
    const cwd = project();
    fs.cpSync(FIXTURES, path.join(cwd, ".toolgate", "skills"), { recursive: true });
    const user = path.join(cwd, "user.json");
    fs.writeFileSync(user, JSON.stringify({ router: { qmdUrl: null } }));
    const qmd = qmdInstalled();
    const seen = [];
    const out = [];
    const code = await runInit({ probePort: async () => true, cwd, env: { TOOLGATE_DEFAULTS: user }, stdout: { write: (s) => out.push(s) }, execFn: qmd.execFn, daemon: daemonUp(seen), skillsDeps: { execFn: qmd.execFn }, dryRun });
    assert.equal(code, 0);
    assert.deepEqual(seen, [], "no daemon");
    const text = out.join("");
    assert.match(text, dryRun ? /would not start the qmd daemon: router\.qmdUrl is null, so routing uses the qmd CLI/ : /qmd daemon not started: router\.qmdUrl is null, so routing uses the qmd CLI/);
    assert.match(text, dryRun ? /would index 2 skills/ : /indexed 2 skills/);
    assert.equal(qmd.calls.some((c) => c.includes("collection add")), !dryRun);
  }
});
test("a single indexed skill is reported in the singular", async () => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, ".toolgate", "skills", "only"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate", "skills", "only", "SKILL.md"), "---\nname: only\ndescription: the one\n---\n");
  const t = setup(cwd, { execFn: qmdInstalled().execFn });
  await t.run();
  assert.match(t.out(), /indexed 1 skill(?!s)/);
});

test("init prints the tier each detected agent reaches and what would raise it", async () => {
  const cwd = project({});
  const execFn = (bin) => {
    if (bin === "claude" || bin === "codex") return "";
    throw new Error("ENOENT");
  };
  const t = setup(cwd, { execFn });
  await t.run();
  assert.match(t.out(), /claude-code: tier 4 \(mid-session reveal\)/);
  assert.match(t.out(), /codex: tier 2 \(servers on demand at launch\); to raise it: unknown whether the agent can resume the last session/);
  assert.doesNotMatch(t.out(), /opencode:/);
  assert.match(t.out(), /Found on this machine \(informational, only the default agent is configured\):[\s\S]*claude-code: tier 4/);
});

test("init activates the agents installed here, and none when none is installed or has a file; it never writes their files", async () => {
  const runWith = async (installed) => {
    const cwd = project({});
    const execFn = (bin) => { if (installed.includes(bin)) return ""; throw new Error("ENOENT"); };
    const t = setup(cwd, { execFn });
    await t.run();
    return { cwd, out: t.out() };
  };
  const none = await runWith([]);
  assert.ok(!has(none.cwd, "rulesync.jsonc") && !has(none.cwd, ".rulesync/rules/overview.md"), "rulesync is not activated");
  assert.ok(has(none.cwd, ".rulesync/rules/toolgate-router.md"), "the router rule is always written, so a later generate finds it");
  assert.match(none.out, /no agent was found or chosen[^\n]*toolgate init --targets claudecode/);
  const some = await runWith(["codex", "opencode"]);
  assert.deepEqual(JSON.parse(read(some.cwd, "rulesync.jsonc")).targets, ["codexcli", "opencode"]);
  for (const ran of [none, some]) assert.ok(!has(ran.cwd, "AGENTS.md") && !has(ran.cwd, ".claude") && !has(ran.cwd, ".agents"));
});

test("init does not write the toolgate header of .gitignore twice, whether it has entries or none", async () => {
  const { appendIgnored } = await import("../src/gitignore.js");
  const cwd = project();
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n\n# toolgate\n");
  assert.deepEqual(appendIgnored(cwd, [".toolgate/state.json", ".qmd/"], { header: "# toolgate" }), { created: false, added: 2 });
  assert.equal(read(cwd, ".gitignore"), "node_modules/\n\n# toolgate\n.toolgate/state.json\n.qmd/\n");
  // A header that has entries: the missing ones go under it, before what follows.
  fs.writeFileSync(path.join(cwd, ".gitignore"), "# toolgate\n.qmd/\n\ndist/\n");
  appendIgnored(cwd, [".qmd/", ".toolgate/state.json"], { header: "# toolgate" });
  assert.equal(read(cwd, ".gitignore"), "# toolgate\n.qmd/\n.toolgate/state.json\n\ndist/\n");
  assert.equal(read(cwd, ".gitignore").split("# toolgate").length - 1, 1);
  // And through init: a .gitignore with only the header gets exactly one.
  const viaInit = project();
  fs.writeFileSync(path.join(viaInit, ".gitignore"), "# toolgate\n");
  await runInit({ probePort: async () => true, cwd: viaInit, env: { TOOLGATE_DEFAULTS: path.join(viaInit, "none.json") }, stdout: { write() {} }, execFn: () => { throw new Error("no"); }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, registry: tierZeroRegistry, interactive: false });
  assert.equal(read(viaInit, ".gitignore").split("# toolgate").length - 1, 1);
  assert.match(read(viaInit, ".gitignore"), /\.toolgate\/state\.json/);
});
test("the Step 0 rule has an item for commands, and init says when a kept rule predates it", async () => {
  const template = fs.readFileSync(path.join(ROOT, "packages/toolgate/templates/step0-rule.md"), "utf8");
  assert.match(template, /^3\. `commands` non-empty and the user named a command \(typed `\/<name>`\) or the task is exactly that command: read the file at `commands\[0\]\.path`/m);
  assert.match(template, /independent of item 2: one task can load a skill and a command/);
  assert.doesNotMatch(template, /no skill matched|skill wins/);
  assert.match(template, /^4\. `subagents` non-empty: a subagent is a specialist that exists in the agent only once it is registered, and none is registered in this session\./m);
  assert.match(template, /never act as if it had been invoked\. It is independent of items 2 and 3\./);
  assert.match(template, /^5\. `servers` non-empty/m);
  assert.match(template, /steps 1-5/);
  const cwd = project();
  const qmd = qmdInstalled();
  await setup(cwd, { execFn: qmd.execFn }).run();
  const current = setup(cwd, { execFn: qmd.execFn });
  await current.run();
  assert.doesNotMatch(current.out(), /predates commands/);
  const file = path.join(cwd, ".rulesync", "rules", "toolgate-router.md");
  fs.writeFileSync(file, template.replace(/^3\. `commands` non-empty.*\n/m, ""));
  const old = setup(cwd, { execFn: qmd.execFn });
  await old.run();
  assert.match(old.out(), /\.rulesync\/rules\/toolgate-router\.md predates commands: toolgate does not overwrite it/);
  assert.ok(!read(cwd, ".rulesync/rules/toolgate-router.md").includes("`commands` non-empty"), "the old rule is kept as it was");
});
test("the Step 0 rule reads long files in windows and falls back to _index.md; an older rule is told so, not rewritten (#135)", async () => {
  const template = fs.readFileSync(path.join(import.meta.dirname, "..", "templates", "step0-rule.md"), "utf8");
  assert.match(template, /^- Read long files in windows: .*an offset and a line limit.*sed -n '1,120p' <path>/m);
  assert.doesNotMatch(template, /qmd get/, "qmd get only reads documents of its own collections, never the SKILL.md paths `need` returns");
  assert.match(template, /^- If the skill you need is not in the results, run `toolgate skills search "<a few words of the task>"`.*`_index\.md`/m);
  const cwd = project();
  const qmd = qmdInstalled();
  await setup(cwd, { execFn: qmd.execFn }).run();
  const current = setup(cwd, { execFn: qmd.execFn });
  await current.run();
  assert.doesNotMatch(current.out(), /predates the windowed reads/);
  const file = path.join(cwd, ".rulesync", "rules", "toolgate-router.md");
  const old = template.split("\n").filter((line) => !/in windows|toolgate skills search/.test(line)).join("\n");
  fs.writeFileSync(file, old);
  const again = setup(cwd, { execFn: qmd.execFn });
  await again.run();
  assert.match(again.out(), /toolgate-router\.md predates the windowed reads/);
  assert.equal(fs.readFileSync(file, "utf8"), old, "the old rule is kept as it was");
});
test("init writes the /toolgate command for an installed agent, and points to the bridge when it is not written", async () => {
  const cwd = project();
  const qmd = qmdInstalled();
  const execFn = (bin, args) => (bin === "claude" ? "1.0" : qmd.execFn(bin, args));
  const t = setup(cwd, { execFn });
  await t.run();
  assert.ok(has(cwd, ".claude/commands/toolgate.md"), "no terminal: the default is yes");
  assert.match(t.out(), /\/toolgate command: wrote \.claude\/commands\/toolgate\.md/);
  assert.doesNotMatch(t.out(), /run `toolgate commands bridge`/, "the hint is gone when the command was created");
});
