// `toolgate skills index [--force]` and `toolgate skills search "<task>" [--json]`.
import { ensureIndexedSource } from "../sources.js";
import { jsonSafe, printable, warnNoDescription, warnSkipped } from "../assets/common.js";
import fs from "node:fs";
import path from "node:path";
import { syncCollection } from "./collection.js";
import { mergeOverrides } from "./scan.js";
import { DEFAULT_CORPUS_DIR, defaultCollection } from "./corpus.js";
import { KINDS, searchSkills } from "./search.js";
import { appendIgnored } from "../gitignore.js";
import { COMMAND_KIND, COMMANDS_LOCAL_DIR } from "../commands/install.js";
import { SUBAGENT_KIND, SUBAGENTS_LOCAL_DIR } from "../subagents/install.js";
import { LOCAL_IGNORED, LOCAL_SKILLS_DIR, SKILLS_DIR, SKILL_KIND, STAGING_IGNORED, installSkills, storeFor } from "./install.js";
import { configLayerPaths, userConfigDir } from "../config.js";
import { qmdBinOf } from "../daemon.js";
import { readConfigFile } from "../configFile.js";
import { cacheRoot } from "./remote.js";
import { RECOMMENDED_PREFIX, applyRecommendedOverrides, resolveRecommendation, runRecommended } from "./recommended.js";
import { formatRemove, removeAssets, removeExitCode } from "./remove.js";
import { formatUpdate, updateAssets, updateExitCode } from "./update.js";
import { assetStatus, formatStatus, hasDrift, hasUnreachable } from "./status.js";

// Generated state is kept apart from `.toolgate/skills`, which is itself a default source.
const STATE_DIR = path.join(".toolgate", "skills-index");
const DEFAULT_SOURCE_DIRS = [path.join(".rulesync", "skills"), path.join(".toolgate", "skills")];
const DEFAULT_COMMAND_DIRS = [path.join(".rulesync", "commands"), path.join(".toolgate", "commands")];
const DEFAULT_SUBAGENT_DIRS = [path.join(".rulesync", "subagents"), path.join(".toolgate", "subagents")];

// A project that declares no sources of its own gets the default dirs that exist, so user-level
// sources never replace them; a configured dir is never skipped. Skills and commands follow the
// same rule, each with its own block and default dirs. `stores` are further sources that always
// count (the user and local stores of skills).
function sourcesOf(block, cwd, defaultDirs, stores = []) {
  const declared = block.sources ?? [];
  // An explicit `sources: []` in the project layer opts out of the defaults too.
  const hasProject =
    block.declaredLevels?.includes("project") ??
    declared.some((source) => (source?.level ?? "project") === "project");
  const defaults = hasProject
    ? []
    : defaultDirs.filter((dir) => fs.existsSync(path.resolve(cwd, dir))).map((dir) => ({ dir }));
  const extra = stores.filter((store) => !declared.some((source) => path.resolve(cwd, source.dir ?? "") === store.dir));
  return [...declared, ...defaults, ...extra].map((source) =>
    typeof source?.dir === "string" ? { ...source, dir: path.resolve(cwd, source.dir) } : source
  );
}

// The user and local stores are sources of their own level whenever they exist, unless the project
// switched that level off.
function levelStores(skills, cwd, userDir) {
  return [
    userDir && { dir: path.join(userDir, SKILL_KIND.stores.user.storeDir), level: "user" },
    { dir: path.resolve(cwd, LOCAL_SKILLS_DIR), level: "local" },
  ].filter((store) => store && !(skills.disabledLevels ?? []).includes(store.level) && fs.existsSync(store.dir));
}

