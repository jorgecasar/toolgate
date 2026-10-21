import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { RULESYNC_HEADER, RULESYNC_RULE } from "../src/init.js";
import { BUILTIN_RULE_TEMPLATE } from "../src/ruleText.js";
import { runUpdate } from "../src/update/index.js";
import { KNOWN_RULE_SHA256 } from "../src/update/ruleHistory.js";
import { git as hermeticGit } from "./support/git.js";

const OLD_RULE = `${RULESYNC_HEADER}# An older Step 0 text\n`;
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const CURRENT = RULESYNC_HEADER + fs.readFileSync(BUILTIN_RULE_TEMPLATE, "utf8");

// A project whose rule file holds `text`; `known` makes that text one toolgate has shipped.
function project(text, { git = false, commit = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tg-update-"));
  const cwd = path.join(home, "p");
  fs.mkdirSync(path.join(cwd, ".rulesync", "rules"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".toolgate"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), '{ "router": { "backend": "qmd" } }\n');
  const file = path.join(cwd, RULESYNC_RULE);
  if (text !== undefined) fs.writeFileSync(file, text);
  if (git) {
    const g = (...args) => hermeticGit(cwd, ...args);
    g("init", "-q");
    if (commit) {
      g("add", "-A");
      g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
    }
  }
  return { home, cwd, file, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg"), PATH: process.env.PATH } };
}
async function update(p, options = {}) {
  const out = [];
  const code = await runUpdate({ cwd: p.cwd, env: p.env, stdout: { write: (s) => out.push(s) }, interactive: false, ...options });
  return { code, out: out.join("") };
}
test("the history lists the rule this version writes, so a later change has to add the new hash", () => {
  assert.ok(KNOWN_RULE_SHA256.includes(sha(CURRENT)));
  assert.equal(new Set(KNOWN_RULE_SHA256).size, KNOWN_RULE_SHA256.length);
});

test("toolgate update asks for no agent and no config, and is listed in --help", async () => {
  const p = project(CURRENT);
  const out = [];
  const err = [];
  const code = await run(["update"], { cwd: p.cwd, env: p.env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  assert.equal(code, 0);
  assert.equal(err.join(""), "");
  assert.match(out.join(""), /nothing to update/);
  const help = [];
  await run(["--help"], { cwd: p.cwd, env: p.env, stdout: { write: (s) => help.push(s) }, stderr: { write: () => {} } });
  assert.match(help.join(""), /toolgate update \[--dry-run\]/);
});

test("a rule file that is current is unchanged; a missing one is only reported", async () => {
  const p = project(CURRENT);
  assert.match((await update(p)).out, /rule-file-refresh: current/);
  const q = project(undefined);
  const r = await update(q);
  assert.equal(r.code, 0);
  assert.match(r.out, /absent.*toolgate init/);
  assert.equal(fs.existsSync(q.file), false);
});

test("a rule the user edited stays byte for byte, with a note", async () => {
  const p = project(`${CURRENT}\nmy own line\n`);
  const before = fs.readFileSync(p.file, "utf8");
  const r = await update(p, { yes: true });
  assert.match(r.out, /edited.*yours/);
  assert.equal(fs.readFileSync(p.file, "utf8"), before);
});

const KNOWS_OLD = { knownHashes: [sha(OLD_RULE)] };
test("an old shipped rule is replaced, says what it did, and a second run changes nothing", async () => {
  const p = project(OLD_RULE);
  const config = fs.readFileSync(path.join(p.cwd, ".toolgate", "config.json"), "utf8");
  const first = await update(p, KNOWS_OLD);
  assert.equal(first.code, 0);
  assert.match(first.out, /replaced.*rulesync generate/);
  assert.equal(fs.readFileSync(p.file, "utf8"), CURRENT);
  const second = await update(p, KNOWS_OLD);
  assert.match(second.out, /current/);
  assert.match(second.out, /nothing to update/);
  assert.equal(fs.readFileSync(path.join(p.cwd, ".toolgate", "config.json"), "utf8"), config, "config.json is never touched");
  assert.deepEqual(fs.readdirSync(path.dirname(p.file)), ["toolgate-router.md"], "no temporary file is left");
});

test("--dry-run says what it would replace and writes nothing", async () => {
  const p = project(OLD_RULE);
  const r = await update(p, { ...KNOWS_OLD, dryRun: true });
  assert.match(r.out, /would-replace.*would replace/);
  assert.equal(fs.readFileSync(p.file, "utf8"), OLD_RULE);
  assert.deepEqual(fs.readdirSync(path.dirname(p.file)), ["toolgate-router.md"]);
});

test("a rule that git versions changes only with --yes or an answer in a terminal", async () => {
  const p = project(OLD_RULE, { git: true, commit: true });
  const skipped = await update(p, KNOWS_OLD);
  assert.equal(skipped.code, 0);
  assert.match(skipped.out, /skipped.*versioned by git.*--yes/);
  assert.equal(fs.readFileSync(p.file, "utf8"), OLD_RULE);
  const declined = await update(p, { ...KNOWS_OLD, interactive: true, ask: async () => "n" });
  assert.match(declined.out, /skipped/);
  assert.equal(fs.readFileSync(p.file, "utf8"), OLD_RULE);
  const dry = await update(p, { ...KNOWS_OLD, dryRun: true, yes: true });
  assert.match(dry.out, /git versions this file/);
  assert.equal(fs.readFileSync(p.file, "utf8"), OLD_RULE);
  const asked = [];
  const answered = await update(p, { ...KNOWS_OLD, interactive: true, ask: async (q) => (asked.push(q), "y") });
  assert.match(answered.out, /replaced.*commit the change/);
  assert.equal(asked.length, 1);
  assert.equal(fs.readFileSync(p.file, "utf8"), CURRENT);
  const q = project(OLD_RULE, { git: true, commit: true });
  const yes = await update(q, { ...KNOWS_OLD, yes: true });
  assert.match(yes.out, /replaced/);
  assert.equal(fs.readFileSync(q.file, "utf8"), CURRENT);
});

test("a rule in a repository git does not version is replaced without asking", async () => {
  const p = project(OLD_RULE, { git: true });
  const r = await update(p, { ...KNOWS_OLD, ask: async () => assert.fail("must not ask") });
  assert.match(r.out, /replaced/);
});

test("git that cannot answer counts as versioned: the file is skipped", async () => {
  const p = project(OLD_RULE);
  const r = await update(p, { ...KNOWS_OLD, isTrackedFn: () => true });
  assert.match(r.out, /skipped/);
  assert.equal(fs.readFileSync(p.file, "utf8"), OLD_RULE);
});

test("a rule.template that cannot be read stops update before it writes", async () => {
  const p = project(OLD_RULE);
  fs.mkdirSync(path.join(p.home, "xdg", "toolgate"), { recursive: true });
  fs.writeFileSync(path.join(p.home, "xdg", "toolgate", "config.json"), JSON.stringify({ rule: { template: path.join(p.home, "missing.md") } }));
  const r = await update(p, KNOWS_OLD);
  assert.equal(r.code, 1);
  assert.match(r.out, /Nothing was changed/);
  assert.equal(fs.readFileSync(p.file, "utf8"), OLD_RULE);
});

test("--json prints the result alone", async () => {
  const p = project(OLD_RULE);
  const r = await update(p, { ...KNOWS_OLD, json: true, dryRun: true });
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.migrations[0].status, "would-replace");
});

test("a rule file or folder that is a link is never written through", async () => {
  // The rule file itself is a link to a file outside the project.
  const a = project(undefined);
  const outside = path.join(a.home, "outside.md");
  fs.writeFileSync(outside, OLD_RULE);
  fs.symlinkSync(outside, a.file);
  const r = await update(a, { ...KNOWS_OLD, yes: true });
  assert.match(r.out, /skipped.*link/);
  assert.equal(fs.readFileSync(outside, "utf8"), OLD_RULE);
  assert.equal(fs.lstatSync(a.file).isSymbolicLink(), true);
  // .rulesync is a link to a folder outside the project.
  const b = project(undefined);
  const elsewhere = path.join(b.home, "elsewhere");
  fs.mkdirSync(path.join(elsewhere, "rules"), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "rules", "toolgate-router.md"), OLD_RULE);
  fs.rmSync(path.join(b.cwd, ".rulesync"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(b.cwd, ".rulesync"));
  const s2 = await update(b, { ...KNOWS_OLD, yes: true });
  assert.match(s2.out, /skipped.*link/);
  assert.equal(fs.readFileSync(path.join(elsewhere, "rules", "toolgate-router.md"), "utf8"), OLD_RULE);
  // A link planted where the temporary file would go is not followed either.
  const c = project(OLD_RULE);
  const victim = path.join(c.home, "victim.txt");
  fs.writeFileSync(victim, "keep");
  fs.symlinkSync(victim, `${c.file}.${process.pid}.tmp`);
  const done = await update(c, KNOWS_OLD);
  assert.match(done.out, /replaced/);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.equal(fs.readFileSync(c.file, "utf8"), CURRENT);
});

test("a replaced rule keeps the mode it had", { skip: process.platform === "win32" }, async () => {
  for (const mode of [0o600, 0o644, 0o640]) {
    const p = project(OLD_RULE);
    fs.chmodSync(p.file, mode);
    assert.equal((await update(p, KNOWS_OLD)).code, 0);
    assert.equal(fs.readFileSync(p.file, "utf8"), CURRENT);
    assert.equal(fs.statSync(p.file).mode & 0o777, mode, mode.toString(8));
  }
});

// The proxy's environment names (#19): `toolgate update` renames them in the MCP files of the agent.
const PROXY_OLD = { command: "node", args: ["toolgate-proxy"], env: { UPSTREAM_CMD: "npx", UPSTREAM_ARGS: '["-y","srv"]', ALLOWED_TOOLS: "${TOOLGATE_REPO_TOOLS}", KEEP: "1" } };
const PROXY_NEW = { command: "node", args: ["toolgate-proxy"], env: { TOOLGATE_UPSTREAM_CMD: "npx", TOOLGATE_UPSTREAM_ARGS: '["-y","srv"]', TOOLGATE_ALLOWED_TOOLS: "${TOOLGATE_REPO_TOOLS}", KEEP: "1" } };
const OTHER = { command: "node", args: ["server.js"], env: { UPSTREAM_CMD: "mine", ALLOWED_TOOLS: "x" } };
const mcpText = (servers, indent = 2, tail = "\n") => `${JSON.stringify({ mcpServers: servers }, null, indent)}${tail}`;
const writeMcp = (p, text, mode = 0o644) => {
  const file = path.join(p.cwd, ".mcp.json");
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
};
const modeOf = (file) => fs.statSync(file).mode & 0o777;

test("proxy env: the old keys of a wrapped entry are renamed in place, nothing else changes, and the mode is kept", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD, plain: OTHER }), 0o600);
  const r = await update(p, { homedir: p.home });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(file, "utf8"), mcpText({ repo: PROXY_NEW, plain: OTHER }), "only the three keys changed, in their places; the other server is as it was");
  assert.equal(modeOf(file), 0o600);
  assert.match(r.out, /mcp-proxy-env:\.mcp\.json: replaced - rename UPSTREAM_CMD to TOOLGATE_UPSTREAM_CMD in repo; rename UPSTREAM_ARGS to TOOLGATE_UPSTREAM_ARGS in repo; rename ALLOWED_TOOLS to TOOLGATE_ALLOWED_TOOLS in repo in \.mcp\.json/);
  assert.deepEqual(fs.readdirSync(p.cwd).filter((name) => name.endsWith(".tmp")), []);
  const again = await update(p, { homedir: p.home });
  assert.doesNotMatch(again.out, /mcp-proxy-env/, "a second run has nothing to do");
});

