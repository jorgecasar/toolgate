// `toolgate subagents install|update|status|import|list|index|search`: the subagents side of `toolgate commands`. They work
// on the subagents' own store and lock, at the project, user (`--user`) or local (`--local`) level. Skills, commands and
// subagents share one index, so `index` is the same operation as `skills index` and `search` is limited to subagents.
// A subagent is not registered in an agent yet: that comes after the index.
import { ensureIndexedSource } from "../sources.js";
import os from "node:os";
import path from "node:path";
import { jsonSafe, printable, warnNoDescription, warnSkipped } from "../assets/common.js";
import { userConfigDir } from "../config.js";
import { appendIgnored } from "../gitignore.js";
import { syncCollection } from "../skills/collection.js";
import { describeCount, plural, runSkills, settings } from "../skills/cli.js";
import { storeFor } from "../skills/install.js";
import { cacheRoot } from "../skills/remote.js";
import { scanSubagents } from "../skills/scan.js";
import { assetStatus, formatStatus, hasDrift, hasUnreachable } from "../skills/status.js";
import { formatUpdate, updateAssets, updateExitCode } from "../skills/update.js";
import { formatImportSubagents, importExitCode, importSubagents } from "./import.js";
import { SUBAGENT_KIND, SUBAGENTS_LOCAL_IGNORED, installSubagents } from "./install.js";

const USAGE = "toolgate subagents: usage: toolgate subagents install <github:owner/repo | git url> [name...] [--ref r] [--path p] [--exclude n] [--dialect d] [--user | --local]\n";

// After a change to the copies the index follows, as for commands: when the store of the level is one of the sources
// and the level is not switched off. A failure to reindex never fails the change.
function reindexAfter({ level, config, cwd, env, deps, stdout, stderr, changed, note = stdout }) {
  const { root, storeDir } = storeFor(SUBAGENT_KIND, level, { projectDir: cwd, userDir: userConfigDir({ cwd, env }) });
  const options = { ...settings(config, cwd, env), ...deps };
  if ((config?.subagents?.disabledLevels ?? []).includes(level)) {
    stdout.write(`toolgate: this project switched the ${level} level off (subagents.${level}Level), so these subagents are ignored here\n`);
  } else if (!ensureIndexedSource({ kind: "subagents", noun: "subagents", level, storeDir, root, options, sourcesKey: "subagentSources", cwd, env, stdout, write: changed })) {
    // it said why, and the command to run by hand
  } else if (changed) {
    try {
      const { count, commands, subagents } = syncCollection({ ...options, force: false, onSkipped: warnSkipped(stderr, cwd) });
      note.write(`toolgate: skills index has ${describeCount(count, commands, subagents)}\n`);
    } catch (err) {
      note.write(`toolgate: not indexed yet (${err.message.split("\n")[0]}); run: toolgate skills index\n`);
    }
  }
}

function runInstall([spec, ...names], { force, cwd, config, stdout, stderr, env, install, level, deps, dryRun = false }) {
  if (!spec) {
    stderr.write(USAGE);
    return 1;
  }
  const result = installSubagents({
    onNoDescription: warnNoDescription(stderr),
    onSkipped: warnSkipped(stderr, cwd),
    spec,
    names,
    exclude: install.exclude ?? [],
    ref: install.ref,
    subdir: install.subdir,
    projectDir: cwd,
    userDir: userConfigDir({ cwd, env }),
    level,
    cache: install.cache ?? cacheRoot(env),
    force,
    execFn: install.execFn,
    allowFile: install.allowFile,
    dryRun,
    ...(install.dialect === undefined ? {} : { dialect: install.dialect }),
  });
  const done = result.installed.length + result.updated.length;
  if (!dryRun && level === "local" && done + result.unchanged.length > 0) appendIgnored(cwd, SUBAGENTS_LOCAL_IGNORED);
  const lines = [`${dryRun ? "would install" : "installed"} ${plural(result.installed.length, "subagent")}, ${dryRun ? "would update" : "updated"} ${result.updated.length}, unchanged ${result.unchanged.length} from ${spec} (${result.commit.slice(0, 7)})${dryRun ? " (dry run, nothing written)" : ""}`];
  if (result.installed.length) lines.push(`  ${dryRun ? "would be new" : "new"}: ${result.installed.join(", ")}`);
  if (result.updated.length) lines.push(`  ${dryRun ? "would update" : "updated"}: ${result.updated.join(", ")}`);
  for (const [name, said] of Object.entries(result.notes ?? {})) for (const line of said) lines.push(`  ${printable(name)}: ${printable(line)}`);
  for (const { name, reason } of result.skipped) lines.push(`  skipped ${printable(name)}: ${printable(reason)}`);
  if (result.recovered?.length) lines.push(`  recovered ${result.recovered.map(printable).join(", ")} (an earlier run died while replacing ${result.recovered.length === 1 ? "it" : "them"}; the copy it had set aside is back)`);
  for (const { name, reason } of result.licensesSkipped ?? []) lines.push(`  license ${printable(name)} not kept: ${printable(reason)}`);
  if (result.license) lines.push(`  license kept in ${result.license}`);
  stdout.write(`${lines.map((line, i) => (i === 0 ? `toolgate: ${line}` : line)).join("\n")}\n`);
  const exitCode = done === 0 && result.unchanged.length === 0 && result.skipped.length > 0 ? 1 : 0;
  // A preview changes nothing, so there is nothing to index.
  if (dryRun) return exitCode;
  reindexAfter({ level, config, cwd, env, deps, stdout, stderr, changed: done + result.unchanged.length > 0 });
  return exitCode;
}