// The same for commands: the user store (in the user config directory) and the local one.
function commandLevelStores(commands, cwd, userDir) {
  return [
    userDir && { dir: path.join(userDir, COMMAND_KIND.stores.user.storeDir), level: "user" },
    { dir: path.resolve(cwd, COMMANDS_LOCAL_DIR), level: "local" },
  ].filter((store) => store && !(commands.disabledLevels ?? []).includes(store.level) && fs.existsSync(store.dir));
}
// And for subagents.
function subagentLevelStores(subagents, cwd, userDir) {
  return [
    userDir && { dir: path.join(userDir, SUBAGENT_KIND.stores.user.storeDir), level: "user" },
    { dir: path.resolve(cwd, SUBAGENTS_LOCAL_DIR), level: "local" },
  ].filter((store) => store && !(subagents.disabledLevels ?? []).includes(store.level) && fs.existsSync(store.dir));
}
export function settings(config, cwd, env = process.env) {
  const userDir = userConfigDir({ cwd, env });
  const skills = config?.skills ?? {};
  return {
    sources: sourcesOf(skills, cwd, DEFAULT_SOURCE_DIRS, levelStores(skills, cwd, userDir)),
    commandSources: sourcesOf(config?.commands ?? {}, cwd, DEFAULT_COMMAND_DIRS, commandLevelStores(config?.commands ?? {}, cwd, userDir)),
    subagentSources: sourcesOf(config?.subagents ?? {}, cwd, DEFAULT_SUBAGENT_DIRS, subagentLevelStores(config?.subagents ?? {}, cwd, userDir)),
    overrides: skills.overrides ?? [],
    collection: skills.collection ?? defaultCollection(cwd),
    corpusDir: path.resolve(cwd, skills.corpusDir ?? DEFAULT_CORPUS_DIR),
    stateFile: path.resolve(cwd, STATE_DIR, "state.json"),
    projectDir: cwd,
    qmdBin: qmdBinOf(config),
  };
}

export function formatResults({ results }) {
  if (results.length === 0) return "toolgate: no matching skills, commands or subagents\n";
  // Each field is cleaned on its own: the tab between them is ours.
  const line = (hit) =>
    [`${hit.kind === "command" ? "/" : ""}${printable(hit.name)}`, printable(hit.path ?? hit.file), ...(hit.shadows?.length ? [`(shadows ${printable(hit.shadows.join(", "))})`] : [])].join("\t");
  return `${results.map(line).join("\n")}\n`;
}

export const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
// `count` holds skills, commands and subagents together; a project without the others reads as before.
export const describeCount = (count, commands = 0, subagents = 0) => {
  const parts = [plural(count - commands - subagents, "skill"), ...(commands ? [plural(commands, "command")] : []), ...(subagents ? [plural(subagents, "subagent")] : [])];
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
};