test("proxy env: --dry-run lists what would be renamed and writes nothing; --json lists file, server and pairs", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const old = new Date(Date.now() - 4 * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);
  const before = fs.readFileSync(file, "utf8");
  const dry = await update(p, { homedir: p.home, dryRun: true });
  assert.match(dry.out, /mcp-proxy-env:\.mcp\.json: would-rename - would rename UPSTREAM_CMD to TOOLGATE_UPSTREAM_CMD in repo; .* in \.mcp\.json/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(Math.round(fs.statSync(file).mtimeMs), Math.round(old.getTime()));
  const json = await update(p, { homedir: p.home, dryRun: true, json: true });
  assert.deepEqual(JSON.parse(json.out).renames, [{ file: ".mcp.json", server: "repo", renamed: [["UPSTREAM_CMD", "TOOLGATE_UPSTREAM_CMD"], ["UPSTREAM_ARGS", "TOOLGATE_UPSTREAM_ARGS"], ["ALLOWED_TOOLS", "TOOLGATE_ALLOWED_TOOLS"]] }]);
  const real = await update(p, { homedir: p.home, json: true });
  assert.equal(JSON.parse(real.out).renames.length, 1, "the real run lists what it renamed");
  assert.equal(JSON.parse(real.out).migrations.find((m) => m.id === "mcp-proxy-env:.mcp.json").status, "replaced");
});

