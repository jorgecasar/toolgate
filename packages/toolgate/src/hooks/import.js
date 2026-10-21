// `toolgate hooks import`: the hooks Claude Code already has in its settings file become one hook unit at the same level.
// Only a command in exec form is imported (`command` + `args`); a shell string is skipped with the way to rewrite it, a script
// is copied into the unit only when it is a plain file inside the project (or the home folder for the user level), and every
// handler is checked by the same reader as an installed unit. The original settings file is never changed, so it keeps running.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printable } from "../assets/common.js";
import { insideBase } from "../commands/native.js";
import { parseHook, renderHook, MAX_HANDLERS } from "./parse.js";

// Whether a folder between the base and the file is a symlink (or is gone): the file would be read from wherever the link leads.
function viaLink(file, base) {
  let current = base;
  for (const part of path.relative(base, path.dirname(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink()) return true;
  }
  return false;
}
export const NATIVE_HOOK_NAME = "native-claude";
const HANDLER_FIELDS = ["matcher", "if", "timeout"];

// A handler as a one-handler unit in `dir`, read by the same parser as an installed hook.
function check(dir, handler, scripts) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [to, from] of scripts) {
    fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
    fs.copyFileSync(from, path.join(dir, to));
  }
  fs.writeFileSync(path.join(dir, "HOOK.json"), JSON.stringify({ name: NATIVE_HOOK_NAME, description: "check", handlers: [handler] }));
  return parseHook(dir, { relative: NATIVE_HOOK_NAME });
}

/**
 * @param {{ data: object, label: string, base: string }} options `base` is the folder a script has to be inside
 * @returns {{ item: object | null, skipped: Array<{ name: string, reason: string }>, notes: string[], cleanup: () => void }}
 */
export function buildHookImport({ data, label, base, name: unitName = NATIVE_HOOK_NAME }) {
  const skipped = [];
  const notes = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-import-"));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  try {
    const hooks = data.hooks;
    if (hooks === undefined) return { item: null, skipped, notes: [`${label} has no hooks`], cleanup };
    if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return { item: null, skipped, notes: [`${label}: "hooks" is not an object`], cleanup };
    const accepted = [];
    const dropped = new Set();
    const scripts = new Map(); // path inside the unit -> file of the project
    let counter = 0;
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) {
        skipped.push({ name: event, reason: "is not a list of hook groups" });
        continue;
      }
      for (const group of groups) {
        const handlers = group !== null && typeof group === "object" && Array.isArray(group.hooks) ? group.hooks : null;
        if (!handlers) {
          skipped.push({ name: event, reason: "a group without a hooks list" });
          continue;
        }
        for (const raw of handlers) {
          const name = `${event}#${++counter}`;
          if (raw === null || typeof raw !== "object" || raw.type !== "command") {
            skipped.push({ name, reason: `only a command is imported (this one is "${printable(String(raw?.type))}")` });
            continue;
          }
          if (!Array.isArray(raw.args)) {
            skipped.push({ name, reason: "shell form: rewrite it as command and args (the program and each argument apart), then import again" });
            continue;
          }
          const handler = { type: "command", event, command: raw.command, args: raw.args };
          if (group.matcher !== undefined) handler.matcher = group.matcher;
          for (const field of HANDLER_FIELDS.filter((f) => f !== "matcher")) if (raw[field] !== undefined) handler[field] = raw[field];
          const staged = new Map(scripts);
          const lost = Object.keys(raw).filter((key) => !["type", "command", "args", ...HANDLER_FIELDS].includes(key)).sort();
          // A command with a path is a script: it has to be a plain file inside `base`, and goes into the unit.
          if (typeof raw.command === "string" && raw.command.includes("/")) {
            const from = path.resolve(base, raw.command);
            const info = fs.lstatSync(from, { throwIfNoEntry: false });
            if (!info || info.isSymbolicLink() || !info.isFile()) {
              skipped.push({ name, reason: `the script ${printable(raw.command).slice(0, 80)} is not a plain file (missing, or a symlink)` });
              continue;
            }
            if (!insideBase(from, base)) {
              skipped.push({ name, reason: `the script ${printable(raw.command).slice(0, 80)} is not inside ${path.basename(base) || "the project"}` });
              continue;
            }
            if (viaLink(from, base)) {
              skipped.push({ name, reason: `the script ${printable(raw.command).slice(0, 80)} is reached through a symlinked folder, and symlinks are not followed` });
              continue;
            }
            const same = [...staged].find(([, file]) => file === from);
            let inside = same ? same[0] : `scripts/${path.basename(from)}`;
            // Two scripts with one base name must not overwrite each other: take a free prefix.
            for (let n = 2; !same && staged.has(inside); n++) inside = `scripts/${n}-${path.basename(from)}`;
            staged.set(inside, from);
            handler.command = inside;
          }
          try {
            check(path.join(work, "one"), handler, staged);
          } catch (err) {
            skipped.push({ name, reason: err.message.replace(`${path.join(work, "one")}: `, "").split("\n")[0] });
            continue;
          }
          if (accepted.length >= MAX_HANDLERS) {
            skipped.push({ name, reason: `over the limit of ${MAX_HANDLERS} handlers in one unit` });
            continue;
          }
          for (const [to, from] of staged) scripts.set(to, from);
          accepted.push(handler);
          for (const key of lost) dropped.add(key);
          if (lost.length) notes.push(`${label}: ${name} does not keep ${lost.map(printable).join(", ")}`);
        }
      }
    }
    if (accepted.length === 0) return { item: null, skipped, notes: [...notes, `${label}: no handler could be imported`], cleanup };
    const dir = path.join(work, unitName);
    fs.mkdirSync(dir, { recursive: true });
    for (const [to, from] of scripts) {
      fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      fs.copyFileSync(from, path.join(dir, to));
    }
    fs.writeFileSync(path.join(dir, "HOOK.json"), JSON.stringify({ name: unitName, description: `Imported from ${label}`, handlers: accepted }));
    const hook = parseHook(dir, { relative: unitName });
    notes.push(`the original in ${label} is not changed and keeps running: until you remove those hooks from it, they run twice`);
    return { item: { ...hook, dropped: [...dropped].sort() }, skipped, notes, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export { renderHook };
