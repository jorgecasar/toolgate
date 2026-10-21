// The /toolgate command in the agents, as `toolgate init` offers it. It goes through the same `bridgeCommands` as
// `toolgate commands bridge`, so the files are the same and a file that is not toolgate's is never overwritten.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMANDS_CAPABILITY } from "./adapters/commands.js";
import { bridgeCommands, bridgeState, formatBridge } from "./commands/bridge.js";
import { KNOWN_BRIDGE_SHA256 } from "./update/bridgeHistory.js";

const HINT = "to reach commands as /toolgate in your agent, run `toolgate commands bridge` (it never overwrites a file of yours)";
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const lines = (text) => text.split("\n").map((line) => line.trim().replace(/^toolgate: /, "")).filter(Boolean);

/** Whether the bridge file is byte-identical to a text toolgate shipped before (so `toolgate update` refreshes it). */
function olderShipped(cwd, file, knownHashes) {
  try {
    return knownHashes.includes(sha256(fs.readFileSync(path.join(cwd, file), "utf8")));
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ cancelled: boolean }>} `cancelled` when Ctrl+C answered the question: nothing was written
 */
export async function offerBridge({ cwd, env, agents, yes, interactive, create = false, dryRun, ask, notes, done, onThisMachine, knownHashes = KNOWN_BRIDGE_SHA256 }) {
  const home = env.HOME ?? os.homedir();
  const offer = [];
  const kept = [];
  for (const { name } of agents) {
    const commands = COMMANDS_CAPABILITY[name];
    if (commands?.kind !== "nativeDir" || !commands.projectDirs[0]) continue;
    const { state, file } = bridgeState({ agent: name, base: cwd });
    if (state === "missing") offer.push(name);
    else if (state === "outdated" || state === "edited") {
      notes.push(olderShipped(cwd, file, knownHashes)
        ? `${file} is the /toolgate command of an older toolgate: run \`toolgate update\` to refresh it`
        : state === "outdated"
          ? `${file} is an outdated /toolgate command (toolgate wrote it and it was not changed by hand), so toolgate leaves it as it is (\`toolgate commands bridge --force\` regenerates it)`
          : `${file} was changed by hand, so toolgate leaves it as it is (\`toolgate commands bridge --force\` regenerates it)`);
      kept.push(name);
    } else if (state !== "current") kept.push(name);
  }
  let cancelled = false;
  let asked = true;
  if (offer.length > 0 && interactive && !yes && !create && !dryRun) {
    const reply = await ask(`Create the /toolgate command in your agents (${offer.join(", ")})? [Y/n] `);
    if (reply === null) {
      notes.push("cancelled at the question: the /toolgate command was not created");
      return { cancelled: true };
    }
    asked = !/^n(o)?$/i.test(reply.trim());
  }
  if (offer.length > 0 && asked) {
    const report = bridgeCommands({ projectDir: cwd, homeDir: home, agents: offer, dryRun });
    done.push(...lines(formatBridge(report, { dryRun })).map((line) => `/toolgate command: ${line}`));
    // From an npm script (npm install runs the setup) no agent is open yet: there is nothing to restart.
    if (report.written.length && !env.npm_lifecycle_event) notes.push(`${dryRun ? "after init writes it, " : ""}restart the agent or open a new session to see /toolgate`);
    if (report.written.length < offer.length) kept.push(...offer.filter((name) => !report.written.some((w) => w.agent === name)));
  } else if (offer.length > 0) kept.push(...offer);
  if (kept.length > 0) onThisMachine.push(HINT);
  // Codex reads commands from the home folder only, and init does not write the home folder.
  if (agents.some(({ name }) => name === "codex") && bridgeState({ agent: "codex", base: home, user: true }).state !== "current") {
    onThisMachine.push("codex reads /toolgate only from your home folder: run `toolgate commands bridge --user` (init does not write your home)");
  }
  return { cancelled };
}