test("proxy env: an entry with the new name too, one that is not wrapped by toolgate-proxy, and a file with nothing to rename are left alone", async () => {
  const both = { command: "node", args: ["toolgate-proxy"], env: { UPSTREAM_CMD: "old", TOOLGATE_UPSTREAM_CMD: "new" } };
  const p = project(CURRENT);
  const text = mcpText({ both, other: OTHER, n: { command: "toolgate-proxy" } });
  const file = writeMcp(p, text);
  const r = await update(p, { homedir: p.home });
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.doesNotMatch(r.out, /mcp-proxy-env/);
  const q = project(CURRENT);
  const clean = writeMcp(q, mcpText({ repo: PROXY_NEW }));
  assert.doesNotMatch((await update(q, { homedir: q.home })).out, /mcp-proxy-env/);
  assert.equal(fs.readFileSync(clean, "utf8"), mcpText({ repo: PROXY_NEW }));
});

test("proxy env: a .mcp.json that is a link is not written, and each entry is reported with the text of the spec", async () => {
  const p = project(CURRENT);
  const real = path.join(p.home, "real.json");
  fs.writeFileSync(real, mcpText({ repo: PROXY_OLD }));
  const link = path.join(p.cwd, ".mcp.json");
  fs.symlinkSync(real, link);
  const r = await update(p, { homedir: p.home });
  assert.equal(fs.readFileSync(real, "utf8"), mcpText({ repo: PROXY_OLD }), "the target is untouched");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.match(r.out, /mcp-proxy-env:\.mcp\.json: skipped - toolgate: \.mcp\.json is generated or a link; rename UPSTREAM_CMD to TOOLGATE_UPSTREAM_CMD in its source \(repo\)\ntoolgate: \.mcp\.json is generated or a link; rename UPSTREAM_ARGS to TOOLGATE_UPSTREAM_ARGS in its source \(repo\)\ntoolgate: \.mcp\.json is generated or a link; rename ALLOWED_TOOLS to TOOLGATE_ALLOWED_TOOLS in its source \(repo\)\n/);
  assert.equal((await update(p, { homedir: p.home, dryRun: true })).out.includes("generated or a link"), true, "also in a dry run");
});

