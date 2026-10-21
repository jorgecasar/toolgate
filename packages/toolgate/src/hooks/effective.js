// What the next launch passes to an agent from the approved hooks and the permission units: the effective set.
//   - A hook is applied only when its stored content hash is approved on this machine; otherwise it is reported as pending.
//   - `deny` and `ask` rules only narrow, so they are applied from every readable unit, approved or not.
//   - `allow` rules are applied only when their unit is approved AND their allow list is granted.
// Hook scripts run from a copy made for this launch, checked against the approved hash and removed on exit, so a file changed
// after the check is never run. Nothing here writes to an agent's own files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadApprovals, unitKey } from "../assets/approval.js";
import { userConfigDir } from "../config.js";
import { opencodeEnv } from "../permissions/opencode.js";
import { hashDir } from "../skills/install.js";
import { isGranted, readPermissions } from "../permissions/install.js";
import { scanHooks } from "./install.js";

const levelsOf = (config, kind) => ["user", "project", "local"].filter((level) => !(config?.[kind]?.disabledLevels ?? []).includes(level));

/**
 * @returns {{ hooks: object[], permissions: { deny: string[], ask: string[], allow: string[] }, pending: Array<{ kind: string, name: string, level: string, reason: string }>, problems: string[] }}
 */
export function effectiveSet({ projectDir, userDir, config, approvals }) {
  const pending = [];
  const problems = [];
  const hooks = [];
  const permissions = { deny: [], ask: [], allow: [] };
  // The two parts are read apart: a hook store that cannot be read (the same name at two levels) must not take the deny and
  // ask rules with it, which only narrow and are always applied; and the other way round.
  try {
    for (const unit of scanHooks({ projectDir, userDir, levels: levelsOf(config, "hooks") })) {
      if (unit.error) {
        problems.push(`hook ${unit.name} (${unit.level}): ${unit.error}`);
        continue;
      }
      if (approvals.has(unitKey({ projectDir, level: unit.level, kind: "hook", name: unit.name }), unit.hash)) hooks.push(unit);
      else pending.push({ kind: "hook", name: unit.name, level: unit.level, reason: "not approved on this machine, or changed since it was" });
    }
  } catch (err) {
    problems.push(`hooks: ${err.message.split("\n")[0]}`);
  }
  try {
    const { found, clashes } = readPermissions({ projectDir, userDir, levels: levelsOf(config, "permissions") });
    // A name used at two levels is said; what only narrows is still applied, the allow rules of that name are not.
    for (const clash of clashes) problems.push(`permissions: ${clash.message}`);
    const ambiguous = new Set(clashes.map((c) => c.name));
    for (const unit of found) {
      if (unit.error) {
        problems.push(`permission ${unit.name} (${unit.level}): ${unit.error}`);
        continue;
      }
      // Narrowing needs no approval: a rule that denies or asks is applied from a unit that was not reviewed too.
      permissions.deny.push(...unit.deny);
      permissions.ask.push(...unit.ask);
      const approved = approvals.has(unitKey({ projectDir, level: unit.level, kind: "permission", name: unit.name }), unit.hash);
      if (unit.allow.length === 0) continue;
      if (ambiguous.has(unit.name)) continue;
      if (approved && isGranted(approvals, { projectDir, level: unit.level, permission: unit })) permissions.allow.push(...unit.allow);
      else pending.push({ kind: "permission", name: unit.name, level: unit.level, reason: approved ? "its allow rules are not granted" : "not approved on this machine, or changed since it was" });
    }
  } catch (err) {
    problems.push(`permissions: ${err.message.split("\n")[0]}`);
  }
  for (const list of Object.keys(permissions)) permissions[list] = [...new Set(permissions[list])];
  return { hooks, permissions, pending, problems };
}

/**
 * Copies the applied hooks to a private folder for this launch, one per unit, and checks each copy against the approved
 * hash. A unit whose copy does not match is left out and reported. The copy is removed by `cleanup`.
 * @returns {{ root: string, units: Map<string, string>, skipped: string[], cleanup: () => void }}
 */
export function copyHookUnits(hooks, { tmpDir = os.tmpdir(), mkdtemp = fs.mkdtempSync } = {}) {
  const units = new Map();
  const skipped = [];
  if (hooks.length === 0) return { root: null, units, skipped, cleanup: () => {} };
  // A folder that is created now, with a name nobody can guess, and checked: it is ours (the owner) and private (0700).
  // If anything below throws, it is removed before the error goes on.
  const root = mkdtemp(path.join(tmpDir, "toolgate-hooks-"));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    const info = fs.lstatSync(root);
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`${root} is not a private folder of this user`);
    copyInto(root, hooks, units, skipped);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { root, units, skipped, cleanup };
}

function copyInto(root, hooks, units, skipped) {
  for (const hook of hooks) {
    const target = path.join(root, hook.name);
    try {
      for (const file of hook.files) {
        const to = path.join(target, file);
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        // Read once from the store and written to the copy: what is checked below is what will run.
        fs.writeFileSync(to, fs.readFileSync(path.join(hook.dir, file)), { flag: "wx", mode: 0o600 });
      }
      if (hashDir(target) !== hook.hash) throw new Error("changed while it was copied");
      // Only the files that a handler runs become executable.
      for (const handler of hook.handlers) if (hook.files.includes(handler.command)) fs.chmodSync(path.join(target, handler.command), 0o700);
      units.set(hook.name, target);
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true });
      skipped.push(`${hook.name}: ${err.message.split("\n")[0]}`);
    }
  }
}

