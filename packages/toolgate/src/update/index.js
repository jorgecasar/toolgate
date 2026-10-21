import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configLayerPaths, loadConfig } from "../config.js";
import { isIgnored, isTracked } from "../configFile.js";
import { askInTerminal, RULESYNC_HEADER, RULESYNC_RULE } from "../init.js";
import { printable } from "../assets/common.js";
import { readRuleText, ruleTemplateFile } from "../ruleText.js";
import { COMMANDS_CAPABILITY } from "../adapters/commands.js";
import { bridgeText, linkedPart } from "../commands/bridge.js";
import { KNOWN_BRIDGE_SHA256 } from "./bridgeHistory.js";
import { KNOWN_RULE_SHA256 } from "./ruleHistory.js";
import { migrateProxyEnv } from "./proxyEnv.js";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// Replaced through a new temporary file in the same folder ("wx": it never opens something that already exists, nor
// follows a link planted at that name), so a crash never leaves half a rule.
// `beforeRename`, when given, is asked right before the rename (after the temporary file is complete) and may say no: the file the new one
// would replace was changed by someone else meanwhile, so nothing is replaced and the function returns false.
function replaceFile(file, text, { beforeRename } = {}) {
  const tmp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  // The replacement keeps the mode of the file it replaces (a rule the user made 0600 stays 0600).
  const mode = fs.lstatSync(file, { throwIfNoEntry: false })?.mode;
  // Created with the mode of the file it replaces (0600 when there is none) from the start, so that what it holds is never readable by more
  // than the original was, not even for the moment between the write and the chmod.
  const fd = fs.openSync(tmp, "wx", mode === undefined ? 0o600 : mode & 0o7777);
  try {
    try {
      fs.writeSync(fd, text);
      if (mode !== undefined) fs.fchmodSync(fd, mode & 0o7777);
    } finally {
      fs.closeSync(fd);
    }
    if (beforeRename && !beforeRename()) {
      fs.rmSync(tmp, { force: true });
      return false;
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    // What this call made goes if it could not be finished: the old file stays, and no `.tmp` is left beside it.
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
// The rule is written only where it really is: neither the file nor a folder above it may be a link, so a cloned
// repository cannot make update write outside the project.
function staysInside(cwd, file, rel = RULESYNC_RULE) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
    return fs.realpathSync(path.dirname(file)) === path.join(fs.realpathSync(cwd), path.dirname(rel));
  } catch {
    return false;
  }
}

/**
 * The migrations `toolgate update` runs: ordered, idempotent, read-only in `detect`. `detect` returns the status and
 * the text to write, if any; `apply` writes it.
 */
const MIGRATIONS = [
  {
    id: "rule-file-refresh",
    describe: `${RULESYNC_RULE}: the Step 0 rule of this version`,
    what: "the Step 0 rule",
    after: "; run `rulesync generate` so the agents get it",
    detect({ cwd, template, knownHashes }) {
      const file = path.join(cwd, RULESYNC_RULE);
      if (!fs.existsSync(file)) return { status: "absent", note: `${RULESYNC_RULE} does not exist: run \`toolgate init\` to write it` };
      const wanted = RULESYNC_HEADER + template;
      const current = fs.readFileSync(file, "utf8");
      if (current === wanted) return { status: "current" };
      if (knownHashes.includes(sha256(current))) {
        if (!staysInside(cwd, file)) return { status: "skipped", note: `${RULESYNC_RULE} (or a folder above it) is a link or leads outside this project, so it was not changed` };
        return { status: "stale", file, text: wanted };
      }
      return { status: "edited", note: `${RULESYNC_RULE} differs from every text toolgate has shipped, so it is yours and stays as it is; compare it with the template and merge by hand` };
    },
  },
  // One per agent that reads project commands: the /toolgate file `toolgate commands bridge` writes. A file that is absent
  // is not reported (most projects have none); one that is not byte-identical to a text toolgate shipped is the user's.
  ...Object.entries(COMMANDS_CAPABILITY)
    .filter(([, commands]) => commands.kind === "nativeDir" && commands.projectDirs[0])
    .map(([agent, commands]) => {
      const rel = `${commands.projectDirs[0]}/toolgate.md`;
      return {
        id: `bridge-refresh:${agent}`,
        what: "the /toolgate command",
        after: "; open a new session of the agent to see it",
        detect({ cwd, knownBridgeHashes }) {
          const file = path.join(cwd, rel);
          const info = fs.lstatSync(file, { throwIfNoEntry: false });
          if (!info) return { status: "absent", silent: true };
          if (info.isSymbolicLink() || !info.isFile() || linkedPart(cwd, commands.projectDirs[0]) || !staysInside(cwd, file, rel)) return { status: "skipped", note: `${rel} (or a folder above it) is a link or not a file, so it was not changed` };
          const current = fs.readFileSync(file, "utf8");
          if (current === bridgeText()) return { status: "current" };
          if (knownBridgeHashes.includes(sha256(current))) return { status: "stale", file, text: bridgeText() };
          return { status: "edited", note: `${rel} differs from every text toolgate has shipped, so it is yours and stays as it is (\`toolgate commands bridge --force\` regenerates it)` };
        },
      };
    }),
];

/**
 * `toolgate update`: runs the migrations the installed version needs. It does not update the package.
 * A versioned (git-tracked) file changes only with `--yes` or an answer in a terminal; `.toolgate/config.json` is never touched.
 * @param {{ cwd: string, env?: object, dryRun?: boolean, yes?: boolean, json?: boolean, stdout?: {write: Function}, ask?: Function, isTrackedFn?: Function, knownHashes?: string[], knownBridgeHashes?: string[], interactive?: boolean }} options
 */
export async function runUpdate({ cwd, env = process.env, dryRun = false, yes = false, json = false, stdout = process.stdout, ask = askInTerminal, isTrackedFn = isTracked, isIgnoredFn = isIgnored, homedir = env.HOME || os.homedir(), knownHashes = KNOWN_RULE_SHA256, knownBridgeHashes = KNOWN_BRIDGE_SHA256, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) }) {
  const config = loadConfig(configLayerPaths({ cwd, env }));
  let template;
  try {
    template = readRuleText(ruleTemplateFile(config, cwd));
  } catch {
    stdout.write("toolgate update: rule.template is not a readable file. Nothing was changed.\n");
    return 1;
  }
  const results = [];
  let failed = false;
  for (const migration of MIGRATIONS) {
    const found = migration.detect({ cwd, template, knownHashes, knownBridgeHashes });
    if (found.silent) continue;
    const entry = { id: migration.id, status: found.status };
    if (found.note) entry.note = found.note;
    if (found.status === "stale") {
      const shown = path.relative(cwd, found.file);
      const versioned = isTrackedFn(found.file);
      if (dryRun) {
        entry.status = "would-replace";
        entry.note = `would replace ${shown}, which matches an older text of toolgate${versioned ? " (git versions this file: it needs --yes or an answer in a terminal)" : ""}`;
      } else if (versioned && !yes && !(interactive && /^y(es)?$/i.test(String((await ask(`${shown} is versioned by git. Replace it with this version's ${migration.what}? [y/N] `)) ?? "").trim()))) {
        entry.status = "skipped";
        entry.note = `${shown} is versioned by git and was not changed: run \`toolgate update --yes\` to replace it`;
      } else {
        try {
          replaceFile(found.file, found.text);
          entry.status = "replaced";
          entry.note = `replaced ${shown}: it was an older text of toolgate that you had not edited${migration.after}${versioned ? "; git versions it, so commit the change" : ""}`;
        } catch (err) {
          failed = true;
          entry.status = "failed";
          entry.note = `${shown} could not be replaced (${printable(err.message.split("\n")[0])})`;
        }
      }
    }
    results.push(entry);
  }
  // The proxy's environment names: in every MCP file of the agent, the wrapped entries' old keys are renamed.
  const proxyEnv = await migrateProxyEnv({ cwd, homedir, dryRun, yes, interactive, ask, isTrackedFn, isIgnoredFn, replaceFile });
  results.push(...proxyEnv.entries);
  if (proxyEnv.failed) failed = true;
  if (json) stdout.write(`${JSON.stringify({ dryRun, migrations: results, renames: proxyEnv.renames }, null, 2)}\n`);
  else {
    for (const r of results) stdout.write(`${r.id}: ${r.status}${r.note ? ` - ${r.note}` : ""}\n`);
    if (results.every((r) => r.status === "current")) stdout.write("nothing to update\n");
  }
  return failed ? 1 : 0;
}