test("proxy env: a .mcp.json that git ignores (rulesync generates it) is not written, and is reported", async () => {
  const p = project(CURRENT, { git: true });
  fs.writeFileSync(path.join(p.cwd, ".gitignore"), ".mcp.json\n");
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const before = fs.readFileSync(file, "utf8");
  const r = await update(p, { homedir: p.home });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.match(r.out, /toolgate: \.mcp\.json is generated or a link; rename UPSTREAM_CMD to TOOLGATE_UPSTREAM_CMD in its source \(repo\)/);
});

test("proxy env: a file git versions changes only with --yes, and says to commit it", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const before = fs.readFileSync(file, "utf8");
  const refused = await update(p, { homedir: p.home, isTrackedFn: () => true });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.match(refused.out, /mcp-proxy-env:\.mcp\.json: skipped - \.mcp\.json is versioned by git and was not changed: run `toolgate update --yes` to rename UPSTREAM_CMD to TOOLGATE_UPSTREAM_CMD in repo/);
  const asked = [];
  const answered = await update(p, { homedir: p.home, isTrackedFn: () => true, interactive: true, ask: async (q) => (asked.push(q), "y") });
  assert.deepEqual(asked, [".mcp.json is versioned by git. Rename the proxy variables in it? [y/N] "]);
  assert.equal(fs.readFileSync(file, "utf8"), mcpText({ repo: PROXY_NEW }));
  assert.match(answered.out, /git versions it, so commit the change/);
  writeMcp(p, mcpText({ repo: PROXY_OLD }));
  await update(p, { homedir: p.home, isTrackedFn: () => true, yes: true });
  assert.equal(fs.readFileSync(file, "utf8"), mcpText({ repo: PROXY_NEW }));
});

test("proxy env: the user's ~/.claude.json is migrated too, with --yes: its servers and those of this project, and no other project", async () => {
  const p = project(CURRENT);
  const claude = path.join(p.home, ".claude.json");
  const text = `${JSON.stringify({ numStartups: 3, mcpServers: { top: PROXY_OLD, plain: OTHER }, projects: { [p.cwd]: { mcpServers: { here: PROXY_OLD }, allowedTools: [] }, "/elsewhere": { mcpServers: { there: PROXY_OLD } } } }, null, 2)}\n`;
  fs.writeFileSync(claude, text, { mode: 0o600 });
  const r = await update(p, { homedir: p.home, yes: true });
  const next = JSON.parse(fs.readFileSync(claude, "utf8"));
  assert.deepEqual(next.mcpServers.top.env, PROXY_NEW.env);
  assert.deepEqual(next.projects[p.cwd].mcpServers.here.env, PROXY_NEW.env);
  assert.deepEqual(next.projects["/elsewhere"].mcpServers.there.env, PROXY_OLD.env, "another project is not ours");
  assert.deepEqual(next.mcpServers.plain, OTHER);
  assert.equal(next.numStartups, 3);
  assert.equal(modeOf(claude), 0o600);
  assert.match(r.out, new RegExp(`mcp-proxy-env:${claude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: replaced`));
  assert.equal(fs.readFileSync(claude, "utf8"), `${JSON.stringify(next, null, 2)}\n`);
});

test("proxy env: indentation with four spaces or tabs, and no final newline, are kept; another format is not rewritten", async () => {
  for (const [indent, tail] of [[4, "\n"], ["\t", "\n"], [2, ""]]) {
    const p = project(CURRENT);
    const file = writeMcp(p, mcpText({ repo: PROXY_OLD }, indent, tail));
    await update(p, { homedir: p.home });
    assert.equal(fs.readFileSync(file, "utf8"), mcpText({ repo: PROXY_NEW }, indent, tail), JSON.stringify([indent, tail]));
  }
  const p = project(CURRENT);
  const odd = `{"mcpServers": {"repo": ${JSON.stringify(PROXY_OLD)}}}\n`;
  const file = writeMcp(p, odd);
  const r = await update(p, { homedir: p.home });
  assert.equal(fs.readFileSync(file, "utf8"), odd, "not rewritten");
  assert.match(r.out, /skipped - \.mcp\.json is not formatted the way JSON\.stringify writes it \(or starts with a byte order mark\), so rewriting it would change more than the names: rename UPSTREAM_CMD to TOOLGATE_UPSTREAM_CMD in repo/);
  const bom = project(CURRENT);
  const bomFile = writeMcp(bom, `﻿${mcpText({ repo: PROXY_OLD })}`);
  const bomRun = await update(bom, { homedir: bom.home });
  assert.ok(fs.readFileSync(bomFile, "utf8").includes("UPSTREAM_CMD"), "a file with a BOM is also left alone");
  assert.match(bomRun.out, /mcp-proxy-env:\.mcp\.json: skipped - .*byte order mark.*by hand/, "and it says so");
});

test("proxy env: a file that is not JSON, not an object, or absent is ignored without a word", async () => {
  for (const content of ["{not json", "[]", "null", ""]) {
    const p = project(CURRENT);
    writeMcp(p, content);
    const r = await update(p, { homedir: p.home });
    assert.equal(r.code, 0, content);
    assert.doesNotMatch(r.out, /mcp-proxy-env/, content);
  }
  assert.doesNotMatch((await update(project(CURRENT), {})).out, /mcp-proxy-env/);
});

