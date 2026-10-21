// The CLI of a kind that needs review (hooks, permissions): `install|update|status|list|review|remove` at the project, user
// (`--user`) and local (`--local`) level. A hook runs a command and a permission can widen what the agent may do, so nothing
// is applied until this user approves its exact content on this machine: `install` and `update` show what would change and
// ask once; with `--yes`, in CI or without a terminal they change nothing and exit 2. An approval holds while the content does
// not change (see `approval.js`). What differs between kinds is in the `spec` each one passes.
import os from "node:os";
import { effectiveBlocked, effectiveEntry, effectiveRejected, effectiveJson, effectiveText } from "./effective.js";
import { jsonSafe, printable } from "./common.js";
import { importReviewed } from "./reviewImport.js";
import { claudeSettingsFile, readSettings } from "./nativeSettings.js";
import { canAsk, loadApprovals, reviewWaiting, unitKey } from "./approval.js";
import { userConfigDir } from "../config.js";
import { appendIgnored } from "../gitignore.js";
import { askInTerminal } from "../init.js";
import { plural } from "../skills/cli.js";
import { installAssets } from "../skills/install.js";
import { cacheRoot } from "../skills/remote.js";
import { assetStatus, formatStatus, hasDrift, hasUnreachable } from "../skills/status.js";
import { formatRemove, removeAssets, removeExitCode } from "../skills/remove.js";
import { formatUpdate, updateAssets, updateExitCode } from "../skills/update.js";

// What changed between the copy in the store and the new content, as the lines of the two previews.
function diffText(before, after) {
  if (!before) return after;
  const was = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));
  return [...before.split("\n").filter((l) => !now.has(l)).map((l) => `- ${l}`), ...after.split("\n").map((l) => (was.has(l) ? `  ${l}` : `+ ${l}`))].join("\n");
}

/**
 * @param {Object} spec
 * @param {object} spec.kind The descriptor (`review: true`)
 * @param {string} spec.noun "hook"
 * @param {string} spec.plural "hooks"
 * @param {(options: { projectDir: string, userDir: string, levels: string[] }) => object[]} spec.scan The units of the stores, with `level`, `hash`, `error?`
 * @param {(unit: object) => string} spec.preview The text shown for a stored unit
 * @param {(unit: object, state: string) => string[]} spec.row The columns of `list`
 * @param {(unit: object, state: string) => object} spec.json One unit of `list --json`
 * @param {string[]} spec.ignored Gitignore entries of the local store
 * @param {string} spec.usage The usage line of `install`
 * @param {(options: { data: object, label: string, base: string }) => object} spec.buildImport The unit made of the settings file of the agent, with what was skipped
 * @param {(options: object) => Promise<void>} [spec.afterReview] Called after the units were reviewed (grants)
 * @param {(options: object) => object[]} [spec.extraPending] More units that wait for something beyond approval
 * @param {(options: object) => string[]} [spec.statusLines] More lines of `status`
 * @param {(approvals: object, options: object) => void} [spec.onRemove] What to forget when a unit is removed (default: its approval)
 */
