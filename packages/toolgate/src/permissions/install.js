// The permission kind: `toolgate permissions install <source>` copies the permission units of a remote repository (one
// `<name>.json` of `deny`, `ask` and `allow` rules) into `.toolgate/permissions/`, normalized. A unit is `review`: it is
// applied only with an approval of its exact content. Inside it, `deny` and `ask` only narrow what the agent may do, but
// `allow` is a grant: it needs a second, separate yes (`--grant`), kept for the hash of the allow list alone.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { printable } from "../assets/common.js";
import { unitKey } from "../assets/approval.js";
import { installNameProblem } from "../skills/install.js";
import { parsePermission, renderPermission } from "./parse.js";

export const PERMISSIONS_DIR = path.join(".toolgate", "permissions");
export const PERMISSIONS_LOCK_FILE = path.join(".toolgate", "permissions.lock.json");
export const PERMISSIONS_LOCAL_DIR = path.join(".toolgate", "permissions.local");
export const PERMISSIONS_LOCAL_LOCK_FILE = path.join(".toolgate", "permissions.local.lock.json");
export const PERMISSIONS_LOCAL_IGNORED = [`${PERMISSIONS_LOCAL_DIR}/`, PERMISSIONS_LOCAL_LOCK_FILE].map((entry) => entry.split(path.sep).join("/"));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (file) => sha(fs.readFileSync(file));

/**
 * An `allow` rule that opens a whole tool or a whole server: no specifier, an empty one (spaces do not matter), or a match-everything
 * one; and for a server, its bare name, `mcp__server__` and `mcp__server__*`.
 */
export function isBroad(rule) {
  return (/^[A-Za-z]\w*$/.test(rule) && !rule.startsWith("mcp__")) || /^[A-Za-z]\w*\(\s*(\*{1,2}|:\*)?\s*\)$/.test(rule) || /^mcp__(?:[A-Za-z0-9-]|_(?!_))+(?:__\*?)?$/.test(rule);
}

/** The text shown for a unit; the allow rules say that they are a grant and which of them are broad. */
export function previewPermission(permission) {
  const lines = [`${printable(permission.name)}: ${printable(permission.description)}`];
  for (const list of ["deny", "ask"]) if (permission[list].length) lines.push(`  ${list} (narrows):`, ...permission[list].map((rule) => `    ${printable(rule)}`));
  if (permission.allow.length) {
    lines.push("  allow (a GRANT, inactive until you grant it):");
    for (const rule of permission.allow) lines.push(`    ${printable(rule)}${isBroad(rule) ? "   <- BROAD: every use of that tool or server" : ""}`);
  }
  return lines.join("\n");
}

/** The hash a grant is for: the allow rules alone, so a change in `deny` or `ask` does not ask for the grant again. */
export const grantHash = (permission) => sha(JSON.stringify(permission.allow));
export const grantKeyOf = ({ projectDir, level, name }) => unitKey({ projectDir, level, kind: "permission-grant", name });
/** Whether the allow rules of a unit are granted (a unit with none has nothing to grant). */
export const isGranted = (approvals, { projectDir, level, permission }) => permission.allow.length === 0 || approvals.has(grantKeyOf({ projectDir, level, name: permission.name }), grantHash(permission));

function discover(base) {
  const items = [];
  const skipped = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    if (!entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    const stem = entry.name.slice(0, -5);
    const file = path.join(base, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      skipped.push({ name: stem, reason: "is a symlink or not a file, and symlinks are not followed" });
      continue;
    }
    try {
      const permission = parsePermission(file, { relative: entry.name });
      if (permission.name !== stem) throw new Error(`the name "${permission.name}" must be the name of its file, "${stem}"`);
      const problem = installNameProblem(permission.name);
      if (problem) throw new Error(problem);
      const other = items.find((item) => item.name.toLowerCase() === permission.name.toLowerCase());
      if (other) throw new Error(`"${permission.name}" differs only in case from "${other.name}"`);
      items.push({ ...permission, dir: file, text: renderPermission(permission) });
    } catch (err) {
      skipped.push({ name: stem, reason: err.message.replace(`${file}: `, "").split("\n")[0] });
    }
  }
  return { items, skipped };
}

/**
 * The permission units of the stores of every level, with their level, and the names used at two levels. `scanPermissions`
 * makes the second an error; the launch reads both, because rules that only narrow are applied even then.
 */