test("proxy env: a hostile server name is printed through printable, and the command works through toolgate update", async () => {
  const p = project(CURRENT);
  writeMcp(p, mcpText({ "evil\u001b[31m‮": PROXY_OLD }));
  const out = [];
  const code = await run(["update"], { cwd: p.cwd, env: p.env, stdout: { write: (s) => out.push(s) }, stderr: { write() {} } });
  assert.equal(code, 0);
  assert.doesNotMatch(out.join(""), /[\u001b‮]/);
  assert.match(out.join(""), /rename UPSTREAM_CMD to TOOLGATE_UPSTREAM_CMD in evil/);
});

test("proxy env: a write that fails is reported, leaves the file as it was, and the exit code is 1", async () => {
  if (process.getuid() === 0) return;
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const before = fs.readFileSync(file, "utf8");
  fs.chmodSync(p.cwd, 0o500);
  try {
    const r = await update(p, { homedir: p.home });
    assert.equal(r.code, 1);
    assert.match(r.out, /mcp-proxy-env:\.mcp\.json: failed - \.mcp\.json could not be changed \(EACCES/);
  } finally {
    fs.chmodSync(p.cwd, 0o700);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(p.cwd).filter((name) => name.endsWith(".tmp")), []);
});

test("proxy env: ~/.claude.json needs an explicit yes (--yes or an answer), says to close running Claude Code sessions, and is written atomically with its mode", async () => {
  const CLOSE = "close running Claude Code sessions first: they rewrite this file";
  const text = `${JSON.stringify({ mcpServers: { top: PROXY_OLD } }, null, 2)}\n`;
  const fresh = () => {
    const p = project(CURRENT);
    const claude = path.join(p.home, ".claude.json");
    fs.writeFileSync(claude, text, { mode: 0o600 });
    return { p, claude };
  };
  const refused = fresh();
  const no = await update(refused.p, { homedir: refused.p.home });
  assert.equal(fs.readFileSync(refused.claude, "utf8"), text, "no --yes and no terminal: not changed");
  assert.match(no.out, /skipped - .*\.claude\.json is Claude Code's own file and was not changed: run `toolgate update --yes` to rename UPSTREAM_CMD to TOOLGATE_UPSTREAM_CMD in top/);
  assert.ok(no.out.includes(CLOSE));
  const declined = await update(refused.p, { homedir: refused.p.home, interactive: true, ask: async () => "n" });
  assert.equal(fs.readFileSync(refused.claude, "utf8"), text, "an answer other than yes: not changed");
  assert.ok(declined.out.includes(CLOSE));
  const dry = await update(refused.p, { homedir: refused.p.home, dryRun: true });
  assert.ok(dry.out.includes(CLOSE) && dry.out.includes("would-rename"), "also in a dry run");
  const asked = [];
  const answered = await update(refused.p, { homedir: refused.p.home, interactive: true, ask: async (q) => (asked.push(q), "yes") });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\.claude\.json is Claude Code's own file \(close running Claude Code sessions first: they rewrite it\)\. Rename the proxy variables in it\? \[y\/N\] $/);
  assert.equal(JSON.parse(fs.readFileSync(refused.claude, "utf8")).mcpServers.top.env.TOOLGATE_UPSTREAM_CMD, "npx");
  assert.equal(modeOf(refused.claude), 0o600);
  assert.ok(answered.out.includes(CLOSE));
  assert.deepEqual(fs.readdirSync(refused.p.home).filter((name) => name.endsWith(".tmp")), [], "the temporary file is gone: written aside and renamed");
  const forced = fresh();
  const yes = await update(forced.p, { homedir: forced.p.home, yes: true });
  assert.equal(JSON.parse(fs.readFileSync(forced.claude, "utf8")).mcpServers.top.env.TOOLGATE_UPSTREAM_CMD, "npx");
  assert.ok(yes.out.includes(CLOSE));
  // The project file is not asked about when git does not version it, and does not carry the line.
  const project1 = project(CURRENT);
  writeMcp(project1, mcpText({ repo: PROXY_OLD }));
  const plain = await update(project1, { homedir: project1.home });
  assert.ok(!plain.out.includes(CLOSE));
});

test("proxy env: a ~/.claude.json that a dotfiles repository versions also says to commit the change", async () => {
  const p = project(CURRENT);
  const claude = path.join(p.home, ".claude.json");
  fs.writeFileSync(claude, `${JSON.stringify({ mcpServers: { top: PROXY_OLD } }, null, 2)}\n`, { mode: 0o600 });
  const r = await update(p, { homedir: p.home, yes: true, isTrackedFn: () => true });
  assert.match(r.out, /git versions it, so commit the change/);
});

test("proxy env: a .mcp.json that is a FIFO, or a link to one, does not make update wait", async () => {
  const { execFileSync } = await import("node:child_process");
  const p = project(CURRENT);
  const fifo = path.join(p.home, "pipe");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return; // no mkfifo here
  }
  const link = path.join(p.cwd, ".mcp.json");
  for (const make of [() => execFileSync("mkfifo", [link]), () => fs.symlinkSync(fifo, link)]) {
    make();
    const started = Date.now();
    const r = await update(p, { homedir: p.home });
    assert.ok(Date.now() - started < 5000, "returned at once");
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, /mcp-proxy-env/);
    fs.rmSync(link);
  }
});