/** The `hooks` object of a Claude Code settings file for the applied units: handlers grouped by event and matcher. */
export function claudeHooks(hooks, units) {
  const byEvent = new Map();
  for (const hook of hooks) {
    const dir = units.get(hook.name);
    if (!dir) continue;
    for (const handler of hook.handlers) {
      const entry = { type: "command", command: hook.files.includes(handler.command) ? path.join(dir, handler.command) : handler.command, args: handler.args };
      if (handler.if !== undefined) entry.if = handler.if;
      if (handler.timeout !== undefined) entry.timeout = handler.timeout;
      const groups = byEvent.get(handler.event) ?? [];
      let group = groups.find((g) => g.matcher === handler.matcher);
      if (!group) {
        group = { ...(handler.matcher === undefined ? {} : { matcher: handler.matcher }), hooks: [] };
        groups.push(group);
        byEvent.set(handler.event, groups);
      }
      group.hooks.push(entry);
    }
  }
  return Object.fromEntries(byEvent);
}

/** The settings keys toolgate adds for the effective set (empty parts are left out). */
export function claudeSettingsFor(effective, units) {
  const settings = {};
  const hooks = claudeHooks(effective.hooks, units);
  if (Object.keys(hooks).length) settings.hooks = hooks;
  const permissions = Object.fromEntries(Object.entries(effective.permissions).filter(([, rules]) => rules.length));
  if (Object.keys(permissions).length) settings.permissions = permissions;
  return settings;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Merges toolgate's settings over the user's own `--settings`: `hooks` and `permissions` are combined (lists concatenated,
 * the user's first), never replaced; any other key of toolgate wins as before. The user's own `disableAllHooks` is kept.
 */
export function mergeSettings(theirs, ours) {
  const merged = { ...theirs, ...ours };
  if (isObject(theirs.hooks) || isObject(ours.hooks)) {
    const hooks = {};
    for (const source of [theirs.hooks, ours.hooks]) {
      if (!isObject(source)) continue;
      for (const [event, groups] of Object.entries(source)) hooks[event] = [...(hooks[event] ?? []), ...(Array.isArray(groups) ? groups : [])];
    }
    merged.hooks = hooks;
  }
  if (isObject(theirs.permissions) || isObject(ours.permissions)) {
    const permissions = { ...(isObject(theirs.permissions) ? theirs.permissions : {}) };
    for (const [key, rules] of Object.entries(isObject(ours.permissions) ? ours.permissions : {})) {
      permissions[key] = Array.isArray(rules) ? [...new Set([...(Array.isArray(permissions[key]) ? permissions[key] : []), ...rules])] : rules;
    }
    merged.permissions = permissions;
  }
  return merged;
}

/** The folder the hook scripts of a launch are copied to, as `status --effective` shows it (the real one is made per launch). */
export const COPY_PLACEHOLDER = "<private copy>";

/**
 * What a launch of this adapter passes on, computed and nothing else: it writes no file and makes no copy. The launch
 * (`approvedForLaunch` in cli.js) and `status --effective` both read it, so the second cannot say what the first does not do.
 * `effective` is the set cut to what the adapter takes; `preview` the Claude settings with the copy folder as a placeholder.
 */
export function launchPlan({ adapterModule, config, cwd, env, inspect = false }) {
  const capability = adapterModule.capability ?? {};
  const hooksKind = capability.hooks?.kind ?? "unknown";
  const permissionsKind = capability.permissions?.kind ?? "unknown";
  const takesHooks = hooksKind === "settingsFlag";
  const takesPermissions = permissionsKind === "settingsFlag";
  const takesEnv = permissionsKind === "configEnv";
  const plan = { hooksKind, permissionsKind, applies: takesHooks || takesPermissions || takesEnv, takesHooks, takesPermissions, takesEnv, effective: null, approvalsProblem: null, error: null, env: {}, unmapped: [], note: null, preview: {} };
  if (!plan.applies && !inspect) return plan;
  try {
    const userDir = userConfigDir({ cwd, env });
    const approvals = loadApprovals(userDir);
    plan.approvalsProblem = approvals.problem ?? null;
    plan.effective = effectiveSet({ projectDir: cwd, userDir, config, approvals });
  } catch (err) {
    plan.error = err.message.split("\n")[0];
    return plan;
  }
  if (!plan.applies) return plan;
  const effective = plan.effective;
  if (!takesHooks) effective.hooks = [];
  if (!takesPermissions && !takesEnv) effective.permissions = { deny: [], ask: [], allow: [] };
  if (takesEnv) {
    const { env: added, unmapped, note } = opencodeEnv(effective.permissions, env);
    Object.assign(plan, { env: added, unmapped, note });
  } else {
    plan.preview = claudeSettingsFor(effective, new Map(effective.hooks.map((hook) => [hook.name, `${COPY_PLACEHOLDER}/${hook.name}`])));
  }
  return plan;
}
