// `toolgate init`: sets a project up to use toolgate. Safe to re-run: an existing file is never
// overwritten (it is reported as kept), and every step says what it did.
import fs from "node:fs";
import path from "node:path";
import { configLayerPaths, loadConfig } from "./config.js";
import { editConfigFile, isIgnored, isTracked, readConfigFile, restoreHint, trackedAndMissing, validPort } from "./configFile.js";
import { daemonStatus, defaultExec, ensureDaemon, heldMessage, managedPort, nextFreePort, portHolder, qmdBinOf, remoteQmdOrigin } from "./daemon.js";
import { defaultRegistry } from "./adapters/index.js";
import { detectAgents, formatAgentLine, listAgents } from "./agentReport.js";
import { offerBridge } from "./initBridge.js";
import { deleteWarning, ensureRoot, generatedIgnores, linkedRulesyncDir, rewriteWarning, targetChoices } from "./rulesyncSetup.js";
import { appendIgnored } from "./gitignore.js";
import { LOCAL_IGNORED } from "./skills/install.js";
import { describeCount, runSkills, settings as skillsSettings } from "./skills/cli.js";
import { scanIndexable } from "./skills/collection.js";
import { printable } from "./assets/common.js";
import { readRuleText, ruleTemplateFile } from "./ruleText.js";
import { ignoredWarnings } from "./router.js";
import { loadRecommendations, recommendationStatus, reviewedSkills } from "./skills/recommended.js";
import { LOCK_FILE, readLock } from "./skills/install.js";


// Rulesync reads this header.
export const RULESYNC_HEADER =
  '---\ntargets: ["*"]\ndescription: "Step 0: consult the Toolgate router before improvising any workflow"\n---\n\n';

// Patterns toolgate generates or keeps local; none of them belongs in version control.
const IGNORED = [".toolgate/config.local.json", ".toolgate/state.json", ".toolgate/skills-index/", ...LOCAL_IGNORED, ".qmd/"];

const exists = (file) => fs.existsSync(file);

function qmdAvailable(execFn, qmdBin = "qmd") {
  try {
    execFn(qmdBin, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the project already has, without asking.
 * @returns {{ git: boolean, qmd: boolean, rulesync: boolean, config: boolean, skillDirs: string[] }}
 */
export function detect({ cwd, execFn = defaultExec, qmdBin }) {
  return {
    git: exists(path.join(cwd, ".git")),
    qmd: qmdAvailable(execFn, qmdBin),
    rulesync: exists(path.join(cwd, ".rulesync")),
    config: exists(path.join(cwd, ".toolgate", "config.json")),
    skillDirs: skillDirsOf(cwd),
  };
}

const skillDirsOf = (cwd) => [path.join(".rulesync", "skills"), path.join(".toolgate", "skills")].filter((dir) => exists(path.join(cwd, dir)));

// Writes a file only when it is missing. Returns what happened, for the summary.
function writeNew(file, content, cwd, dryRun = false) {
  const shown = path.relative(cwd, file);
  if (exists(file)) {
    if (fs.readFileSync(file, "utf8") === content) return `unchanged ${shown}`;
    return dryRun ? `would keep ${shown} (exists and differs)` : `kept ${shown} (already exists and differs)`;
  }
  if (dryRun) return `would create ${shown}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return `created ${shown}`;
}

// The Step 0 rule always goes to rulesync's folder, so that `rulesync generate` is the single writer of the files
// each agent reads, and which agents get one is rulesync's `targets`, decided by a flag, never by what is installed here.
export const RULESYNC_RULE = path.join(".rulesync", "rules", "toolgate-router.md");
const RULESYNC_CONFIG = "rulesync.jsonc";
const RULESYNC_SCHEMA = "https://github.com/dyoshikawa/rulesync/releases/latest/download/config-schema.json";
// Where earlier versions of `init` wrote the rule themselves, one file per detected agent.
const OLD_RULE_FILES = [path.join(".claude", "rules", "toolgate-router.md"), "AGENTS.md", path.join(".agents", "rules", "toolgate-router.md")];

/** The ids of a `--targets a,b` value, or null when one is not shaped like a rulesync target. */
export function parseTargets(value) {
  const ids = String(value).split(",").map((id) => id.trim());
  return ids.length > 0 && ids.every((id) => id === "*" || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) ? [...new Set(ids)] : null;
}

// `rulesync.jsonc` belongs to the user (comments, trailing commas): it is created when missing and never rewritten.
// Targets that are not in it are printed, not added.
function reconcileRulesyncConfig({ cwd, targets, notes, dryRun }) {
  const file = path.join(cwd, RULESYNC_CONFIG);
  if (!exists(file)) {
    const wanted = targets;
    const content = `${JSON.stringify({ $schema: RULESYNC_SCHEMA, targets: wanted, features: ["rules"] }, null, 2)}\n`;
    return { line: writeNew(file, content, cwd, dryRun) + ` (targets: ${wanted.join(", ")})`, created: true };
  }
  const listed = /"targets"\s*:\s*\[([^\]]*)\]/.exec(fs.readFileSync(file, "utf8"));
  const have = listed ? [...listed[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : null;
  if (targets && have && !have.includes("*")) {
    const missing = targets.filter((id) => !have.includes(id));
    if (missing.length) notes.push(`${RULESYNC_CONFIG} does not list ${missing.join(", ")}: add ${missing.map((id) => `"${id}"`).join(", ")} to its "targets" (init does not edit this file)`);
  }
  return { line: `${dryRun ? "would keep" : "kept"} ${RULESYNC_CONFIG}${have ? ` (targets: ${have.join(", ")})` : ""}`, created: false };
}

// The targets an existing `rulesync.jsonc` lists, or null (no file, no list, or ids that are not shaped like targets).
// The file is the answer then, so `init` does not ask which agents rulesync writes for.
function configuredTargets(cwd) {
  const file = path.join(cwd, RULESYNC_CONFIG);
  if (!exists(file)) return null;
  const listed = /"targets"\s*:\s*\[([^\]]*)\]/.exec(fs.readFileSync(file, "utf8"));
  const ids = listed ? [...listed[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : [];
  return ids.length > 0 ? parseTargets(ids.join(",")) : null;
}

// A rule an earlier `init` wrote straight into an agent's folder is left alone; rulesync is the one that writes those now.
function oldRuleNotes({ cwd, template, notes, isIgnoredFn }) {
  for (const rel of OLD_RULE_FILES) {
    const file = path.join(cwd, rel);
    // A file git ignores is what `rulesync generate` wrote, not a rule an earlier init left behind.
    if (exists(file) && fs.readFileSync(file, "utf8") === template && !isIgnoredFn(file)) {
      notes.push(`${rel} was written by an earlier \`toolgate init\`; \`rulesync generate\` writes it now for the targets you chose, so delete it if it is not one of them`);
    }
  }
}