test("proxy env: a folder is not read, and a file bigger than the limit is said", async () => {
  const p = project(CURRENT);
  const file = path.join(p.cwd, ".mcp.json");
  fs.mkdirSync(file);
  assert.doesNotMatch((await update(p, { homedir: p.home })).out, /mcp-proxy-env/);
  fs.rmdirSync(file);
  fs.writeFileSync(file, `${mcpText({ repo: PROXY_OLD })}${" ".repeat(17 * 1024 * 1024)}`);
  const big = await update(p, { homedir: p.home });
  assert.equal(big.code, 0);
  assert.match(big.out, /mcp-proxy-env:\.mcp\.json: skipped - \.mcp\.json is larger than 16 MiB; not migrated/, "said, not silent");
  const exact = project(CURRENT);
  const head = mcpText({ repo: PROXY_OLD });
  const atLimit = writeMcp(exact, head.slice(0, -1) + " ".repeat(16 * 1024 * 1024 - head.length) + "\n");
  assert.equal(fs.statSync(atLimit).size, 16 * 1024 * 1024);
  assert.doesNotMatch((await update(exact, { homedir: exact.home, dryRun: true })).out, /larger than/, "exactly 16 MiB is read");
});

test("proxy env: a file that changes while the question is open is not written over, and the run fails with a note", async () => {
  const p = project(CURRENT);
  const claude = path.join(p.home, ".claude.json");
  const original = `${JSON.stringify({ mcpServers: { top: PROXY_OLD } }, null, 2)}\n`;
  fs.writeFileSync(claude, original, { mode: 0o600 });
  const concurrent = `${JSON.stringify({ mcpServers: { top: PROXY_OLD }, numStartups: 9 }, null, 2)}\n`;
  const r = await update(p, { homedir: p.home, interactive: true, ask: async () => (fs.writeFileSync(claude, concurrent), "y") });
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(claude, "utf8"), concurrent, "what was written meanwhile is still there");
  assert.match(r.out, /changed while toolgate ran, nothing was written: run toolgate update again/);
  assert.doesNotMatch(r.out, /replaced/);
  assert.doesNotMatch(JSON.stringify(JSON.parse((await update(p, { homedir: p.home, json: true, yes: true })).out).renames), /nothing/, "a second run migrates the new content");
  assert.equal(JSON.parse(fs.readFileSync(claude, "utf8")).numStartups, 9);
  // The project file too, with --yes there is no question: the window is only between reading and writing, and it is checked.
  const q = project(CURRENT);
  const file = writeMcp(q, mcpText({ repo: PROXY_OLD }));
  let changed = false;
  const r2 = await update(q, { homedir: q.home, isTrackedFn: () => { if (!changed) { changed = true; fs.writeFileSync(file, `${mcpText({ repo: PROXY_OLD, extra: OTHER })}`); } return false; } });
  assert.equal(r2.code, 1);
  assert.ok(fs.readFileSync(file, "utf8").includes("extra"));
  assert.match(r2.out, /changed while toolgate ran/);
});

test("proxy env: a dry run refuses what the real run would refuse (a file with CRLF), and --json lists only what is or would be renamed", async () => {
  const p = project(CURRENT);
  const crlf = mcpText({ repo: PROXY_OLD }).replace(/\n/g, "\r\n");
  writeMcp(p, crlf);
  const dry = await update(p, { homedir: p.home, dryRun: true, json: true });
  assert.equal(JSON.parse(dry.out).migrations.find((m) => m.id === "mcp-proxy-env:.mcp.json").status, "skipped");
  assert.deepEqual(JSON.parse(dry.out).renames, []);
  const link = project(CURRENT);
  const real = path.join(link.home, "real.json");
  fs.writeFileSync(real, mcpText({ repo: PROXY_OLD }));
  fs.symlinkSync(real, path.join(link.cwd, ".mcp.json"));
  assert.deepEqual(JSON.parse((await update(link, { homedir: link.home, json: true })).out).renames, [], "a link lists nothing renamed");
  const refused = project(CURRENT);
  writeMcp(refused, mcpText({ repo: PROXY_OLD }));
  assert.deepEqual(JSON.parse((await update(refused, { homedir: refused.home, json: true, isTrackedFn: () => true })).out).renames, [], "a versioned file refused without --yes lists nothing");
});

test("a write or a rename that fails leaves no .tmp beside the file", async () => {
  const p = project(OLD_RULE);
  const rule = p.file;
  fs.mkdirSync(`${rule}.pending`);
  fs.chmodSync(path.dirname(rule), 0o500);
  try {
    if (process.getuid() === 0) return;
    const r = await update(p, { homedir: p.home, ...KNOWS_OLD });
    assert.equal(r.code, 1);
  } finally {
    fs.chmodSync(path.dirname(rule), 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(rule)).filter((name) => name.endsWith(".tmp")), []);
});