export function createReviewCli(spec) {
  const { kind, noun, plural: plurals } = spec;
  const waitingText = `waiting for review: nothing was changed; run \`toolgate ${plurals} review\` in a terminal to approve`;
  const keyOf = (cwd, level, name) => unitKey({ projectDir: cwd, level, kind: noun, name });
  const showOf = (level) => (item) => `\ntoolgate: ${level} ${noun} waiting for your approval (${item.hash.slice(0, 12)}):\n${diffText(item.before, item.preview ?? item.name)}`;

  // Shows the units that wait and, in a terminal, asks for a `yes` for each. Saves what was approved.
  async function askAbout({ waiting, approvals, level, ctx }) {
    const { stdout, ask = askInTerminal, yes = false, interactive = false, env = process.env, dryRun = false } = ctx;
    const allowed = canAsk({ yes, interactive, env }) && !dryRun;
    const result = await reviewWaiting({ waiting, approvals, show: showOf(level), ask, print: (text) => stdout.write(text), allowed });
    if (result.approved.length) approvals.save();
    if (spec.afterReview) await spec.afterReview({ waiting, approvals, level, ctx, allowed, approved: result.approved });
    return result;
  }

  // The units of the stores (every allowed level) whose stored content is not approved here.
  const levelsOf = (config) => ["user", "project", "local"].filter((level) => !(config?.[plurals]?.disabledLevels ?? []).includes(level));
  function pendingUnits({ cwd, userDir, config, approvals }) {
    return spec
      .scan({ projectDir: cwd, userDir, levels: levelsOf(config) })
      .filter((unit) => !unit.error && !approvals.has(keyOf(cwd, unit.level, unit.name), unit.hash))
      .map((unit) => ({ name: unit.name, level: unit.level, hash: unit.hash, key: keyOf(cwd, unit.level, unit.name), preview: spec.preview(unit), ...(kind.waitingExtra?.(unit) ?? {}) }));
  }

  return async function run(positional, ctx) {
    const [action, ...rest] = positional;
    const { json, force, cwd, config, stdout, stderr, env = process.env, install = {}, level = "project", remote = false, check = false, dryRun = false, prune = false, sourceFilter } = ctx;
    const userDir = userConfigDir({ cwd, env });
    try {
      const approvals = loadApprovals(userDir);
      if (approvals.problem) stderr.write(`toolgate: ${printable(approvals.problem)}\n`);
      // A grant is a second, separate decision about what a unit lets through: it is asked for at install and at review, never from an update or an import.
      if (ctx.grant && (action === "update" || action === "import")) {
        stderr.write("toolgate: --grant works only with install and review\n");
        return 1;
      }
      if (action === "install") {
        const [source, ...names] = rest;
        if (!source) {
          stderr.write(spec.usage);
          return 1;
        }
        const options = () => ({ approvals, spec: source, names, exclude: install.exclude ?? [], ref: install.ref, subdir: install.subdir, projectDir: cwd, userDir, level, cache: install.cache ?? cacheRoot(env), force, execFn: install.execFn, allowFile: install.allowFile });
        let result = installAssets(kind, options());
        let left = result.waiting.map((w) => w.name);
        if (result.waiting.length) {
          const reviewed = await askAbout({ waiting: result.waiting, approvals, level, ctx });
          left = reviewed.left;
          if (reviewed.approved.length) result = installAssets(kind, options());
        }
        if (level === "local" && result.installed.length + result.updated.length + result.unchanged.length > 0) appendIgnored(cwd, spec.ignored);
        const lines = [`installed ${plural(result.installed.length, noun)}, updated ${result.updated.length}, unchanged ${result.unchanged.length} from ${printable(source)} (${result.commit.slice(0, 7)})`];
        if (result.installed.length) lines.push(`  new: ${result.installed.join(", ")}`);
        if (result.updated.length) lines.push(`  updated: ${result.updated.join(", ")}`);
        for (const [name, said] of Object.entries(result.notes ?? {})) for (const line of said) lines.push(`  ${printable(name)}: ${printable(line)}`);
        for (const { name, reason } of result.skipped) lines.push(`  skipped ${printable(name)}: ${printable(reason)}`);
        if (left.length) lines.push(`  ${printable(left.join(", "))}: ${waitingText}`);
        stdout.write(`${lines.map((line, i) => (i === 0 ? `toolgate: ${line}` : line)).join("\n")}\n`);
        if (left.length) return 2;
        return result.installed.length + result.updated.length + result.unchanged.length === 0 && result.skipped.length > 0 ? 1 : 0;
      }
      if (action === "update") {
        const options = () => ({ approvals, projectDir: cwd, userDir, level, cache: install.cache ?? cacheRoot(env), names: rest, source: sourceFilter, dryRun, force, prune, execFn: install.execFn, allowFile: install.allowFile });
        let result = updateAssets(kind, options());
        const waiting = result.sources.flatMap((r) => r.waiting).filter((w) => w.hash);
        if (waiting.length && !dryRun) {
          const reviewed = await askAbout({ waiting, approvals, level, ctx });
          if (reviewed.approved.length) result = updateAssets(kind, options());
        }
        stdout.write(json ? `${jsonSafe(JSON.stringify(result, null, 2))}\n` : formatUpdate(result, { dryRun, command: `toolgate ${plurals}` }));
        return updateExitCode(result);
      }
      if (action === "review") {
        const pending = [...pendingUnits({ cwd, userDir, config, approvals }), ...(spec.extraPending?.({ cwd, userDir, config, approvals, ctx }) ?? [])];
        if (pending.length === 0) {
          stdout.write(`toolgate: no ${noun} waits for review\n`);
          return 0;
        }
        const left = [];
        for (const level2 of ["user", "project", "local"]) {
          const ofLevel = pending.filter((unit) => unit.level === level2);
          if (ofLevel.length) left.push(...(await askAbout({ waiting: ofLevel, approvals, level: level2, ctx })).left);
        }
        if (left.length) stdout.write(`toolgate: ${printable(left.join(", "))}: ${waitingText}\n`);
        return left.length ? 2 : 0;
      }
      if (action === "status" && ctx.effective) {
        const registry = ctx.adapters;
        const wanted = ctx.agent ? [registry.canonical(ctx.agent)] : registry.names();
        const entries = [];
        for (const name of wanted) {
          try {
            entries.push(effectiveEntry(noun, name, await registry.get(name), { config, cwd, env: ctx.env }));
          } catch (err) {
            stderr.write(`toolgate: ${printable(name)}: ${printable(err.message.split("\n")[0])}\n`);
            if (ctx.agent) return 1;
          }
        }
        stdout.write(json ? `${jsonSafe(JSON.stringify(effectiveJson(entries), null, 2))}\n` : `${effectiveText(noun, entries)}\n`);
        return check ? (effectiveRejected(entries) ? 1 : effectiveBlocked(entries) ? 2 : 0) : 0;
      }
      if (action === "status") {
        const off = config?.[plurals]?.disabledLevels ?? [];
        const result = assetStatus({ kind, projectDir: cwd, userDir, levels: levelsOf(config), sources: [], disabledLevels: off, remote, execFn: install.execFn, allowFile: install.allowFile });
        const pending = [...pendingUnits({ cwd, userDir, config, approvals }), ...(spec.extraPending?.({ cwd, userDir, config, approvals, ctx }) ?? [])];
        const waiting = pending.map((p) => `${printable(p.name)} (${p.level})${p.note ? ` ${p.note}` : ""}`);
        const text = formatStatus(result, { noun: plurals });
        const extraLines = spec.statusLines?.({ cwd, userDir, config, approvals }) ?? [];
        stdout.write(json ? `${jsonSafe(JSON.stringify({ ...result, pending: pending.map(({ name, level: l, hash }) => ({ name, level: l, hash })) }, null, 2))}\n` : `${text}${waiting.length ? `pending review: ${waiting.join(", ")} (run \`toolgate ${plurals} review\`)\n` : ""}${extraLines.map((l) => `${l}\n`).join("")}`);
        if (check && hasDrift(result)) return 1;
        if (check && hasUnreachable(result)) return 2;
        return check && pending.length ? 2 : 0;
      }
      if (action === "list") {
        const units = spec.scan({ projectDir: cwd, userDir, levels: levelsOf(config) });
        const state = (unit) => (approvals.has(keyOf(cwd, unit.level, unit.name), unit.hash) ? "approved" : "pending review");
        if (json) stdout.write(`${jsonSafe(JSON.stringify(units.map((u) => (u.error ? { name: u.name, level: u.level, error: u.error } : spec.json(u, state(u), { approvals, cwd }))), null, 2))}\n`);
        else if (units.length) stdout.write(`${units.map((u) => (u.error ? [printable(u.name), u.level, `unreadable: ${printable(u.error)}`] : spec.row(u, state(u), { approvals, cwd })).join("\t")).join("\n")}\n`);
        else stdout.write(`toolgate: no ${plurals} found\n`);
        return 0;
      }
      if (action === "import") {
        const source = claudeSettingsFile({ level, projectDir: cwd, homeDir: env.HOME ?? os.homedir() });
        const { data, note } = readSettings(source);
        if (!data) {
          stdout.write(`toolgate: ${printable(note)}\n`);
          return /does not exist/.test(note) ? 0 : 1;
        }
        const built = spec.buildImport({ data, label: source.label, base: source.base, name: level === "project" ? "native-claude" : `native-claude-${level}` });
        try {
          const lines = [];
          let left = [];
          let result = { imported: [], updated: [], unchanged: [], skipped: [], waiting: [] };
          if (built.item) {
            const options = () => ({ item: built.item, label: source.label, level, projectDir: cwd, userDir, approvals, force, dryRun });
            result = importReviewed(kind, options());
            left = result.waiting.map((w) => w.name);
            if (result.waiting.length) {
              const reviewed = await askAbout({ waiting: result.waiting, approvals, level, ctx });
              left = reviewed.left;
              if (reviewed.approved.length) result = importReviewed(kind, options());
            }
            if (level === "local" && !dryRun && result.imported.length + result.updated.length + result.unchanged.length > 0) appendIgnored(cwd, spec.ignored);
          }
          const done = result.imported.length + result.updated.length;
          const count = built.item ? `${built.item.handlers?.length ?? built.item.deny.length + built.item.ask.length + built.item.allow.length} ${built.item.handlers ? "handler" : "rule"}${(built.item.handlers?.length ?? built.item.deny.length + built.item.ask.length + built.item.allow.length) === 1 ? "" : "s"}` : "";
          lines.push(`${dryRun ? "would import" : "imported"} ${plural(done, noun)}${built.item ? ` (${count})` : ""}, unchanged ${result.unchanged.length} from ${printable(source.label)} at the ${level} level${dryRun ? " (dry run, nothing written)" : ""}`);
          for (const { name, reason } of [...built.skipped, ...result.skipped]) lines.push(`  skipped ${printable(name)}: ${printable(reason)}`);
          for (const text of built.notes) lines.push(`  ${printable(text)}`);
          if (left.length && !dryRun) lines.push(`  ${printable(left.join(", "))}: ${waitingText}`);
          stdout.write(`${lines.map((line, i) => (i === 0 ? `toolgate: ${line}` : line)).join("\n")}\n`);
          if (left.length) return 2;
          return done + result.unchanged.length === 0 && (built.skipped.length + result.skipped.length > 0 || !built.item) ? 1 : 0;
        } finally {
          built.cleanup();
        }
      }
      if (action === "remove") {
        const result = removeAssets(kind, { projectDir: cwd, userDir, level, names: rest, source: sourceFilter, force, dryRun, env });
        if (!dryRun) {
          for (const name of result.removed ?? []) {
            if (spec.onRemove) spec.onRemove(approvals, { cwd, level, name });
            else approvals.revoke(keyOf(cwd, level, name));
          }
          approvals.save();
        }
        stdout.write(json ? `${jsonSafe(JSON.stringify(result, null, 2))}\n` : formatRemove(result, { dryRun }));
        return removeExitCode(result);
      }
    } catch (err) {
      stderr.write(`toolgate ${plurals}: ${printable(err.message)}\n`);
      return 1;
    }
    stderr.write(`toolgate ${plurals}: expected install, update, status, list, review, import or remove\n`);
    return 1;
  };
}