// A config that exists is never rewritten, but `init` says what it would have set that the file lacks, and when the file
// disagrees with a flag the user gave (the flag does not win over an existing file).
function reconcileConfig({ file, wanted, flagged, notes }) {
  let data;
  try {
    data = readConfigFile(file).data;
  } catch {
    return;
  }
  const have = data.router?.backend;
  if (have === undefined) {
    notes.push(`missing managed key router.backend (init would set "${wanted}"); add it with: toolgate config set router.backend ${wanted}`);
  } else if (flagged !== undefined && have !== flagged) {
    notes.push(`the config says router.backend "${have}"; --backend ${flagged} was not applied (change it with: toolgate config set router.backend ${flagged})`);
  }
}

const QMD_INSTALL = ["install", "-g", "@tobilu/qmd"];
const QMD_COMMAND = `npm ${QMD_INSTALL.join(" ")}`;
const RULESYNC_INSTALL = ["install", "-g", "rulesync"];
const RULESYNC_COMMAND = `npm ${RULESYNC_INSTALL.join(" ")}`;

// The backend an existing project config already chose (a config that cannot be read says nothing).
function existingBackend(cwd) {
  try {
    const value = readConfigFile(path.join(cwd, ".toolgate", "config.json")).data.router?.backend;
    return value === "qmd" || value === "regex" ? value : null;
  } catch {
    return null;
  }
}

// qmd is what the default backend searches with. `found.qmd` is a probe through the PATH, where the copy that comes with
// toolgate already is, so a missing qmd means there is no usable one. Installing it is a global npm install: only after an
// explicit yes (the answer, --yes or --install-qmd), never in CI or without a terminal unless one of those is given, and a
// failure is a note, not an error.
async function ensureQmd({ backend, installQmd, yes, interactive, ask, execFn, qmdBin, nodeMajor, found, notes, done, dryRun }) {
  if (backend !== "qmd") return { available: false, cancelled: false };
  if (found.qmd) return { available: true, cancelled: false };
  const missing = `qmd was not found, so skills are searched by keywords only until it is installed (\`${QMD_COMMAND}\`)`;
  if (nodeMajor < 22) {
    notes.push(`${missing}; it needs Node 22 or newer and this is Node ${nodeMajor}`);
    return { available: false, cancelled: false };
  }
  let install = installQmd || yes;
  if (!install && interactive) {
    const reply = await ask(`qmd was not found. Install it now with: ${QMD_COMMAND} ? [y/N] `);
    if (reply === null) {
      notes.push("cancelled at the question: qmd was not installed");
      return { available: false, cancelled: true };
    }
    install = /^y(es)?$/i.test(reply.trim());
  }
  if (!install) {
    notes.push(missing);
    return { available: false, cancelled: false };
  }
  if (dryRun) {
    done.push(`would install qmd (${QMD_COMMAND})`);
    return { available: true, cancelled: false };
  }
  try {
    execFn("npm", QMD_INSTALL, { timeout: 120000 });
  } catch (err) {
    notes.push(`could not install qmd (${printable(String(err.stderr || err.message).trim().split("\n")[0])}); run it yourself: ${QMD_COMMAND}`);
    return { available: false, cancelled: false };
  }
  if (!qmdAvailable(execFn, qmdBin)) {
    notes.push(`${QMD_COMMAND} finished but qmd is still not on the PATH: open a new shell, or check where npm puts global programs`);
    return { available: false, cancelled: false };
  }
  done.push(`installed qmd (${QMD_COMMAND})`);
  return { available: true, cancelled: false };
}