test("proxy env: the new file is complete before the file is looked at again: a change made while it is written is not lost", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const concurrent = mcpText({ repo: PROXY_OLD, added: OTHER });
  let looked = 0;
  // The first thing asked of the file after the question is the stat right before the rename; the change lands just before it.
  const realStat = fs.statSync;
  fs.statSync = function patched(target, ...rest) {
    if (target === file && !looked++) fs.writeFileSync(file, concurrent);
    return realStat.call(this, target, ...rest);
  };
  let r;
  try {
    r = await update(p, { homedir: p.home, yes: true });
  } finally {
    fs.statSync = realStat;
  }
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(file, "utf8"), concurrent);
  assert.match(r.out, /changed while toolgate ran, nothing was written: run toolgate update again/);
  assert.deepEqual(fs.readdirSync(p.cwd).filter((name) => name.endsWith(".tmp")), [], "the finished temporary file is removed");
});

test("proxy env: a change that only touches whitespace or the mtime is also a change", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const original = fs.readFileSync(file, "utf8");
  const r = await update(p, { homedir: p.home, interactive: true, isTrackedFn: () => true, ask: async () => (fs.writeFileSync(file, `${original}\n\n`), "y") });
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(file, "utf8"), `${original}\n\n`);
  const q = project(CURRENT);
  const second = writeMcp(q, mcpText({ repo: PROXY_OLD }));
  const r2 = await update(q, { homedir: q.home, interactive: true, isTrackedFn: () => true, ask: async () => (fs.utimesSync(second, new Date(), new Date(Date.now() + 5000)), "y") });
  assert.equal(r2.code, 1, "the same content with another mtime counts: the file was written by someone");
});

test("replaceFile: a rename that throws after the temporary file was made leaves no .tmp, and the error text is printable", async () => {
  const p = project(OLD_RULE);
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("boom\u001b[31m");
  };
  let r;
  try {
    r = await update(p, { homedir: p.home, ...KNOWS_OLD });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /\u001b/);
  assert.match(r.out, /could not be replaced \(boom/);
  assert.deepEqual(fs.readdirSync(path.dirname(p.file)).filter((name) => name.endsWith(".tmp")), []);
  const q = project(CURRENT);
  writeMcp(q, mcpText({ repo: PROXY_OLD }));
  fs.renameSync = () => {
    throw new Error("nope\u001b[31m");
  };
  let r2;
  try {
    r2 = await update(q, { homedir: q.home });
  } finally {
    fs.renameSync = realRename;
  }
  assert.doesNotMatch(r2.out, /\u001b/);
  assert.match(r2.out, /mcp-proxy-env:\.mcp\.json: failed - \.mcp\.json could not be changed \(nope/);
  assert.deepEqual(fs.readdirSync(q.cwd).filter((name) => name.endsWith(".tmp")), []);
});

test("proxy env: a character device named .mcp.json is not read", async () => {
  const p = project(CURRENT);
  fs.symlinkSync("/dev/zero", path.join(p.cwd, ".mcp.json"));
  const started = Date.now();
  const r = await update(p, { homedir: p.home });
  assert.ok(Date.now() - started < 5000);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /mcp-proxy-env/);
});

test("proxy env: a file removed while the question is open is not brought back", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const r = await update(p, { homedir: p.home, interactive: true, isTrackedFn: () => true, ask: async () => (fs.rmSync(file), "y") });
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(file), false);
  assert.match(r.out, /changed while toolgate ran, nothing was written/);
});

test("proxy env: a file replaced by another file with the same size and mtime is a change (its inode moved)", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const text = fs.readFileSync(file, "utf8");
  const r = await update(p, { homedir: p.home, interactive: true, isTrackedFn: () => true, ask: async () => {
    const stat = fs.statSync(file);
    fs.rmSync(file);
    fs.writeFileSync(file, text);
    fs.utimesSync(file, stat.atime, stat.mtime);
    return "y";
  } });
  assert.equal(r.code, 1, "the content and the mtime are the same, the inode and ctime are not");
});

test("proxy env: the original is looked at only after the new file is written whole (a change while the temp file is made is caught)", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const concurrent = mcpText({ repo: PROXY_OLD, added: OTHER });
  const realOpen = fs.openSync;
  let hooked = false;
  fs.openSync = function patched(target, flags, ...rest) {
    if (!hooked && typeof target === "string" && target.startsWith(`${file}.`) && target.endsWith(".tmp") && flags === "wx") {
      hooked = true;
      fs.writeFileSync(file, concurrent);
    }
    return realOpen.call(this, target, flags, ...rest);
  };
  let r;
  try {
    r = await update(p, { homedir: p.home, yes: true });
  } finally {
    fs.openSync = realOpen;
  }
  assert.equal(hooked, true, "the temp file was made");
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(file, "utf8"), concurrent, "the concurrent change survived");
  assert.match(r.out, /changed while toolgate ran, nothing was written/);
});