// `toolgate skills install <source> [name...] [--ref r] [--path p] [--exclude n]` copies the skills of a
// remote repository into `.toolgate/skills/` and indexes them. Skills it cannot install are listed, and
// they make the exit code 1 only when nothing at all was installed or updated.
function runInstall([spec, ...names], { force, cwd, stdout, stderr, env, install, config, deps, level = "project", dryRun = false, json = false, signals = {} }) {
  const servers = new Set();
  signals.servers = servers;
  // With --json stdout is the result object alone: every line of text goes to stderr.
  const note = json ? stderr : stdout;
  if (!spec) {
    stderr.write("toolgate skills: usage: toolgate skills install <github:owner/repo | git url> [name...] [--ref r] [--path p] [--exclude n] [--user | --local]\n       toolgate skills install recommended:<id> [name...] [--user | --local]\n");
    return 1;
  }
  if (spec.startsWith(RECOMMENDED_PREFIX) && (install.ref || install.subdir)) {
    stderr.write("toolgate skills: a recommendation fixes its own commit and folder; --ref and --path cannot be combined with it\n");
    return 1;
  }
  const recommended = spec.startsWith(RECOMMENDED_PREFIX) ? resolveRecommendation(spec, names, config, { allowFile: install.allowFile, projectDir: cwd, env, warn: (message) => stderr.write(`toolgate: ${message}\n`) }) : null;
  // The config the overrides go to is read before anything is installed, so a broken one stops the
  // command instead of leaving skills without their overrides.
  const configFile = recommended ? configLayerPaths({ cwd, env }).find((layer) => layer.name === level)?.path : undefined;
  if (configFile) readConfigFile(configFile);
  // Only the shipped list and the user's own config are trusted to reach the user level. The local file
  // is not: `.toolgate/config.local.json` is inside the project and only ignored by git by convention, so
  // a cloned repository can ship one. An entry whose origin is unknown is treated like a project one.
  if (recommended && level === "user" && !["shipped", "user"].includes(recommended.entry.layer)) {
    stderr.write(`toolgate skills: the recommendation ${recommended.entry.id} comes from ${recommended.entry.layer ? `the ${recommended.entry.layer} config` : "an unknown origin"}, which is not yours alone; installing it at the user level would write its overrides into your own config. Install it at the project or local level, or copy the entry to your user config first\n`);
    return 1;
  }
  if (recommended) {
    const { request, entry } = recommended;
    note.write(`toolgate: ${entry.id}: ${request.spec} at ${request.pin.slice(0, 7)} (${printable(entry.license)}), ${plural(request.only.length, "reviewed skill")}${entry.layer && entry.layer !== "shipped" ? `, from the ${printable(entry.layer)} config` : ""}\n`);
  }
  const request = recommended?.request ?? { spec, names, subdir: install.subdir, ref: install.ref };
  const result = installSkills({
    onNoDescription: warnNoDescription(stderr),
    onSkipped: warnSkipped(stderr, cwd),
    onServers: (mcps = []) => mcps.forEach((name) => servers.add(name)),
    ...request,
    exclude: [...(install.exclude ?? []), ...(request.exclude ?? [])],
    projectDir: cwd,
    cache: install.cache ?? cacheRoot(env),
    force,
    execFn: install.execFn,
    allowFile: install.allowFile,
    level,
    userDir: userConfigDir({ cwd, env }),
    dryRun,
  });
  let overridesFailed = false;
  let overrides = null;
  if (recommended) {
    overrides = { added: [], kept: [], written: [] };
    try {
      overrides = applyRecommendedOverrides(recommended.entry, [...result.installed, ...result.updated, ...result.unchanged], configFile, { dryRun });
    } catch (err) {
      overridesFailed = true;
      stderr.write(`toolgate skills: the skills are installed but their overrides could not be written (${err.message.split("\n")[0]}); run the same command again to retry\n`);
    }
    // One line per override written: which skill, what it sets, and the file and layer that changed.
    const shown = printable(path.relative(cwd, configFile).startsWith("..") ? configFile : path.relative(cwd, configFile));
    for (const o of overrides.written) {
      const sets = ["mcps", "tags", "description"].filter((key) => o[key] !== undefined).map((key) => `${key} ${printable(Array.isArray(o[key]) ? o[key].join(", ") : o[key])}`);
      note.write(`toolgate: ${dryRun ? "would write" : "wrote"} an override for ${printable(o.skill)} (${sets.join("; ")}) to ${shown} (${level} config)\n`);
    }
    if (overrides.kept.length) note.write(`toolgate: kept your existing overrides for ${overrides.kept.map((name) => printable(name)).join(", ")}\n`);
  }

  // `--catalog` also builds the servers an override gives a skill that is installed: the effective override (the layers merged as route
  // reads them, and what a recommendation has just written), next to the skill's own `mcps`. A server is built once however it came.
  const effective = mergeOverrides([...(Array.isArray(config?.skills?.overrides) ? config.skills.overrides : []), ...(overrides?.written ?? [])]);
  for (const name of [...result.installed, ...result.updated, ...result.unchanged]) {
    const mcps = effective.get(name)?.mcps;
    for (const mcp of Array.isArray(mcps) ? mcps : []) if (typeof mcp === "string") servers.add(mcp);
  }

  const done = result.installed.length + result.updated.length;
  // Only a local install that put something in the store has anything to keep out of git.
  // The staging folder is kept out of git at the project level too, with or without `toolgate init`.
  if (!dryRun && level === "local" && done + result.unchanged.length > 0) appendIgnored(cwd, LOCAL_IGNORED);
  else if (!dryRun && level === "project" && done + result.unchanged.length > 0) {
    // Only a convenience: a .gitignore that cannot be written (read-only, a link) never stops the install half-way.
    try {
      appendIgnored(cwd, [STAGING_IGNORED], { refuseLinks: true });
    } catch (err) {
      stderr.write(`toolgate skills: could not add ${STAGING_IGNORED} to .gitignore (${printable(err.message.split("\n")[0])}); add it by hand\n`);
    }
  }
  const lines = [`${dryRun ? "would install" : "installed"} ${plural(result.installed.length, "skill")}, ${dryRun ? "would update" : "updated"} ${result.updated.length}, unchanged ${result.unchanged.length} from ${spec} (${result.commit.slice(0, 7)})${dryRun ? " (dry run, nothing written)" : ""}`];
  if (result.installed.length) lines.push(`  ${dryRun ? "would be new" : "new"}: ${result.installed.join(", ")}`);
  if (result.updated.length) lines.push(`  ${dryRun ? "would update" : "updated"}: ${result.updated.join(", ")}`);
  for (const { name, reason } of result.skipped) lines.push(`  skipped ${printable(name)}: ${printable(reason)}`);
  if (result.recovered?.length) lines.push(`  recovered ${result.recovered.map(printable).join(", ")} (an earlier run died while replacing ${result.recovered.length === 1 ? "it" : "them"}; the copy it had set aside is back)`);
  for (const { name, reason } of result.licensesSkipped ?? []) lines.push(`  license ${printable(name)} not kept: ${printable(reason)}`);
  if (result.license) lines.push(`  license kept in ${result.license}`);
  note.write(`${lines.map((line, i) => (i === 0 ? `toolgate: ${line}` : line)).join("\n")}\n`);

  if (json) {
    const report = { source: spec, commit: result.commit, dryRun, installed: result.installed, updated: result.updated, unchanged: result.unchanged, skipped: result.skipped, ...(overrides ? { overrides: { written: overrides.written.map((o) => o.skill), kept: overrides.kept } } : {}) };
    stdout.write(`${jsonSafe(JSON.stringify(report, null, 2))}\n`);
  }
  const exitCode = () => {
    if (overridesFailed) return 1;
    // A recommendation is a reviewed set: a reviewed skill that was skipped (an edited copy, say) leaves it incomplete.
    if (recommended && result.skipped.length > 0) return 1;
    return done === 0 && result.unchanged.length === 0 && result.skipped.length > 0 ? 1 : 0;
  };
  if (dryRun) return exitCode();
  // Sources are worked out again: in a new project the default folder only exists now.
  const options = { ...settings(config, cwd, env), ...deps };
  const store = storeFor(SKILL_KIND, level, { projectDir: cwd, userDir: userConfigDir({ cwd, env }) });
  if ((config?.skills?.disabledLevels ?? []).includes(level)) {
    note.write(`toolgate: this project switched the ${level} level off (skills.${level}Level), so these skills are ignored here\n`);
  } else if (!ensureIndexedSource({ kind: "skills", noun: "skills", level, storeDir: store.storeDir, root: store.root, options, sourcesKey: "sources", cwd, env, stdout: note, write: done + result.unchanged.length > 0 })) {
    // it said why, and the command to run by hand
  } else if (done + result.unchanged.length > 0) {
    try {
      const { count, commands, subagents } = syncCollection({ ...options, force: false, onSkipped: warnSkipped(stderr, cwd) });
      note.write(`toolgate: skills index has ${describeCount(count, commands, subagents)}\n`);
    } catch (err) {
      note.write(`toolgate: not indexed yet (${err.message.split("\n")[0]}); run: toolgate skills index\n`);
    }
  }
  return exitCode();
}

