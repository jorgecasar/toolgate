import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../src/init.js";
import { runUpdate } from "../src/update/index.js";
import { bridgeCommands, bridgeText } from "../src/commands/bridge.js";
import { KNOWN_BRIDGE_SHA256 } from "../src/update/bridgeHistory.js";
import crypto from "node:crypto";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-bridge-${name}-`));
const project = () => {
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  return cwd;
};
const read = (cwd, file) => fs.readFileSync(path.join(cwd, file), "utf8");
const has = (cwd, file) => fs.existsSync(path.join(cwd, file));
const FILE = ".claude/commands/toolgate.md";
const installing = (...bins) => (bin) => {
  if (bins.includes(bin)) return "1.0";
  throw new Error("ENOENT");
};

async function init(cwd, { installed = ["claude"], answers = null, home = tmp("home"), ...rest } = {}) {
  const out = [];
  const asked = [];
  const code = await runInit({
    cwd,
    env: { HOME: home, XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), TOOLGATE_DEFAULTS: path.join(cwd, "no-user.json") },
    stdout: { write: (s) => out.push(s) },
    execFn: installing(...installed),
    daemon: { ensure: async () => ({ running: false, reason: "test" }) },
    backend: "regex",
    targets: ["claudecode"],
    isTrackedFn: () => false,
    interactive: answers !== null,
    ask: async (question) => {
      asked.push(question);
      const next = (answers ?? []).find(([pattern]) => pattern.test(question));
      return next ? next[1] : "";
    },
    ...rest,
  });
  return { code, out: out.join(""), asked, home };
}
const bridgeQuestion = (run) => run.asked.filter((q) => /\/toolgate command/.test(q));

test("interactively the offer is one question, yes by default, and it writes what `commands bridge` writes", async () => {
  const cwd = project();
  const run = await init(cwd, { installed: ["claude", "opencode"], answers: [[/agent\?/, "1"]] });
  assert.equal(bridgeQuestion(run).length, 1, "one question for every agent");
  assert.match(bridgeQuestion(run)[0], /^Create the \/toolgate command in your agents \(claude-code, opencode\)\? \[Y\/n\] $/);
  const other = project();
  bridgeCommands({ projectDir: other, homeDir: tmp("home"), agents: ["claude-code", "opencode"] });
  assert.equal(read(cwd, FILE), read(other, FILE), "byte-identical to the command");
  assert.equal(read(cwd, ".opencode/command/toolgate.md"), read(other, ".opencode/command/toolgate.md"));
  assert.equal(read(cwd, FILE), bridgeText());
  assert.match(run.out, /restart the agent or open a new session/);
  assert.doesNotMatch(run.out, /run `toolgate commands bridge`/);
});

test("--bridge writes the command without the question, in a terminal too, and still asks the other questions", async () => {
  const cwd = project();
  const run = await init(cwd, { installed: ["claude"], answers: [[/agent\?/, "1"]], bridge: true });
  assert.equal(bridgeQuestion(run).length, 0, "the flag is the answer");
  assert.equal(read(cwd, FILE), bridgeText());
  assert.ok(!run.asked.some((q) => /^Default agent/.test(q)), "one installed agent: nothing to choose, so no agent question");
  const kept = project();
  const dry = await init(kept, { installed: ["claude"], bridge: true, dryRun: true });
  assert.ok(!has(kept, FILE), "a dry run writes nothing");
  assert.match(dry.out, /would write \.claude\/commands\/toolgate\.md/);
});
test("from an npm script (npm install runs the setup) the restart note is not printed: no agent is open yet", async () => {
  const cwd = project();
  const run = await init(cwd, { installed: ["claude"], bridge: true, env: { HOME: tmp("home"), XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), npm_lifecycle_event: "postinstall" } });
  assert.equal(read(cwd, FILE), bridgeText(), "the command is written all the same");
  assert.doesNotMatch(run.out, /restart the agent/);
});
test("no writes nothing and keeps the hint; Ctrl+C writes nothing and exits 1", async () => {
  const declined = project();
  const run = await init(declined, { answers: [[/\/toolgate command/, "n"]] });
  assert.ok(!has(declined, ".claude/commands"));
  assert.match(run.out, /run `toolgate commands bridge`/);
  assert.equal(run.code, 0);

  const cancelled = project();
  const out = await init(cancelled, { answers: [[/\/toolgate command/, null]] });
  assert.equal(out.code, 1);
  assert.ok(!has(cancelled, ".claude/commands"));
  assert.match(out.out, /cancelled at the question: the \/toolgate command was not created/);
});

test("--yes and a run without a terminal ask nothing and write the command, saying so", async () => {
  for (const extra of [{ yes: true }, { interactive: false }]) {
    const cwd = project();
    const run = await init(cwd, extra);
    assert.equal(bridgeQuestion(run).length, 0);
    assert.ok(has(cwd, FILE));
    assert.match(run.out, /\/toolgate command: wrote \.claude\/commands\/toolgate\.md/);
  }
});

test("a dry run asks nothing and writes nothing, and says it would", async () => {
  const cwd = project();
  const run = await init(cwd, { dryRun: true });
  assert.ok(!has(cwd, ".claude/commands"));
  assert.equal(bridgeQuestion(run).length, 0);
  assert.match(run.out, /would write \.claude\/commands\/toolgate\.md/);
});

test("only installed agents are offered, not one named by --agent or --targets", async () => {
  const cwd = project();
  const run = await init(cwd, { installed: [], agent: "claude-code", targets: ["claudecode"], yes: true });
  assert.ok(!has(cwd, ".claude/commands"));
  assert.doesNotMatch(run.out, /\/toolgate command/);
});

test("a second init does not ask again for a bridged agent and changes nothing", async () => {
  const cwd = project();
  await init(cwd, { yes: true });
  const before = fs.statSync(path.join(cwd, FILE));
  const again = await init(cwd, { answers: [] });
  assert.equal(bridgeQuestion(again).length, 0);
  assert.equal(read(cwd, FILE), bridgeText());
  assert.equal(fs.statSync(path.join(cwd, FILE)).mtimeMs, before.mtimeMs);
  assert.doesNotMatch(again.out, /run `toolgate commands bridge`|restart the agent/);
});

test("a file that is not toolgate's, or was edited, or is a link, is never overwritten, asked about or refreshed", async () => {
  const foreign = project();
  fs.mkdirSync(path.join(foreign, ".claude/commands"), { recursive: true });
  fs.writeFileSync(path.join(foreign, FILE), "my own command\n");
  const run = await init(foreign, { yes: true });
  assert.equal(read(foreign, FILE), "my own command\n");
  assert.equal(bridgeQuestion((await init(foreign, { answers: [] }))).length, 0);
  assert.match(run.out, /run `toolgate commands bridge`/);

  const edited = project();
  await init(edited, { yes: true });
  fs.appendFileSync(path.join(edited, FILE), "\nmy note\n");
  const kept = await init(edited, { yes: true });
  assert.match(read(edited, FILE), /my note/);
  assert.match(kept.out, /was changed by hand/);

  const linked = project();
  const target = path.join(tmp("outside"), "x.md");
  fs.mkdirSync(path.join(linked, ".claude/commands"), { recursive: true });
  fs.symlinkSync(target, path.join(linked, FILE));
  await init(linked, { yes: true });
  assert.ok(!fs.existsSync(target), "nothing was written through the link");
});

test("codex: only the --user hint; init writes nothing in the home folder or the project for it", async () => {
  const cwd = project();
  const home = tmp("home");
  const run = await init(cwd, { installed: ["codex"], home, yes: true });
  assert.match(run.out, /codex reads \/toolgate only from your home folder: run `toolgate commands bridge --user`/);
  assert.ok(!fs.existsSync(path.join(home, ".codex")));
  assert.ok(!has(cwd, ".codex"));
  assert.equal(bridgeQuestion(run).length, 0);
});

test("a bridge byte-identical to an older shipped text is refreshed by `toolgate update`, and init points to it", async () => {
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  const cwd = project();
  const old = bridgeText().replace("Run `toolgate need`", "Run `toolgate find`");
  fs.mkdirSync(path.join(cwd, ".claude/commands"), { recursive: true });
  fs.writeFileSync(path.join(cwd, FILE), old);
  fs.chmodSync(path.join(cwd, FILE), 0o600);
  const hashes = [...KNOWN_BRIDGE_SHA256, sha(old)];
  const out = [];
  const code = await runUpdate({ cwd, env: { HOME: tmp("home"), XDG_CONFIG_HOME: tmp("x"), XDG_CACHE_HOME: tmp("c") }, stdout: { write: (s) => out.push(s) }, yes: true, interactive: false, knownBridgeHashes: hashes });
  assert.equal(code, 0);
  assert.equal(read(cwd, FILE), bridgeText());
  assert.match(out.join(""), /bridge-refresh:claude-code: replaced/);
  assert.equal(fs.statSync(path.join(cwd, FILE)).mode & 0o777, 0o600, "the refreshed bridge keeps the mode of the file it replaced");

  // The same stale file seen by init: it says `toolgate update` fixes it, and does not write.
  fs.writeFileSync(path.join(cwd, FILE), old);
  const stale = await init(cwd, { yes: true, knownBridgeHashes: hashes });
  assert.equal(read(cwd, FILE), old, "init does not refresh it");
  assert.equal(bridgeQuestion(stale).length, 0);
  assert.match(stale.out, /is the \/toolgate command of an older toolgate: run `toolgate update`/);
});

test("update leaves a hand-edited or foreign bridge alone, and says nothing for an absent one", async () => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, ".claude/commands"), { recursive: true });
  fs.writeFileSync(path.join(cwd, FILE), `${bridgeText()}\nmy note\n`);
  const out = [];
  const env = { HOME: tmp("home"), XDG_CONFIG_HOME: tmp("x"), XDG_CACHE_HOME: tmp("c") };
  await runUpdate({ cwd, env, stdout: { write: (s) => out.push(s) }, yes: true, interactive: false });
  assert.match(read(cwd, FILE), /my note/);
  assert.match(out.join(""), /bridge-refresh:claude-code: edited/);
  assert.doesNotMatch(out.join(""), /bridge-refresh:opencode|bridge-refresh:antigravity/);
});