export function readPermissions({ projectDir, userDir, levels = ["user", "project", "local"] }) {
  const found = [];
  for (const level of levels) {
    if (level === "user" && !userDir) continue;
    const store = level === "project" ? PERMISSION_KIND : PERMISSION_KIND.stores[level];
    const dir = path.join(level === "user" ? userDir : projectDir, store.storeDir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      if (!entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
      const stem = entry.name.slice(0, -5);
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        found.push({ name: stem, level, error: "is a link or not a file" });
        continue;
      }
      try {
        const permission = parsePermission(file, { relative: entry.name });
        if (permission.name !== stem) throw new Error(`the name "${permission.name}" must be the name of its file, "${stem}"`);
        const problem = installNameProblem(permission.name);
        if (problem) throw new Error(problem);
        found.push({ ...permission, level, hash: hashFile(file) });
      } catch (err) {
        found.push({ name: stem, level, error: err.message.replace(`${file}: `, "").split("\n")[0] });
      }
    }
  }
  const seen = new Map();
  const clashes = [];
  for (const unit of found) {
    if (unit.error) continue;
    if (seen.has(unit.name)) clashes.push({ name: unit.name, message: `permission "${unit.name}" exists at the ${seen.get(unit.name)} and ${unit.level} levels; remove one (a permission never hides another)` });
    else seen.set(unit.name, unit.level);
  }
  return { found, clashes };
}

/** The permission units of the stores of every level, with their level; each unit whose name is used at two levels is an error, the rest are not. */
export function scanPermissions(options) {
  const { found, clashes } = readPermissions(options);
  // Only the units that clash are reported as such: the others are listed and reviewed as usual.
  const clashing = new Set(clashes.map((clash) => clash.name));
  return found.map((unit) => (!unit.error && clashing.has(unit.name) ? { name: unit.name, level: unit.level, error: clashes.find((clash) => clash.name === unit.name).message } : unit));
}

/** The descriptor of the permission kind (see `HOOK_KIND`). */
export const PERMISSION_KIND = Object.freeze({
  noun: "permission",
  plural: "permissions",
  storeDir: PERMISSIONS_DIR,
  lockFile: PERMISSIONS_LOCK_FILE,
  stores: Object.freeze({
    user: Object.freeze({ storeDir: "permissions", lockFile: "permissions.lock.json" }),
    local: Object.freeze({ storeDir: PERMISSIONS_LOCAL_DIR, lockFile: PERMISSIONS_LOCAL_LOCK_FILE }),
  }),
  lockKey: "permissions",
  review: true,
  defaultBases: Object.freeze(["permissions", ".toolgate/permissions"]),
  discover,
  hash: hashFile,
  sourceHash: (file, item) => sha(item.text),
  copy: (file, to, item) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, item.text, { mode: 0o644 });
  },
  fileName: (name) => `${name}.json`,
  lookedFor: (subdir) => `<name>.json files in ${subdir}`,
  unitName: (entry) => ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".json") ? entry.name.slice(0, -5) : null),
  unitText: (file) => fs.readFileSync(file, "utf8"),
  describe: (file) => ({ description: parsePermission(file).description, mcps: [] }),
  skippedName: (entry, located) => path.relative(located.subdir, entry.path ?? "").split(path.sep).join("/").replace(/\.json$/, ""),
  preview: (permission, options) => previewPermission(options?.stored ? parsePermission(options.dir) : permission),
  // What a waiting unit also carries: the allow rules and the hash a grant for them is recorded under.
  waitingExtra: (item) => ({ allow: item.allow, grantHash: grantHash(item) }),
  // Said by install and update: allow rules are stored, but nothing passes them on without a grant.
  remark: (item) => (item.allow.length ? `${item.allow.length} allow ${item.allow.length === 1 ? "rule is" : "rules are"} not granted until you run with --grant` : null),
  clash: (name, { level, projectDir, userDir }) => {
    for (const other of ["user", "project", "local"].filter((l) => l !== level)) {
      if (other === "user" && !userDir) continue;
      const store = other === "project" ? PERMISSION_KIND : PERMISSION_KIND.stores[other];
      if (fs.existsSync(path.join(other === "user" ? userDir : projectDir, store.storeDir, `${name}.json`))) return other;
    }
    return null;
  },
});