// rulesync is what writes the agents' files from `.rulesync/`. It is wanted when the project has its config or the user chose
// targets (or passed --install-rulesync); then a missing one is offered a global npm install, like qmd: only after an explicit
// yes (the answer, --yes or --install-rulesync), never in CI or without a terminal unless one of those is given, and a
// failure is a note, not an error.
function rulesyncAvailable(execFn) {
  try {
    execFn("rulesync", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function ensureRulesync({ wanted, installRulesync, yes, interactive, ask, execFn, onThisMachine, notes, done, dryRun }) {
  if (rulesyncAvailable(execFn)) return { cancelled: false };
  const missing = `rulesync is not installed (\`${RULESYNC_COMMAND}\`), so nothing can generate the agents' files yet`;
  if (!wanted && !installRulesync) {
    onThisMachine.push(missing);
    return { cancelled: false };
  }
  let install = installRulesync || yes;
  if (!install && interactive) {
    const reply = await ask(`rulesync was not found. Install it now with: ${RULESYNC_COMMAND} ? [y/N] `);
    if (reply === null) {
      notes.push("cancelled at the question: rulesync was not installed");
      return { cancelled: true };
    }
    install = /^y(es)?$/i.test(reply.trim());
  }
  if (!install) {
    onThisMachine.push(missing);
    return { cancelled: false };
  }
  if (dryRun) {
    done.push(`would install rulesync (${RULESYNC_COMMAND})`);
    return { cancelled: false };
  }
  try {
    execFn("npm", RULESYNC_INSTALL, { timeout: 120000 });
  } catch (err) {
    notes.push(`could not install rulesync (${printable(String(err.stderr || err.message).trim().split("\n")[0])}); run it yourself: ${RULESYNC_COMMAND}`);
    return { cancelled: false };
  }
  if (!rulesyncAvailable(execFn)) {
    notes.push(`${RULESYNC_COMMAND} finished but rulesync is still not on the PATH: open a new shell, or check where npm puts global programs`);
    return { cancelled: false };
  }
  done.push(`installed rulesync (${RULESYNC_COMMAND})`);
  return { cancelled: false };
}

function updateGitignore(cwd, dryRun = false) {
  const { created, added } = appendIgnored(cwd, IGNORED, { header: "# toolgate", dryRun });
  return added === 0 ? ".gitignore already lists the toolgate files" : `${dryRun ? "would " : ""}${created ? (dryRun ? "create" : "created") : dryRun ? "update" : "updated"} .gitignore (+${added})`;
}

// `input` and `output` are the terminal's; a test hands in streams.
// `onEnd` is what closing the input answers; the default is "" (the convention), a question where silence must not mean yes passes null.
export async function askInTerminal(question, { input = process.stdin, output = process.stdout, terminal, onEnd = "" } = {}) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input, output, terminal });
  try {
    // Closing the input (Ctrl+D, a pipe) answers "nothing" instead of waiting forever; Ctrl+C is a
    // cancel (null), which the caller tells apart from an empty answer.
    return await Promise.race([
      rl.question(question),
      new Promise((resolve) => rl.once("SIGINT", () => resolve(null))),
      new Promise((resolve) => rl.once("close", () => resolve(onEnd))),
    ]);
  } finally {
    rl.close();
  }
}

// The layer that already sets `defaultAgent`, local over project over user as the config merges them.
function existingAgent(cwd, env) {
  for (const layer of [...configLayerPaths({ cwd, env })].reverse()) {
    try {
      const value = readConfigFile(layer.path).data.defaultAgent;
      if (typeof value === "string" && value !== "") return { name: value, layer: layer.name };
    } catch {
      // A config that cannot be read is reported by `doctor`; it does not stop init.
    }
  }
  return null;
}

