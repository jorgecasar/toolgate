// `toolgate commands install|update|status|import|bridge|list|index|search`: the commands side of `toolgate skills`.
// Skills and commands share one collection and one index, so `index` and `search` are the same operations
// with `search` limited to commands; the rest work on the commands' own store and lock, at the project,
// user (`--user`) or local (`--local`) level.
import os from "node:os";
import path from "node:path";
import { jsonSafe, printable, warnNoDescription, warnSkipped } from "../assets/common.js";
import { userConfigDir } from "../config.js";
import { appendIgnored } from "../gitignore.js";
import { syncCollection } from "../skills/collection.js";
import { describeCount, formatResults, plural, runSkills, settings } from "../skills/cli.js";
import { storeFor } from "../skills/install.js";
import { ensureIndexedSource } from "../sources.js";
import { cacheRoot } from "../skills/remote.js";
import { scanCommands } from "../skills/scan.js";
import { assetStatus, formatStatus, hasDrift, hasUnreachable } from "../skills/status.js";
import { formatUpdate, updateAssets, updateExitCode } from "../skills/update.js";
import { bridgeCommands, bridgeExitCode, formatBridge } from "./bridge.js";
import { formatImport, importCommands, importExitCode } from "./import.js";
import { COMMAND_KIND, COMMANDS_LOCAL_IGNORED, installCommands } from "./install.js";