/**
 * @returns {number} process exit code
 */
export function runSkills(
  positional,
  { json, force, kind, cwd, config, stdout, stderr, env = process.env, install = {}, deps = {}, level = "project", remote = false, check = false, dryRun = false, prune = false, acceptLicense = false, keepOverrides = false, sourceFilter },
  signals = {}
) {
  const [action, ...rest] = positional;
  const options = { ...settings(config, cwd, env), ...deps };
  // After a change to the copies the index follows; a failure to reindex never fails the change. With
  // --json stdout is the result alone, so the note goes to stderr.
  const note = json ? stderr : stdout;
  const reindex = () => {
    try {
      const { count } = syncCollection({ ...options, force: false, onSkipped: warnSkipped(stderr, cwd) });
      signals.indexed = true;
      note.write(`toolgate: skills index has ${plural(count, "skill")}\n`);
    } catch (err) {
      note.write(`toolgate: not indexed yet (${err.message.split("\n")[0]}); run: toolgate skills index\n`);
    }
  };

  try {
    if (action === "index") {
      const { indexed, count, commands, subagents } = syncCollection({ ...options, force, onSkipped: warnSkipped(stderr, cwd) });
      stdout.write(`toolgate: ${indexed ? `indexed ${describeCount(count, commands, subagents)}` : `skills index up to date (${count})`}\n`);
      return 0;
    }
    if (sourceFilter === "") {
      stderr.write("toolgate skills: --source needs a value (the source as it appears in the lock)\n");
      return 1;
    }
    if (action === "remove") {
      const result = removeAssets(SKILL_KIND, {
        projectDir: cwd,
        userDir: userConfigDir({ cwd, env }),
        level,
        names: rest,
        source: sourceFilter,
        force,
        dryRun,
        keepOverrides,
        env,
      });
      stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatRemove(result, { dryRun }));
      if (!dryRun && result.removed.length) reindex();
      return removeExitCode(result);
    }
    if (action === "update") {
      const result = updateAssets(SKILL_KIND, {
        projectDir: cwd,
        userDir: userConfigDir({ cwd, env }),
        level,
        cache: install.cache ?? cacheRoot(env),
        names: rest,
        source: sourceFilter,
        dryRun,
        force,
        prune,
        acceptLicense,
        execFn: install.execFn,
        allowFile: install.allowFile,
      });
      stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatUpdate(result, { dryRun }));
      const changed = result.sources.some((r) => r.updated.length + r.restored.length + r.pruned.length > 0);
      if (!dryRun && changed) reindex();
      return updateExitCode(result);
    }
    if (action === "status") {
      const result = assetStatus({
        projectDir: cwd,
        userDir: userConfigDir({ cwd, env }),
        sources: options.sources,
        overrides: options.overrides,
        disabledLevels: config?.skills?.disabledLevels,
        remote,
        execFn: install.execFn ?? deps.execFn,
        allowFile: install.allowFile,
      });
      stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatStatus(result));
      if (check && hasDrift(result)) return 1;
      // 2 tells a CI job the check itself could not finish, which is not the same as drift.
      return check && hasUnreachable(result) ? 2 : 0;
    }
    if (action === "recommended") return runRecommended({ config, cwd, json, stdout, stderr, env });
    if (action === "install") {
      return runInstall(rest, { force, cwd, stdout, stderr, env, install, config, deps, level, dryRun, json, signals });
    }
    if (action === "search") {
      if (kind !== undefined && !KINDS.includes(kind)) {
        stderr.write(`toolgate skills: --kind must be ${KINDS.join(", ")}${kind ? `, not "${kind}"` : " (no value given)"}\n`);
        return 1;
      }
      const result = searchSkills(rest.join(" "), { ...options, kind });
      for (const warning of result.warnings ?? []) stderr.write(`toolgate skills: ${warning}\n`);
      if (result.reason) stderr.write(`toolgate skills: ${result.reason}; using the _index.md fallback\n`);
      stdout.write(json ? `${jsonSafe(JSON.stringify(result, null, 2))}\n` : formatResults(result));
      return 0;
    }
  } catch (err) {
    stderr.write(`toolgate skills: ${printable(err.message)}\n`);
    return 1;
  }

  stderr.write("toolgate skills: expected index, search, install, update, remove, status or recommended\n");
  return 1;
}