// Asks (or is told with --agent) which agent `toolgate "<prompt>"` launches by default. A value the user set in their own
// layers (local, user) is never replaced or asked again. One that comes from the project's config is the team's: in a terminal
// the user is asked whether to change it (Enter keeps it), and --agent changes it. Nothing is written without a terminal or an
// explicit --agent; and it goes to the local layer (a personal choice, which overrides the project's), or the user's with
// --user, never to the project's.
async function chooseAgent({ cwd, env, agent, user, yes, interactive, ask, stdout, registry, detected, notes, notices, done, dryRun }) {
  const names = registry.names();
  const layer = user ? "user" : "local";
  const current = existingAgent(cwd, env);
  const fromProject = current?.layer === "project";
  if (current && !fromProject) {
    notices.push(`default agent: ${printable(current.name)} (from the ${current.layer} config); change it with \`toolgate config set defaultAgent <name>\``);
    if (agent !== undefined && agent !== current.name) notices.push(`--agent ${printable(agent)} was not applied: a default agent is already set`);
    return { cancelled: false };
  }
  const write = (name) => {
    const file = configLayerPaths({ cwd, env }).find((entry) => entry.name === layer).path;
    if (!dryRun) editConfigFile(file, { action: "set", key: "defaultAgent", value: name, layer });
    const relative = path.relative(cwd, file);
    done.push(`${dryRun ? "would set" : "set"} defaultAgent ${name} in the ${layer} config (${relative.startsWith("..") ? file : relative})${fromProject ? `, over the project's ${printable(current.name)}` : ""}`);
  };
  const command = `toolgate config set defaultAgent <name>${user ? " --user" : " --local"}`;
  const keepProject = () => notices.push(`default agent: ${printable(current.name)} (from the project config); change it with \`${command}\``);
  if (agent !== undefined) {
    if (fromProject && agent === current.name) keepProject();
    else write(agent);
    return { cancelled: false };
  }
  const list = listAgents(names, detected);
  // The proposed default is the project's, else the first installed agent in AGENT_ORDER.
  const first = fromProject ? current.name : (list.find((entry) => entry.status === "installed")?.name ?? null);
  const mark = fromProject ? "project default" : "default";
  const lines = list.map((entry, i) => `  ${i + 1}. ${entry.name}  (${entry.status}${entry.tier === undefined ? "" : `, tier ${entry.tier}`})${entry.name === first ? `  <- ${mark}` : ""}`);
  // With a single installed agent and no project default there is nothing to choose: it is set without asking.
  const onlyOne = !fromProject && list.filter((entry) => entry.status === "installed").length === 1;
  if (yes || !interactive || onlyOne) {
    if (fromProject) {
      keepProject();
    } else if (first) {
      write(first);
      notes.push(`agents:\n${lines.join("\n")}\nthe first installed one is the default; change it with \`${command}\`; then \`toolgate "<prompt>"\` opens it, and \`toolgate --yes "<prompt>"\` runs it and prints the result`);
    } else {
      notes.push(`no agent was found installed, so no default is set and \`toolgate "<prompt>"\` needs --adapter; agents:\n${lines.join("\n")}\nrun \`${command}\``);
    }
    return { cancelled: false };
  }
  const options = list.map((entry) => entry.name);
  stdout.write(`\nDefault agent for \`toolgate "<prompt>"\` ${fromProject ? "(the project sets one; pick another to override it for you)" : "(most used first)"}:\n`);
  stdout.write(`${lines.join("\n")}\n`);
  const reply = await ask(`Default agent? (number or name, Enter to ${first ? `${fromProject ? "keep" : "use"} ${first}` : "skip"}): `);
  if (reply === null) {
    notes.push(fromProject ? "cancelled at the question: the default agent was not changed" : "cancelled at the question: no default agent was set");
    return { cancelled: true };
  }
  const answer = reply.trim();
  const picked = answer === "" ? first : /^[1-9]\d*$/.test(answer) ? options[Number(answer) - 1] : options.find((name) => name === answer);
  if (picked && fromProject && picked === current.name) keepProject();
  else if (picked) {
    write(picked);
    if (list.find((entry) => entry.name === picked).status === "not installed") notes.push(`${picked} is not installed here; launching it will fail until it is`);
  } else if (answer !== "") notes.push(`ignored "${printable(answer)}": not an agent of the list; run \`${command}\``);
  return { cancelled: false };
}

// Recommended skills are only ever installed on an explicit request: a flag naming them, or an
// answer to the question. `--yes`, CI and a non-terminal install nothing and say how to look. The bare
// flag means the shipped, reviewed list: an entry from a project's config is installed only when
// named, or picked in the prompt, where it is marked.
async function chooseRecommended({ cwd, env, allowFile, installRecommended, yes, interactive, ask, config, stdout, notes }) {
  let entries;
  try {
    entries = loadRecommendations(config?.skills?.recommended, undefined, { allowFile, projectDir: cwd, env, warn: (message) => notes.push(message) });
  } catch (err) {
    notes.push(`recommended skills unavailable: ${printable(err.message)}`);
    return [];
  }
  if (entries.length === 0) return [];
  const known = entries.map((entry) => entry.id);
  if (installRecommended !== undefined) {
    if (installRecommended !== true && installRecommended.length === 0) notes.push("--install-recommended= names no source: nothing was installed (see: toolgate skills recommended)");
    const wanted = installRecommended === true ? entries.filter((entry) => entry.layer === "shipped").map((entry) => entry.id) : installRecommended;
    const unknown = wanted.filter((id) => !known.includes(id));
    if (unknown.length) notes.push(`not recommended sources: ${unknown.map(printable).join(", ")} (see: toolgate skills recommended)`);
    if (installRecommended === true && wanted.length === 0) notes.push("no shipped recommendation to install; name one from your config with --install-recommended=<id>");
    return wanted.filter((id) => known.includes(id));
  }
  // What the project already has comes from its lock, as `toolgate skills recommended` reads it.
  let lock = { skills: {} };
  try {
    lock = readLock(path.join(cwd, LOCK_FILE));
  } catch {
    // An unreadable lock is reported by `doctor`; here every source is simply offered.
  }
  const pending = entries.filter((entry) => recommendationStatus(entry, lock).state !== "installed");
  if (pending.length === 0) return [];
  if (yes || !interactive) {
    notes.push(`recommended skills are available but not installed${pending.length < entries.length ? ` (${pending.map((entry) => printable(entry.id)).join(", ")})` : ""}: see \`toolgate skills recommended\``);
    return [];
  }
  stdout.write("\nRecommended skill sources (nothing is installed unless you choose):\n");
  entries = pending;
  entries.forEach((entry, i) => {
    // The origin comes first, before anything the entry wrote itself, and every field is one line of plain
    // text: an entry from a project's config cannot hide that it is one, or look like a shipped one.
    const origin = entry.layer === "shipped" ? "" : `[${printable(entry.layer ?? "unknown origin")} config] `;
    stdout.write(`  ${i + 1}. ${origin}${printable(entry.id)}  ${printable(entry.source)}@${printable(entry.commit.slice(0, 7))}  ${printable(entry.license)}  ${reviewedSkills(entry).length} skills\n`);
  });
  const reply = await ask("Install which? (numbers separated by commas, Enter for none): ");
  if (reply === null) {
    notes.push("cancelled at the question: no recommended skills were installed");
    return { chosen: [], cancelled: true };
  }
  const answer = reply.trim();
  if (answer === "") return [];
  const parts = answer.split(",").map((part) => part.trim());
  // Plain numbers only: Number() would take "0x1" or "1e0" for a position.
  const pick = (part) => (/^[1-9]\d*$/.test(part) ? entries[Number(part) - 1] : undefined);
  const invalid = parts.filter((part) => !pick(part));
  if (invalid.length) notes.push(`ignored ${invalid.map((part) => `"${printable(part)}"`).join(", ")}: not a number from the list`);
  return [...new Set(parts.map((part) => pick(part)?.id).filter(Boolean))];
}

// Installs each chosen recommendation through the same command a user would run and returns one
// summary line per recommendation.
function installChosen(chosen, { cwd, config, env, install, skillsDeps, dryRun }) {
  // A dry run reaches no network and writes no skill: it only says what it would install.
  if (dryRun) return { lines: chosen.map((id) => `would install recommended:${printable(id)}`), failed: [] };
  const failed = [];
  const lines = chosen.map((id) => {
    const lines = [];
    // One entry per line of output, so that printing each one escaped cannot swallow a real line break.
    const collect = { write: (s) => lines.push(...s.split("\n").map((line) => line.trim().replace(/^toolgate: /, "")).filter(Boolean)) };
    const code = runSkills(["install", `recommended:${id}`], { cwd, config, env, json: false, force: false, stdout: collect, stderr: collect, install, deps: skillsDeps });
    if (code !== 0) failed.push(id);
    return code === 0 ? lines.map(printable).join(" ") : `recommended ${printable(id)} failed: ${lines.map(printable).join(" ")}`;
  });
  return { lines, failed };
}

// rulesync is the default way to write the agents' files, also with --yes. The question is asked only in a terminal, in a
// project that does not use it yet; "no" writes the rule where each agent reads it instead.
async function chooseRulesync({ cwd, found, targetIds, signals, yes, interactive, ask, stdout, notes }) {
  if (targetIds || found.rulesync || exists(path.join(cwd, RULESYNC_CONFIG))) return { use: true };
  // With no agent installed and no agent file there is nothing to choose between: no question.
  if (yes || !interactive || !signals) {
    if (yes) stdout.write("rulesync: yes (default)\n");
    return { use: true };
  }
  const reply = await ask("Write the agents' files with rulesync (one source for every agent)? [Y/n] ");
  if (reply === null) {
    notes.push("cancelled at the question: rulesync was not set up");
    return { use: true, cancelled: true };
  }
  return { use: !/^n(o)?$/i.test(reply.trim()) };
}

// The targets are the agents installed here plus the ones whose file the project has. Enter takes them; a list of numbers
// or ids replaces them. An explicit --targets wins and asks nothing.
async function chooseTargets({ choices, explicit, yes, interactive, ask, stdout, notes, done }) {
  if (explicit) return { targets: explicit };
  const marked = choices.filter(({ reasons }) => reasons.length);
  const fromChoices = (list) => list.map(({ target }) => target);
  const show = (entry) => `${entry.target}  [${entry.reasons.length ? entry.reasons.join(", ") : "not installed"}]`;
  if (yes || !interactive || marked.length === 0) {
    if (marked.length) done.push(`rulesync targets: ${marked.map(show).join("; ")}`);
    return { targets: fromChoices(marked) };
  }
  stdout.write("\nAgents rulesync will write for (marked: installed here, or their file is in the project):\n");
  choices.forEach((entry, i) => stdout.write(`  ${i + 1}. ${marked.includes(entry) ? "*" : " "} ${show(entry)}\n`));
  const reply = await ask(`Targets? (numbers separated by commas, Enter for ${marked.length ? "the marked" : "none"}): `);
  if (reply === null) {
    notes.push("cancelled at the question: rulesync was not set up");
    return { targets: [], cancelled: true };
  }
  const answer = reply.trim();
  if (answer === "") return { targets: fromChoices(marked) };
  const parts = answer.split(",").map((part) => part.trim());
  const pick = (part) => (/^[1-9]\d*$/.test(part) ? choices[Number(part) - 1] : choices.find(({ target }) => target === part));
  const invalid = parts.filter((part) => !pick(part));
  if (invalid.length) notes.push(`ignored ${invalid.map((part) => `"${printable(part)}"`).join(", ")}: not a number or target of the list`);
  return { targets: [...new Set(parts.map((part) => pick(part)?.target).filter(Boolean))] };
}

// Without rulesync the rule goes to the file each marked agent reads, as that agent's adapter says. A file that exists is kept.
async function placeNatively({ cwd, choices, registry, template, notes, done, dryRun }) {
  const seen = new Set();
  for (const { agent } of choices) {
    const place = (await registry.get(agent)).installDiscovery?.({ cwd, template });
    if (!place?.file || seen.has(place.file)) continue;
    seen.add(place.file);
    const result = writeNew(place.file, place.content, cwd, dryRun);
    done.push(result);
    if (/^(kept|would keep)/.test(result)) notes.push(`${path.relative(cwd, place.file)} exists and toolgate does not edit it: add the Step 0 rule to it yourself (the text is in the rule template)`);
  }
  if (seen.size === 0) notes.push("no agent was found, so no rule was written; run `toolgate init --agent <name>` or `--targets <ids>`");
}

/**
 * The port init starts the daemon on. When the resolved port is free or held by a daemon toolgate started, it is that port
 * and nothing is written. When a process toolgate did not start holds it, the next free port from 8182 is offered (asked in
 * a terminal, taken at once with --yes), saved as `qmd.port` in the user config, and the daemon starts there. Without a
 * terminal and without --yes, or on "no", nothing is written or started and a note says how to do it. With --dry-run it
 * only says what it would do. A holder whose pid cannot be told, or no free port in 8182-8281, is only a note.
 * The foreign process is never touched.
 * @returns {Promise<{ port: number, start: boolean, saved: boolean, override?: boolean }>}
 */
/**
 * Where the managed port was set when it beats the user's `qmd.port` (decision 3): a local, parseable router.qmdUrl, then QMD_SHARED_PORT,
 * then `qmd.port` in an unversioned local config (it wins over the user layer); else null (the user layer is not an override).
 */
function portOverride(config, env, cwd) {
  if (typeof config?.router?.qmdUrl === "string" && managedPort({ router: config.router }, {}) !== null) return "router.qmdUrl";
  if (Number(env.QMD_SHARED_PORT)) return "QMD_SHARED_PORT";
  const trusted = !config?.ignored?.some((entry) => entry.key === "qmd.port" && entry.layer === "local");
  const local = configLayerPaths({ cwd, env }).find((entry) => entry.name === "local");
  try {
    const port = local && trusted ? readConfigFile(local.path).data.qmd?.port : undefined;
    if (validPort(port) !== null) return "qmd.port in the local config";
  } catch {
    // A local config that cannot be read is reported by `doctor`; it is no override.
  }
  return null;
}

const DAEMON_OFF = "router.qmdUrl is null, so routing uses the qmd CLI";
const daemonRemote = (origin) => `router.qmdUrl points to ${printable(origin)}, which toolgate does not manage`;
async function resolveDaemonPort({ config, env, cwd, daemon, probePort, yes, interactive, ask, dryRun, stdout, notes, done }) {
  const port = managedPort(config, env) ?? managedPort({ qmd: config?.qmd }, env);
  const same = { port, start: true, saved: false };
  if (typeof daemon.holder !== "function") return same;
  const holder = daemon.holder(port) ?? { pid: null, foreign: null };
  if (holder.foreign !== true) {
    if (holder.pid === null && typeof daemon.status === "function" && (await daemon.status({ port })).running) notes.push(heldMessage(port, null));
    return same;
  }
  const free = await nextFreePort(8182, { probe: probePort });
  if (free === null) {
    notes.push(heldMessage(port, holder.pid));
    return same;
  }
  const override = portOverride(config, env, cwd);
  if (override) {
    const note = `toolgate: port ${port} comes from ${override} and is held by pid ${holder.pid}, which toolgate did not start; change it there (port ${free} is free)`;
    if (dryRun) done.push(`would leave this note: ${note}`);
    else notes.push(note);
    return { port, start: false, saved: false, override: true };
  }
  if (dryRun) {
    done.push(`would use port ${free} and save qmd.port in your user config`);
    return { port: free, start: false, saved: false };
  }
  const held = `toolgate: port ${port} is held by pid ${holder.pid}, which toolgate did not start; using ${free} and saving qmd.port in your user config\n`;
  let accepted = yes;
  if (!yes && interactive) {
    stdout.write(held);
    const reply = await ask(`use port ${free} and save it in your user config? [Y/n] `, { onEnd: null });
    accepted = reply !== null && !/^n(o)?$/i.test(reply.trim());
  } else if (yes) {
    stdout.write(held);
  }
  if (accepted) {
    try {
      const file = configLayerPaths({ cwd, env }).find((entry) => entry.name === "user").path;
      editConfigFile(file, { action: "set", key: "qmd.port", value: free, layer: "user" });
      return { port: free, start: true, saved: true };
    } catch (err) {
      notes.push(`could not save qmd.port in your user config (${printable(err.message.split("\n")[0])}); run "toolgate config set qmd.port ${free} --user" and "toolgate daemon start"`);
      return { port: free, start: false, saved: false };
    }
  }
  notes.push(`run "toolgate config set qmd.port ${free} --user" and "toolgate daemon start"`);
  return { port: free, start: false, saved: false };
}

/**
 * @param {Object} options
 * @param {string} options.cwd
 * @param {{ write: (s: string) => void }} options.stdout
 * @returns {Promise<number>} process exit code
 */
export async function runInit({
  cwd,
  env = process.env,
  stdout,
  execFn = defaultExec,
  daemon = { ensure: ensureDaemon, status: daemonStatus, holder: (daemonPort) => portHolder(daemonPort, { env }) },
  probePort,
  skillsDeps = {},
  registry,
  yes = false,
  installRecommended,
  agent,
  targets,
  backend,
  installQmd = false,
  installRulesync = false,
  bridge: createBridge = false,
  dryRun = false,
  force = false,
  nodeMajor = Number(process.versions.node.split(".")[0]),
  user = false,
  ask = askInTerminal,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  install = {},
  isTrackedFn = isTracked,
  isIgnoredFn = isIgnored,
  knownBridgeHashes,
}) {
  // The names `defaultAgent` accepts are the ones of the real registry (the same check as `config set`).
  const agentRegistry = defaultRegistry;
  // An agent that does not exist is refused before anything is written.
  if (agent !== undefined && !agentRegistry.names().includes(agent)) {
    stdout.write(`toolgate init: unknown agent ${JSON.stringify(printable(agent))}; use one of: ${agentRegistry.names().join(", ")}. Nothing was written.\n`);
    return 1;
  }
  const targetIds = targets === undefined ? undefined : parseTargets(targets.join(","));
  if (targets !== undefined && !targetIds) {
    stdout.write(`toolgate init: --targets takes rulesync target ids like claudecode,codexcli (or *), not ${JSON.stringify(printable(targets.join(",")))}. Nothing was written.\n`);
    return 1;
  }
  if (backend !== undefined && !["qmd", "regex"].includes(backend)) {
    stdout.write(`toolgate init: --backend is qmd or regex, not ${JSON.stringify(printable(backend))}. Nothing was written.\n`);
    return 1;
  }
  if (installQmd && backend === "regex") {
    stdout.write("toolgate init: --install-qmd and --backend regex contradict each other: the regex backend never uses qmd. Nothing was written.\n");
    return 1;
  }
  // Nothing is asked in a dry run: it describes what the same flags would do.
  if (dryRun) interactive = false;
  // `rule.template` and `qmd.bin` (user or local layer only, see untrustedReason) are read before anything runs.
  const ruleConfig = loadConfig(configLayerPaths({ cwd, env }));
  const qmdBin = qmdBinOf(ruleConfig);
  const found = detect({ cwd, execFn, qmdBin });
  const done = [];
  const notes = [];
  // What the user should know about rulesync, not something to do next.
  const notices = [];

  if (!found.git) notes.push("not a git repository: nothing here will be versioned until you run `git init`");
  // `rule.template` replaces the built-in Step 0 text; one that cannot be read stops init.
  // Every sensitive key a layer is not trusted with, in the words `need`, `route` and `doctor` use for it.
  for (const warning of ignoredWarnings(ruleConfig)) notes.push(printable(warning));
  const templateFile = ruleTemplateFile(ruleConfig, cwd);
  let template;
  try {
    template = readRuleText(templateFile);
  } catch {
    stdout.write(`toolgate init: rule.template ${JSON.stringify(printable(templateFile))} is not a readable file. Nothing was written.\n`);
    return 1;
  }

  // The backend is a choice of the flags (qmd by default), not a consequence of what is installed here.
  const wantedBackend = backend ?? "qmd";
  const config = JSON.stringify({ router: { backend: wantedBackend } }, null, 2) + "\n";
  const configFile = path.join(cwd, ".toolgate", "config.json");
  // A config that git tracks and the working tree lost is not replaced with a fresh one: it is restored, or forced.
  const configLost = !force && trackedAndMissing(configFile);
  if (configLost) done.push(`toolgate: ${restoreHint(configFile, cwd)}`);
  else {
    const existed = exists(configFile);
    done.push(writeNew(configFile, config, cwd, dryRun));
    if (existed) reconcileConfig({ file: configFile, wanted: wantedBackend, flagged: backend, notes });
  }

  const agents = await detectAgents({ execFn, registry });
  const choices = targetChoices({ cwd, installed: agents.map(({ name }) => name), registryNames: listAgents(agentRegistry.names(), agents).map(({ name }) => name) });
  const rulesync = await chooseRulesync({ cwd, found, targetIds, signals: choices.some(({ reasons }) => reasons.length), yes, interactive, ask, stdout, notes });
  if (rulesync.cancelled) interactive = false;
  const fromConfig = targetIds ? null : configuredTargets(cwd);
  if (rulesync.use && fromConfig) done.push(`rulesync targets: ${fromConfig.join(", ")} (from ${RULESYNC_CONFIG})`);
  const picked = rulesync.use ? await chooseTargets({ choices, explicit: targetIds ?? fromConfig, yes, interactive, ask, stdout, notes, done }) : null;
  if (picked?.cancelled) interactive = false;
  const wantedTargets = picked?.targets ?? [];
  if (!rulesync.use) {
    await placeNatively({ cwd, choices: choices.filter(({ reasons }) => reasons.length), registry: agentRegistry, template, notes, done, dryRun });
  } else {
    // Nothing chosen and no rulesync config yet: the router rule is still written, so a later `rulesync generate` finds it,
    // but rulesync is not activated (no config, no root, no ignore entries).
    const dormant = wantedTargets.length === 0 && !found.rulesync && !exists(path.join(cwd, RULESYNC_CONFIG));
    const linked = linkedRulesyncDir(cwd);
    const root = dormant ? { lines: [], notes: [], imported: [] } : ensureRoot({ cwd, dryRun });
    done.push(...root.lines);
    notes.push(...root.notes);
    const ruleFile = path.join(cwd, RULESYNC_RULE);
    const ruleResult = linked ? null : writeNew(ruleFile, RULESYNC_HEADER + template, cwd, dryRun);
    if (linked) notes.push(`${linked} is a link or not a folder, so the Step 0 rule was not written there`);
    else done.push(ruleResult);
    const rulesyncConfig = dormant ? { line: null, created: false } : reconcileRulesyncConfig({ cwd, targets: wantedTargets, notes, dryRun });
    if (rulesyncConfig.line) done.push(rulesyncConfig.line);
    if (dormant) notes.push(`no agent was found or chosen, so rulesync is not activated (no ${RULESYNC_CONFIG}); add one with \`toolgate init --targets claudecode\` (any rulesync target id), then run \`rulesync generate\``);
    const ignored = dormant ? { patterns: [], kept: [] } : generatedIgnores({ cwd, targets: wantedTargets, imported: root.imported, isTrackedFn, isIgnoredFn });
    if (ignored.patterns.length) {
      const { added } = appendIgnored(cwd, ignored.patterns, { header: "# generated by rulesync", dryRun });
      if (added) done.push(`${dryRun ? "would add" : "added"} ${added} generated file${added === 1 ? "" : "s"} to .gitignore: ${ignored.patterns.join(", ")}`);
    }
    if (ignored.kept.length) notes.push(`not added to .gitignore, because it exists or git tracks it: ${ignored.kept.join(", ")}`);
    for (const warning of dormant ? [] : [rewriteWarning({ cwd, targets: wantedTargets, isIgnoredFn }), deleteWarning(cwd)]) if (warning) notices.push(warning);
    // Only what was just written needs generating; an unchanged rule already reached the agents.
    if (ruleResult && !dormant && (/^(created|would create)/.test(ruleResult) || rulesyncConfig.created)) notes.push("run `rulesync generate` so the Step 0 rule reaches your agents");
    // A rule written before commands existed is kept as it is, so say how to get the item for them.
    if (ruleResult && /^(kept|would keep)/.test(ruleResult) && !/`commands` non-empty/.test(fs.readFileSync(ruleFile, "utf8"))) {
      notes.push(`${RULESYNC_RULE} predates commands: toolgate does not overwrite it; delete it and run \`toolgate init\` again, or add the \`commands\` item from the template`);
    }
    if (ruleResult && /^(kept|would keep)/.test(ruleResult) && !/in windows/.test(fs.readFileSync(ruleFile, "utf8"))) {
      notes.push(`${RULESYNC_RULE} predates the windowed reads and the \`toolgate skills search\` fallback: toolgate does not overwrite it; delete it and run \`toolgate init\` again to get them`);
    }
  }
  oldRuleNotes({ cwd, template, notes, isIgnoredFn });
  const onThisMachine = [];
  const wantsRulesync = rulesync.use && (wantedTargets.length > 0 || found.rulesync || exists(path.join(cwd, RULESYNC_CONFIG)));
  const rulesyncInstall = await ensureRulesync({ wanted: wantsRulesync, installRulesync, yes, interactive, ask, execFn, onThisMachine, notes, done, dryRun });
  if (rulesyncInstall.cancelled) interactive = false;

  done.push(updateGitignore(cwd, dryRun));

  const effectiveBackend = backend ?? existingBackend(cwd) ?? "qmd";
  const qmd = await ensureQmd({ backend: effectiveBackend, installQmd, yes, interactive, ask, execFn, qmdBin, nodeMajor, found, notes, done, dryRun });
  if (qmd.cancelled) interactive = false;

  // After the .gitignore, so that the local config the choice goes to is already ignored when it is created.
  const agentChoice = await chooseAgent({ cwd, env, agent, user, yes, interactive, ask, stdout, registry: agentRegistry, detected: agents, notes, notices, done, dryRun });
  if (agentChoice.cancelled) interactive = false;
  // The default is read after chooseAgent, so a run that has just set it is marked too, not only a re-run. Same style as the
  // first run's list, in the same fixed order.
  const defaultNow = existingAgent(cwd, env);
  const inOrder = defaultNow ? listAgents(agentRegistry.names(), agents).filter((entry) => entry.status === "installed").map((entry) => agents.find(({ name }) => name === entry.name)) : agents;
  for (const agent of inOrder) onThisMachine.push(`${formatAgentLine(agent)}${defaultNow?.name === agent.name ? "  <- default" : ""}`);
  if (defaultNow && !agents.some(({ name }) => name === defaultNow.name)) {
    onThisMachine.push(`${printable(defaultNow.name)}  <- default, but ${agentRegistry.names().includes(defaultNow.name) ? "not installed here" : "not an agent toolgate knows"}`);
  }
  // The /toolgate command is offered for the installed agents; a file that is not toolgate's is never overwritten.
  const bridge = await offerBridge({ cwd, env, agents, yes, interactive, create: createBridge, dryRun, ask, notes, done, onThisMachine, knownHashes: knownBridgeHashes });
  if (bridge.cancelled) interactive = false;

  let loaded = loadConfig(configLayerPaths({ cwd, env }));
  const choice = await chooseRecommended({ cwd, env, allowFile: install.allowFile, installRecommended, yes, interactive, ask, config: loaded, stdout, notes });
  const chosen = Array.isArray(choice) ? choice : choice.chosen;
  let exit = choice.cancelled || agentChoice.cancelled || bridge.cancelled || qmd.cancelled || rulesyncInstall.cancelled || (configLost && !dryRun) ? 1 : 0;
  if (chosen.length) {
    const installed = installChosen(chosen, { cwd, config: loaded, env, install, skillsDeps, dryRun });
    done.push(...installed.lines);
    if (installed.failed.length) exit = 1;
    // The install may have written overrides and created the skills folder.
    loaded = loadConfig(configLayerPaths({ cwd, env }));
    found.skillDirs = skillDirsOf(cwd);
  }

  if (found.skillDirs.length === 0) {
    notes.push("no skills yet: add them under .toolgate/skills/<name>/SKILL.md, then run `toolgate skills index`");
  }

  // router.qmdUrl: null (in a layer the trust rule accepts) turns the daemon off: need and route use the qmd CLI, so a managed
  // daemon would be one nothing queries. Only a null is off; an empty or missing value is not.
  // A remote one (a URL that is not this machine's) is the same: the server is not ours, and only its origin is ever printed.
  const remote = remoteQmdOrigin(loaded);
  const daemonOff = loaded.router?.qmdUrl === null ? DAEMON_OFF : remote === null ? null : daemonRemote(remote);
  if (dryRun && effectiveBackend === "qmd" && qmd.available) {
    if (daemonOff) {
      done.push(`would not start the qmd daemon: ${daemonOff}`);
    } else {
      const placed = await resolveDaemonPort({ config: loaded, env, cwd, daemon, probePort, yes, interactive, ask, dryRun, stdout, notes, done });
      if (!placed.override) done.push("would start the qmd daemon (or use the one that is running)");
    }
    if (found.skillDirs.length > 0) {
      // The same read-only scan the index does, so the number is the one the real run would print.
      try {
        const options = skillsSettings(loaded, cwd, env);
        const { skills, commands, subagents } = scanIndexable(options);
        done.push(`would index ${describeCount(skills.length, commands.length, subagents.length)}`);
      } catch (err) {
        done.push(`would try to index the skills, which cannot be read yet (${printable(err.message.split("\n")[0])})`);
      }
    }
  } else if (effectiveBackend === "qmd" && qmd.available) {
    if (daemonOff) {
      done.push(`qmd daemon not started: ${daemonOff}`);
    } else {
      const placed = await resolveDaemonPort({ config: loaded, env, cwd, daemon, probePort, yes, interactive, ask, dryRun, stdout, notes, done });
      if (placed.saved) loaded = loadConfig(configLayerPaths({ cwd, env }));
      if (placed.start) {
        const started = await daemon.ensure({ port: placed.port, qmdBin: qmdBinOf(loaded) });
        done.push(
          started.running
            ? `qmd daemon ${started.started ? "started" : "already running"} on ${started.url}`
            : `qmd daemon not running (${started.reason}); routing falls back to the qmd CLI`
        );
      }
    }

    if (found.skillDirs.length > 0) {
      const lines = [];
      const code = runSkills(["index"], {
        cwd,
        config: loaded,
        json: false,
        force: false,
        stdout: { write: (s) => lines.push(s.trim()) },
        stderr: { write: (s) => lines.push(s.trim()) },
        deps: skillsDeps,
      });
      done.push(code === 0 ? lines.join(" ").replace(/^toolgate: /, "") : `skills index failed: ${lines.join(" ")}`);
    }
  }

  if (dryRun) stdout.write("Dry run: nothing is written, installed or started.\n");
  stdout.write(`${done.map((line) => `  ${line}`).join("\n")}\n`);
  if (onThisMachine.length) stdout.write(`\nFound on this machine (${defaultNow ? "informational, only the default agent is configured" : "informational, nothing is configured for it"}):\n${onThisMachine.map((line) => `  ${line}`).join("\n")}\n`);
  if (notices.length) stdout.write(`\nNotices:\n${notices.map((line) => `  - ${line}`).join("\n")}\n`);
  if (notes.length) stdout.write(`\nNext:\n${notes.map((line) => `  - ${line}`).join("\n")}\n`);
  stdout.write('\nCheck it with: toolgate route --prompt "<a task>"\n');
  return exit;
}