// `toolgate commands install <source> [name...] [--ref r] [--path p] [--exclude n] [--dialect d] [--user | --local]`
// copies the commands of a remote repository into the store of the level in their normalized form and
// indexes them. Commands it cannot install are listed, and they make the exit code 1 only when nothing at all
// was installed or updated.
function runInstall([spec, ...names], { force, cwd, stdout, stderr, env, install, config, deps, level, dryRun = false }) {
  if (!spec) {
    stderr.write("toolgate commands: usage: toolgate commands install <github:owner/repo | git url> [name...] [--ref r] [--path p] [--exclude n] [--dialect d] [--user | --local]\n");
    return 1;
  }
  const userDir = userConfigDir({ cwd, env });
  const result = installCommands({
    onNoDescription: warnNoDescription(stderr),
    onSkipped: warnSkipped(stderr, cwd),
    spec,
    names,
    exclude: install.exclude ?? [],
    ref: install.ref,
    subdir: install.subdir,
    projectDir: cwd,
    userDir,
    level,
    cache: install.cache ?? cacheRoot(env),
    force,
    execFn: install.execFn,
    allowFile: install.allowFile,
    dryRun,
    ...(install.dialect === undefined ? {} : { dialect: install.dialect }),
  });

  const done = result.installed.length + result.updated.length;
  // Only a local install that put something in the store has anything to keep out of git.
  if (!dryRun && level === "local" && done + result.unchanged.length > 0) appendIgnored(cwd, COMMANDS_LOCAL_IGNORED);
  const lines = [`${dryRun ? "would install" : "installed"} ${plural(result.installed.length, "command")}, ${dryRun ? "would update" : "updated"} ${result.updated.length}, unchanged ${result.unchanged.length} from ${spec} (${result.commit.slice(0, 7)})${dryRun ? " (dry run, nothing written)" : ""}`];
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

// After a change to the copies the index follows: when the store of the level is one of the sources (the default
// one is, a project with its own `commands.sources` may not have it) and the level is not switched off. A
// failure to reindex never fails the change.
function reindexAfter({ level, config, cwd, env, deps, stdout, stderr, changed, note = stdout }) {
  const { root, storeDir } = storeFor(COMMAND_KIND, level, { projectDir: cwd, userDir: userConfigDir({ cwd, env }) });
  const options = { ...settings(config, cwd, env), ...deps };
  if ((config?.commands?.disabledLevels ?? []).includes(level)) {
    stdout.write(`toolgate: this project switched the ${level} level off (commands.${level}Level), so these commands are ignored here\n`);
  } else if (!ensureIndexedSource({ kind: "commands", noun: "commands", level, storeDir, root, options, sourcesKey: "commandSources", cwd, env, stdout, write: changed })) {
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

/**
 * @param {string[]} positional Action and its arguments
 * @param {Object} ctx The same context `runSkills` takes
 * @returns {number} process exit code
 */
export function runCommands(positional, ctx, signals = {}) {
  const [action, ...rest] = positional;
  const { json, force, cwd, config, stdout, stderr, env = process.env, install = {}, deps = {}, level = "project", bridgeAgents = [], remote = false, check = false, dryRun = false, prune = false, acceptLicense = false, sourceFilter } = ctx;
  const userDir = userConfigDir({ cwd, env });
  // With --json stdout is the result alone, so the note about the index goes to stderr.
  const note = json ? stderr : stdout;
  try {
    if (action === "install") return runInstall(rest, { ...ctx, env, install, level });
    if (action === "index") return runSkills(["index"], ctx);
    if (action === "search") return runSkills(["search", ...rest], { ...ctx, kind: "command" });
    if (sourceFilter === "") {
      stderr.write("toolgate commands: --source needs a value (the source as it appears in the lock)\n");
      return 1;
    }
    if (action === "list") {
      const commands = scanCommands({ ...settings(config, cwd, env), ...deps }.commandSources);
      if (json) {
        stdout.write(`${jsonSafe(JSON.stringify(commands.map(({ name, description, argumentHint, level: from, shadows, path: file }) => ({ name, description, argumentHint, level: from, shadows, path: file })), null, 2))}\n`);
      } else {
        stdout.write(commands.length ? formatResults({ results: commands }) : "toolgate: no commands found\n");
      }
      return 0;
    }
    if (action === "update") {
      const result = updateAssets(COMMAND_KIND, {
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
      stdout.write(json ? `${jsonSafe(JSON.stringify(result, null, 2))}\n` : formatUpdate(result, { dryRun, command: "toolgate commands" }));
      const changed = result.sources.some((r) => r.updated.length + r.restored.length + r.pruned.length > 0);
      if (!dryRun && changed) {
        signals.indexed = true;
        reindexAfter({ level, config, cwd, env, deps, stdout, stderr, note, changed });
      }
      return updateExitCode(result);
    }
    if (action === "status") {
      const options = { ...settings(config, cwd, env), ...deps };
      const result = assetStatus({
        kind: COMMAND_KIND,
        projectDir: cwd,
        userDir,
        sources: options.commandSources,
        disabledLevels: config?.commands?.disabledLevels,
        remote,
        execFn: install.execFn ?? deps.execFn,
        allowFile: install.allowFile,
      });
      stdout.write(json ? `${jsonSafe(JSON.stringify(result, null, 2))}\n` : formatStatus(result, { noun: "commands" }));
      if (check && hasDrift(result)) return 1;
      // 2 tells a CI job the check itself could not finish, which is not the same as drift.
      return check && hasUnreachable(result) ? 2 : 0;
    }
    if (action === "bridge") {
      if (level === "local") {
        stderr.write("toolgate commands: bridge writes in the project or, with --user, in the home folder; --local does not apply\n");
        return 1;
      }
      const report = bridgeCommands({ projectDir: cwd, homeDir: env.HOME ?? os.homedir(), user: level === "user", agents: bridgeAgents, force, dryRun });
      stdout.write(json ? `${jsonSafe(JSON.stringify(report, null, 2))}\n` : formatBridge(report, { dryRun }));
      return bridgeExitCode(report);
    }
    if (action === "import") {
      const report = importCommands({
        onNoDescription: warnNoDescription(stderr),
        onSkipped: warnSkipped(stderr, cwd),
        projectDir: cwd,
        userDir,
        homeDir: env.HOME ?? os.homedir(),
        level,
        from: install.subdir,
        dialect: install.dialect,
        force,
        dryRun,
      });
      stdout.write(json ? `${jsonSafe(JSON.stringify(report, null, 2))}\n` : formatImport(report, { dryRun }));
      const written = report.imported.length + report.updated.length > 0;
      if (!dryRun && written) {
        if (level === "local") appendIgnored(cwd, COMMANDS_LOCAL_IGNORED);
        signals.indexed = true;
        reindexAfter({ level, config, cwd, env, deps, stdout, stderr, note, changed: true });
      }
      return importExitCode(report);
    }
  } catch (err) {
    stderr.write(`toolgate commands: ${printable(err.message)}\n`);
    return 1;
  }
  stderr.write("toolgate commands: expected install, update, status, import, bridge, list, index or search\n");
  return 1;
}
