// The `commands` capability of the adapters and the Antigravity workflows.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMANDS_CAPABILITY } from "../src/adapters/commands.js";
import { defaultRegistry } from "../src/adapters/index.js";
import { COMMAND_DIALECTS, validateCapability } from "../src/capability.js";
import { nativeFolders } from "../src/commands/native.js";
import { DIALECTS } from "../src/commands/parse.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-capcmd-")));
  made.push(dir);
  return dir;
};
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

const base = Object.freeze({
  defersToolSchemas: false,
  rules: { kind: "none" },
  launchGating: "none",
  exclusiveMcpConfig: false,
  resume: { supported: false },
  dynamicTools: false,
  passthrough: "args",
});
const withCommands = (commands) => validateCapability(Object.freeze({ ...base, commands }));
const good = { kind: "nativeDir", dialect: "claude", format: "markdown", projectDirs: [".claude/commands"], userDirs: [] };

test("the dialects the capability accepts are the ones the parser reads", () => {
  assert.deepEqual([...COMMAND_DIALECTS], [...DIALECTS]);
});

test("commands capability: optional, and a valid value passes", () => {
  assert.deepEqual(validateCapability(base), []);
  assert.deepEqual(withCommands(good), []);
  assert.deepEqual(withCommands({ kind: "none" }), []);
  assert.deepEqual(withCommands({ kind: "unknown" }), []);
});

test("commands capability: every bad field is named", () => {
  const problem = (commands, pattern) => assert.match(withCommands(commands).join("; "), pattern, JSON.stringify(commands));
  problem(null, /commands must be an object/);
  problem([], /commands must be an object/);
  problem({ kind: "folder" }, /commands.kind must be one of/);
  problem({ kind: "none", dialect: "claude" }, /takes no other field/);
  problem({ ...good, dialect: "vim" }, /commands.dialect must be one of/);
  problem({ ...good, format: "yaml" }, /commands.format must be one of/);
  problem({ ...good, projectDirs: "x" }, /commands.projectDirs must be a list of relative folders/);
  problem({ ...good, projectDirs: ["/etc"] }, /commands.projectDirs/);
  problem({ ...good, projectDirs: ["../up"] }, /commands.projectDirs/);
  problem({ ...good, projectDirs: ["a/../../b"] }, /commands.projectDirs/);
  problem({ ...good, projectDirs: ["a//b"] }, /commands.projectDirs/);
  problem({ ...good, projectDirs: ["a\\b"] }, /commands.projectDirs/);
  problem({ ...good, projectDirs: ["C:/x"] }, /commands.projectDirs/);
  problem({ ...good, projectDirs: [""] }, /commands.projectDirs/);
  problem({ ...good, userDirs: [3] }, /commands.userDirs/);
  problem({ ...good, projectDirs: [] }, /needs at least one folder/);
  problem({ ...good, extra: 1 }, /unknown commands field "extra"/);
});

test("every adapter declares what the table says, and the values are the documented ones", async () => {
  const expected = {
    "claude-code": { dialect: "claude", format: "markdown", project: [".claude/commands"], user: [".claude/commands"] },
    opencode: { dialect: "opencode", format: "markdown", project: [".opencode/command", ".opencode/commands"], user: [".config/opencode/command", ".config/opencode/commands"] },
    codex: { dialect: "codex", format: "markdown", project: [], user: [".codex/prompts"] },
    antigravity: { dialect: "antigravity", format: "markdown", project: [".agents/workflows", ".agents/commands"], user: [] },
  };
  for (const name of defaultRegistry.names()) {
    const { capability } = await defaultRegistry.get(name);
    assert.equal(capability.commands, COMMANDS_CAPABILITY[name], name);
    assert.ok(Object.isFrozen(capability.commands) && (capability.commands.kind !== "nativeDir" || (Object.isFrozen(capability.commands.projectDirs) && Object.isFrozen(capability.commands.userDirs))), name);
    const want = expected[name];
    if (!want) continue;
    assert.deepEqual([capability.commands.dialect, capability.commands.format, capability.commands.projectDirs, capability.commands.userDirs], [want.dialect, want.format, want.project, want.user], name);
  }
  assert.equal(COMMANDS_CAPABILITY.karajan.kind, "none");
  assert.equal(COMMANDS_CAPABILITY.generic.kind, "unknown");
});

test("native folders follow the capability: the workflows of Antigravity are found, with their dialect", () => {
  const dir = tmp();
  put(dir, ".agents/workflows/ship.md", "x");
  put(dir, ".codex/prompts/p.md", "x");
  const project = nativeFolders({ base: dir });
  assert.deepEqual(project.folders.map((f) => [f.agent, f.label, f.dialect]).sort(), [["antigravity", ".agents/workflows", "antigravity"]]);
  assert.deepEqual(project.notes, []);
  const user = nativeFolders({ base: dir, user: true });
  assert.deepEqual(user.folders.map((f) => [f.agent, f.label, f.dialect]).sort(), [["codex", "~/.codex/prompts", "codex"]]);
});
test("commands capability: '.' is the whole project or home, not a folder of commands; real folders and ./folders stay", () => {
  const MSG = { projectDirs: "commands.projectDirs must be a list of relative folders inside the project", userDirs: "commands.userDirs must be a list of relative folders inside the home folder" };
  for (const field of ["projectDirs", "userDirs"]) {
    for (const bad of [".", "./", "./.", "a/..", "./a/.."]) assert.ok(withCommands({ ...good, [field]: [bad] }).includes(MSG[field]), `${field}: ${JSON.stringify(bad)}`);
    for (const fine of [".claude/commands", "./commands", "a/b", "a/."]) assert.deepEqual(withCommands({ ...good, [field]: [fine] }), [], `${field}: ${JSON.stringify(fine)}`);
  }
});
