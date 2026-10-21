// `toolgate permissions import`: the permissions Claude Code already has in its settings file become one permission unit at
// the same level. Each rule is checked by the reader of an installed unit and one that is not valid is skipped with its reason;
// `defaultMode`, `additionalDirectories` and the rest are not kept. The original file is never changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printable } from "../assets/common.js";
import { parsePermission, renderPermission } from "./parse.js";

export const NATIVE_PERMISSION_NAME = "native-claude";
const LISTS = ["deny", "ask", "allow"];

/**
 * @returns {{ item: object | null, skipped: Array<{ name: string, reason: string }>, notes: string[], cleanup: () => void }}
 */
export function buildPermissionImport({ data, label, name: unitName = NATIVE_PERMISSION_NAME }) {
  const skipped = [];
  const notes = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-import-"));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  try {
    const given = data.permissions;
    if (given === undefined) return { item: null, skipped, notes: [`${label} has no permissions`], cleanup };
    if (given === null || typeof given !== "object" || Array.isArray(given)) return { item: null, skipped, notes: [`${label}: "permissions" is not an object`], cleanup };
    const rules = { deny: [], ask: [], allow: [] };
    const probe = path.join(work, "probe.json");
    for (const list of LISTS) {
      if (given[list] === undefined) continue;
      if (!Array.isArray(given[list])) {
        skipped.push({ name: list, reason: `"${list}" is not a list of rules` });
        continue;
      }
      for (const rule of given[list]) {
        // The same reader as an installed unit decides whether a rule is valid.
        fs.writeFileSync(probe, JSON.stringify({ name: NATIVE_PERMISSION_NAME, description: "check", [list]: [rule] }));
        try {
          parsePermission(probe, { relative: `${NATIVE_PERMISSION_NAME}.json` });
          rules[list].push(rule);
        } catch (err) {
          skipped.push({ name: `${list}: ${printable(String(rule)).slice(0, 60)}`, reason: err.message.replace(`${probe}: `, "").split("\n")[0] });
        }
      }
    }
    const dropped = Object.keys(given).filter((key) => !LISTS.includes(key)).sort();
    if (rules.deny.length + rules.ask.length + rules.allow.length === 0) return { item: null, skipped, notes: [...notes, `${label}: no rule could be imported`], cleanup };
    const file = path.join(work, `${unitName}.json`);
    fs.writeFileSync(file, JSON.stringify({ name: unitName, description: `Imported from ${label}`, ...rules }));
    const permission = parsePermission(file, { relative: `${unitName}.json` });
    const item = { ...permission, dropped, dir: file, text: renderPermission(permission) };
    if (dropped.length) notes.push(`${label}: not kept (they can widen what the agent may do): ${dropped.map(printable).join(", ")}`);
    notes.push(`the original in ${label} is not changed and keeps applying`);
    return { item, skipped, notes, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
