// `toolgate commands import`: brings the commands an agent already has (`.claude/commands`, ...) under
// toolgate, as normalized copies in the store with an entry in the lock whose source is the local folder.
// The originals are never changed. Re-running it picks up edits made to them; the copies are what toolgate
// indexes, so nothing about a command that executes (`!`cmd``, `@file`, `allowed-tools`) is kept.
import fs from "node:fs";
import path from "node:path";
import { hasDescription, noDescriptionNotice, printable } from "../assets/common.js";
import { assertPlainStore, clearStaging, hashOrNull, readLock, recordedOf, replaceUnit, storeFor, writeLock } from "../skills/install.js";
import { isGeneratedBridge } from "./bridge.js";
import { COMMAND_KIND, commandKind } from "./install.js";
import { insideBase, nativeFolders } from "./native.js";

const LOCAL = "local:";

/** Whether a lock source stands for a local folder: such a source has no remote to update from. */
export const isLocalSource = (spec) => typeof spec === "string" && spec.startsWith(LOCAL);

/**
 * @param {Object} options
 * @param {string} options.projectDir
 * @param {string} [options.userDir] The user config directory (the store of the user level)
 * @param {string} [options.homeDir] The home directory, where the user's native folders are
 * @param {"user" | "project" | "local"} [options.level]
 * @param {string} [options.from] A folder to read instead of the native ones, relative to the project
 * @param {string} [options.dialect] How the commands of `from` are written (default `claude`)
 * @param {boolean} [options.force] Overwrite a copy edited here and one that is not toolgate's
 * @param {boolean} [options.dryRun] Report what would be written and write nothing
 */
export function importCommands(options) {
  return importUnits({ kind: COMMAND_KIND, kindFor: commandKind, capabilities: undefined, ignored: bridgeIsIgnored }, options);
}

// The /toolgate command toolgate wrote itself is not one to import.
function bridgeIsIgnored(name, folder) {
  return name === "toolgate" && isGeneratedBridge(path.join(folder.dir, `${name}.md`));
}

/**
 * The import both commands and subagents use: `kind` is the store descriptor, `kindFor(dialect)` reads a folder,
 * `capabilities` is the table of native folders (commands by default) and `ignored(name, folder)` says which
 * skipped files are not worth a word.
 */