/**
 * @param {string[]} positional Action and its arguments
 * @param {Object} ctx The same context `runCommands` takes
 * @returns {number} process exit code
 */
export function runSubagents(positional, ctx, signals = {}) {
  const [action, ...rest] = positional;
  const { json, force, cwd, config, stdout, stderr, env = process.env, install = {}, deps = {}, level = "project", remote = false, check = false, dryRun = false, prune = false, acceptLicense = false, sourceFilter } = ctx;
  const userDir = userConfigDir({ cwd, env });
  try {
    if (action === "install") return runInstall(rest, { ...ctx, env, install, level });
    if (action === "index") return runSkills(["index"], ctx);
    if (action === "search") return runSkills(["search", ...rest], { ...ctx, kind: "subagent" });
    if (sourceFilter === "") {
      stderr.write("toolgate subagents: --source needs a value (the source as it appears in the lock)\n");
      return 1;
    }
    if (action === "list") {
      const subagents = scanSubagents(settings(config, cwd, env).subagentSources);
      if (json) {
        stdout.write(`${jsonSafe(JSON.stringify(subagents.map(({ name, description, effectiveTools, tools, level: from, shadows, path: file }) => ({ name, description, tools: effectiveTools, declaredTools: tools, level: from, shadows, path: file })), null, 2))}\n`);
      } else if (subagents.length) {
        stdout.write(`${subagents.map((s) => [printable(s.name), s.level, `tools: ${s.effectiveTools.map(printable).join(", ")}${s.tools ? "" : " (default)"}`, printable(s.path)].join("\t")).join("\n")}\n`);
      } else {
        stdout.write("toolgate: no subagents found\n");
      }
      return 0;
    }
    if (action === "update") {
      const result = updateAssets(SUBAGENT_KIND, {
        projectDir: cwd,
        userDir,
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
      stdout.write(json ? `${jsonSafe(JSON.stringify(result, null, 2))}\n` : formatUpdate(result, { dryRun, command: "toolgate subagents" }));
      if (!dryRun && result.sources.some((r) => r.updated.length + r.restored.length + r.pruned.length > 0)) {
        signals.indexed = true;
        reindexAfter({ level, config, cwd, env, deps, stdout, stderr, note: json ? stderr : stdout, changed: true });
      }
      return updateExitCode(result);
    }
    if (action === "status") {
      const result = assetStatus({
        kind: SUBAGENT_KIND,
        projectDir: cwd,
        userDir,
        sources: settings(config, cwd, env).subagentSources,
        disabledLevels: config?.subagents?.disabledLevels,
        remote,
        execFn: install.execFn,
        allowFile: install.allowFile,
      });
      stdout.write(json ? `${jsonSafe(JSON.stringify(result, null, 2))}\n` : formatStatus(result, { noun: "subagents" }));
      if (check && hasDrift(result)) return 1;
      return check && hasUnreachable(result) ? 2 : 0;
    }
    if (action === "import") {
      const report = importSubagents({ onNoDescription: warnNoDescription(stderr), onSkipped: warnSkipped(stderr, cwd), projectDir: cwd, userDir, homeDir: env.HOME ?? os.homedir(), level, from: install.subdir, dialect: install.dialect, force, dryRun });
      stdout.write(json ? `${jsonSafe(JSON.stringify(report, null, 2))}\n` : formatImportSubagents(report, { dryRun }));
      if (!dryRun && report.imported.length + report.updated.length > 0) {
        if (level === "local") appendIgnored(cwd, SUBAGENTS_LOCAL_IGNORED);
        signals.indexed = true;
        reindexAfter({ level, config, cwd, env, deps, stdout, stderr, note: json ? stderr : stdout, changed: true });
      }
      return importExitCode(report);
    }
  } catch (err) {
    stderr.write(`toolgate subagents: ${printable(err.message)}\n`);
    return 1;
  }
  stderr.write("toolgate subagents: expected install, update, status, import, list, index or search\n");
  return 1;
}