test("proxy env: a same-size rewrite with the mtime put back is still a change (ctime)", async () => {
  const p = project(CURRENT);
  const file = writeMcp(p, mcpText({ repo: PROXY_OLD }));
  const original = fs.readFileSync(file, "utf8");
  const sameSize = original.replace("npx", "bpx");
  assert.equal(sameSize.length, original.length);
  const { execFileSync } = await import("node:child_process");
  const reference = path.join(p.home, "reference");
  execFileSync("cp", ["-p", file, reference]);
  const r = await update(p, { homedir: p.home, interactive: true, isTrackedFn: () => true, ask: async () => {
    fs.writeFileSync(file, sameSize);
    execFileSync("touch", ["-r", reference, file]); // the mtime back to the very nanosecond; the inode and the size are those of the read
    return "y";
  } });
  assert.equal(r.code, 1, "only the ctime says the file was written");
  assert.equal(fs.readFileSync(file, "utf8"), sameSize);
});

test("replaceFile: the temp file never has more mode than the original, from the moment it is made", async () => {
  const p = project(CURRENT);
  const claude = path.join(p.home, ".claude.json");
  fs.writeFileSync(claude, `${JSON.stringify({ mcpServers: { top: PROXY_OLD } }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(claude, 0o600);
  const before = process.umask(0o022);
  const realWrite = fs.writeSync;
  const seen = [];
  fs.writeSync = function patched(fd, ...rest) {
    seen.push(fs.fstatSync(fd).mode & 0o777);
    return realWrite.call(this, fd, ...rest);
  };
  try {
    await update(p, { homedir: p.home, yes: true });
  } finally {
    fs.writeSync = realWrite;
    process.umask(before);
  }
  assert.ok(seen.length >= 1);
  assert.deepEqual([...new Set(seen)], [0o600], "the content was written into a file that only the user can read");
  assert.equal(modeOf(claude), 0o600);
  const broad = project(CURRENT);
  const file = writeMcp(broad, mcpText({ repo: PROXY_OLD }), 0o664);
  await update(broad, { homedir: broad.home });
  assert.equal(modeOf(file), 0o664, "a mode with bits the umask removes is put back by the chmod");
});

test("proxy env: exactly 16 MiB is migrated and one byte more is not; the big file is mentioned only when it names an old key", async () => {
  const LIMIT = 16 * 1024 * 1024;
  const make = (extra, names) => {
    const p = project(CURRENT);
    const head = names ? mcpText({ repo: PROXY_OLD }) : mcpText({ repo: PROXY_NEW });
    const file = writeMcp(p, head.slice(0, -1) + " ".repeat(LIMIT - head.length + extra) + "\n");
    return { p, file };
  };
  const exact = make(0, true);
  assert.equal(fs.statSync(exact.file).size, LIMIT);
  const readIt = (await update(exact.p, { homedir: exact.p.home, dryRun: true })).out;
  assert.doesNotMatch(readIt, /larger than/, "exactly 16 MiB is read (the padding makes it a file that is not rewritten, which is said in other words)");
  assert.match(readIt, /not formatted the way JSON\.stringify writes it/);
  const over = make(1, true);
  assert.equal(fs.statSync(over.file).size, LIMIT + 1);
  assert.match((await update(over.p, { homedir: over.p.home })).out, /mcp-proxy-env:\.mcp\.json: skipped - \.mcp\.json is larger than 16 MiB; not migrated/);
  const quiet = make(1, false);
  assert.doesNotMatch((await update(quiet.p, { homedir: quiet.p.home })).out, /larger than/, "no old key in it: nothing to say");
  const plainBig = project(CURRENT);
  fs.writeFileSync(path.join(plainBig.cwd, ".mcp.json"), " ".repeat(LIMIT + 5));
  assert.doesNotMatch((await update(plainBig, { homedir: plainBig.home })).out, /larger than/);
});

test("proxy env: the id of a migration is printable", async () => {
  const p = project(CURRENT);
  const claude = path.join(p.home, ".claude.json");
  fs.writeFileSync(claude, `${JSON.stringify({ mcpServers: { top: PROXY_OLD } }, null, 2)}\n`);
  const r = await update(p, { homedir: path.join(p.home) });
  assert.ok(r.out.includes("mcp-proxy-env:"));
  const odd = project(CURRENT);
  const oddHome = path.join(odd.home, "h\u001b[31m");
  fs.mkdirSync(oddHome);
  fs.writeFileSync(path.join(oddHome, ".claude.json"), `${JSON.stringify({ mcpServers: { top: PROXY_OLD } }, null, 2)}\n`);
  const out = await update(odd, { homedir: oddHome, yes: true });
  assert.doesNotMatch(out.out, /\u001b/);
});

test("proxy env: the id of a skipped big file is printable too", async () => {
  const p = project(CURRENT);
  const oddHome = path.join(p.home, "h\u001b[31m");
  fs.mkdirSync(oddHome);
  const head = `${JSON.stringify({ mcpServers: { top: PROXY_OLD } }, null, 2)}\n`;
  fs.writeFileSync(path.join(oddHome, ".claude.json"), head.slice(0, -1) + " ".repeat(16 * 1024 * 1024 - head.length + 1) + "\n");
  const out = await update(p, { homedir: oddHome, yes: true });
  assert.match(out.out, /larger than 16 MiB; not migrated/);
  assert.doesNotMatch(out.out, /\u001b/);
});