export function importUnits({ kind: storeKind, kindFor, capabilities, ignored = () => false }, { projectDir, userDir, homeDir, level = "project", from, dialect, force = false, dryRun = false, onNoDescription, onSkipped }) {
  const { root, storeDir, lockFile: lockPath } = storeFor(storeKind, level, { projectDir, userDir });
  const report = { level, folders: [], imported: [], updated: [], unchanged: [], skipped: [], notes: [], dropped: {}, unsupported: {}, remarks: {} };

  let folders;
  if (from !== undefined) {
    const dir = path.resolve(projectDir, from);
    const info = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!info) throw new Error(`${from} does not exist`);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${from} is not a folder (a symlink is not followed)`);
    if (!insideBase(dir, projectDir)) throw new Error(`${from} resolves outside the project`);
    folders = [{ dir, label: from, dialect: dialect ?? "claude" }];
  } else {
    const found = level === "user" ? nativeFolders({ base: homeDir, user: true, capabilities }) : nativeFolders({ base: projectDir, capabilities });
    folders = found.folders;
    report.notes.push(...found.notes);
  }
  if (folders.length === 0 && from === undefined) report.notes.push(`no native ${storeKind.noun} folder found`);

  assertPlainStore(root, storeDir);
  const lockFile = path.join(root, lockPath);
  const lock = readLock(lockFile, storeKind.lockKey);
  const locked = lock[storeKind.lockKey];
  const storeAbs = path.join(root, storeDir);
  if (!dryRun) {
    const recovered = clearStaging(path.join(root, path.dirname(storeDir), ".staging"), { storeAbs, locked, kind: storeKind });
    if (recovered.length) report.notes.push(`recovered ${recovered.join(", ")}: an earlier run died while replacing ${recovered.length === 1 ? "it" : "them"}; the copy it had set aside is back`);
  }
  let changed = false;

  for (const folder of folders) {
    const kind = kindFor(folder.dialect);
    const spec = `${LOCAL}${folder.label}`;
    const { items, skipped } = kind.discover(folder.dir);
    report.folders.push({ label: folder.label, dialect: folder.dialect, found: items.length });
    for (const { name, reason } of skipped) {
      if (ignored(name, folder)) continue;
      report.skipped.push({ name: `${folder.label}/${name}`, reason });
      onSkipped?.({ kind: storeKind.noun, file: `${folder.label}/${name}`, reason });
    }
    for (const item of items) {
      const target = path.join(storeAbs, kind.fileName(item.name));
      const entry = Object.hasOwn(locked, item.name) ? locked[item.name] : undefined;
      // `Foo` and `foo` are one file on a filesystem that ignores case: another spelling is another unit.
      const other = fs.existsSync(storeAbs)
        ? fs.readdirSync(storeAbs).find((file) => file !== kind.fileName(item.name) && file.toLowerCase() === kind.fileName(item.name).toLowerCase())
        : undefined;
      if (other) {
        report.skipped.push({ name: item.name, reason: `differs only in case from the installed "${other.replace(/\.md$/, "")}"` });
        continue;
      }
      const present = fs.existsSync(target);
      let current;
      try {
        current = present ? hashOrNull(target, kind.hash) : undefined;
      } catch (err) {
        report.skipped.push({ name: item.name, reason: `could not be read: ${err.message.split("\n")[0]}` });
        continue;
      }
      if (present && !force) {
        if (!entry) {
          report.skipped.push({ name: item.name, reason: "already exists and was not installed by toolgate (use --force to replace it)" });
          continue;
        }
        if (entry.source !== spec) {
          report.skipped.push({ name: item.name, reason: `installed from ${entry.source} (use --force to replace it)` });
          continue;
        }
        if (current !== entry.hash) {
          report.skipped.push({ name: item.name, reason: "edited since it was imported (use --force to overwrite it)" });
          continue;
        }
      }
      const hash = kind.sourceHash(item.dir, item);
      if (item.dropped.length) report.dropped[item.name] = item.dropped;
      if (item.unsupported?.length) report.unsupported[item.name] = item.unsupported;
      if (kind.remark?.(item)) report.remarks[item.name] = kind.remark(item);
      if (present && entry?.hash === hash && entry.source === spec && current === hash) {
        report.unchanged.push(item.name);
        continue;
      }
      (present ? report.updated : report.imported).push(item.name);
      if (dryRun) continue;
      try {
        replaceUnit(kind, { root, storeDir, name: item.name, from: item.dir, item });
      } catch (err) {
        (present ? report.updated : report.imported).pop();
        report.skipped.push({ name: item.name, reason: `could not be written: ${err.code ?? err.message}` });
        continue;
      }
      if (!hasDescription(item)) onNoDescription?.(noDescriptionNotice(storeKind.noun, item.name, [folder.label, ...path.relative(folder.dir, item.path ?? item.dir).split(path.sep)].join("/")));
      locked[item.name] = { source: spec, path: [folder.label, ...path.relative(folder.dir, item.dir).split(path.sep)].join("/"), hash, ...recordedOf(item) };
      lock.sources[spec] = { path: folder.label, dialect: folder.dialect, local: true };
      changed = true;
    }
  }
  if (changed) writeLock(lockFile, lock, storeKind.lockKey);
  return report;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The text of a report. What comes from folders and files (names, reasons, folders) is printed cleaned, one line each. */
export function formatImport(report, { dryRun = false, noun = "command" } = {}) {
  const p = printable;
  const list = (names) => names.map(p).join(", ");
  const lines = [];
  const verb = dryRun ? "would import" : "imported";
  for (const folder of report.folders) lines.push(`toolgate: ${p(folder.label)} (${p(folder.dialect)}): ${plural(folder.found, noun)}`);
  for (const note of report.notes) lines.push(`toolgate: ${p(note)}`);
  lines.push(`toolgate: ${verb} ${plural(report.imported.length, noun)}, updated ${report.updated.length}, unchanged ${report.unchanged.length} at the ${p(report.level)} level${dryRun ? " (dry run, nothing written)" : ""}`);
  if (report.imported.length) lines.push(`  new: ${list(report.imported)}`);
  if (report.updated.length) lines.push(`  updated: ${list(report.updated)}`);
  for (const [name, keys] of Object.entries(report.dropped)) lines.push(`  ${p(name)}: not kept (never copied into the store): ${list(keys)}`);
  for (const [name, tokens] of Object.entries(report.unsupported)) lines.push(`  ${p(name)}: placeholders with no equivalent, left as text: ${list(tokens)}`);
  for (const [name, remark] of Object.entries(report.remarks ?? {})) lines.push(`  ${p(name)}: ${p(remark)}`);
  for (const { name, reason } of report.skipped) lines.push(`  skipped ${p(name)}: ${p(reason)}`);
  return `${lines.join("\n")}\n`;
}

/** 1 when something was skipped and nothing at all was imported, updated or already there; 0 otherwise. */
export function importExitCode(report) {
  return report.imported.length + report.updated.length + report.unchanged.length === 0 && report.skipped.length > 0 ? 1 : 0;
}
