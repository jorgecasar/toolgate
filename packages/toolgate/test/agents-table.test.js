// The Agents page of the website is generated from the adapters' capability objects (#275): the code is its only source.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { git } from "./support/git.js";
import { agentsPage, registeredAdapters } from "../../website/scripts/agents-table.mjs";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const rowsOf = (page, title) => {
  const section = page.split(/^## /m).find((part) => part.startsWith(`${title}\n`));
  return section.split("\n").filter((line) => line.startsWith("| `")).map((line) => line.split(" | ")[0].slice(3, -1));
};

test("every table has one row per registered adapter, in the registry's order", async () => {
  const adapters = await registeredAdapters();
  const names = adapters.map((a) => a.name);
  assert.deepEqual(names, ["claude-code", "codex", "antigravity", "karajan", "opencode"]);
  const page = agentsPage(adapters);
  for (const title of ["Rules and tools", "Commands, subagents, hooks and permissions", "Session"]) assert.deepEqual(rowsOf(page, title), names, title);
});

test("the values are the adapters' own: codex carries the rule at launch, opencode does not", async () => {
  const page = agentsPage(await registeredAdapters());
  assert.match(page, /\| `codex` \| `AGENTS\.md` and, with `client\.injectRule`, at launch with `-c developer_instructions` \|/);
  assert.match(page, /\| `claude-code` \| `\.claude\/rules\/toolgate-router\.md` and, with `client\.injectRule`, at launch with `--append-system-prompt` \|/);
  assert.match(page, /\| `opencode` \| `AGENTS\.md` \| loaded at launch \|/);
});

test("a changed capability changes the page, and a kind the script does not know is shown, not dropped", async () => {
  const adapters = await registeredAdapters();
  const before = agentsPage(adapters);
  const opencode = adapters.find((a) => a.name === "opencode");
  const changed = adapters.map((a) => (a === opencode ? { ...a, capability: { ...a.capability, rules: { ...a.capability.rules, injectFlag: "--rule" } } } : a));
  assert.match(agentsPage(changed), /\| `opencode` \| `AGENTS\.md` and, with `client\.injectRule`, at launch with `--rule` \|/);
  assert.notEqual(agentsPage(changed), before);
  const novel = adapters.map((a) => (a === opencode ? { ...a, capability: { ...a.capability, hooks: { kind: "pluginDir" }, launchGating: "socket" } } : a));
  const page = agentsPage(novel);
  assert.match(page, /`pluginDir`/);
  assert.match(page, /`socket`/);
});

test("the page is generated before every build and dev run, and is not committed", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "packages", "website", "package.json"), "utf8")).scripts;
  assert.equal(scripts["predocs:build"], "node scripts/agents-table.mjs");
  assert.equal(scripts["predocs:dev"], "node scripts/agents-table.mjs");
  assert.equal(git(root, "ls-files", "docs/agents.md"), "");
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^docs\/agents\.md$/m);
});

test("a capability without hooks, permissions, commands, subagents or resume reads as unknown, and does not throw", async () => {
  const [first] = await registeredAdapters();
  const { hooks, permissions, commands, subagents, resume, ...bare } = first.capability;
  const page = agentsPage([{ name: "bare", capability: bare }]);
  const commandsTable = page.split(/^## /m).find((part) => part.startsWith("Commands, subagents"));
  assert.match(commandsTable, /\| `bare` \| unknown \| unknown \| unknown \| unknown \|/);
  assert.match(page.split(/^## /m).find((part) => part.startsWith("Session")), /\| `bare` \| unknown \|/);
});

test("run through a link to the script (as /tmp is on macOS), it still writes the page", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-at-")));
  try {
    const link = path.join(dir, "agents-table.mjs");
    fs.symlinkSync(path.join(root, "packages", "website", "scripts", "agents-table.mjs"), link);
    const page = path.join(root, "docs", "agents.md");
    fs.rmSync(page, { force: true });
    const out = spawnSync(process.execPath, [link], { encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
    assert.equal(out.status, 0, out.stderr);
    assert.match(fs.readFileSync(page, "utf8"), /\| `opencode` \|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importing the script while argv[1] is not a file does not throw and writes nothing", () => {
  const script = path.join(root, "packages", "website", "scripts", "agents-table.mjs");
  const page = path.join(root, "docs", "agents.md");
  fs.rmSync(page, { force: true });
  const out = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(script).href)}).then(() => console.log("ok"))`, "no-such-file"], { encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ok/);
  assert.equal(fs.existsSync(page), false);
});
