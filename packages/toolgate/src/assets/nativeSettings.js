// Reading the settings file of an agent that toolgate imports from (Claude Code's `settings.json`): a plain file, of a sane
// size, inside the folder it should be in. The original is never changed.
import fs from "node:fs";
import path from "node:path";
import { insideBase } from "../commands/native.js";
import { parseJson } from "./common.js";

export const MAX_SETTINGS_BYTES = 1024 * 1024;

/** Where Claude Code keeps the settings of a level, and how the import calls it. */
export function claudeSettingsFile({ level, projectDir, homeDir }) {
  if (level === "user") return { file: path.join(homeDir, ".claude", "settings.json"), label: "~/.claude/settings.json", base: homeDir };
  const name = level === "local" ? "settings.local.json" : "settings.json";
  return { file: path.join(projectDir, ".claude", name), label: `.claude/${name}`, base: projectDir };
}

/**
 * @returns {{ data: object | null, note: string | null }} `data` is null when there is nothing to import, with the reason as `note`
 */
export function readSettings({ file, label, base }) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) return { data: null, note: `${label} does not exist, so there is nothing to import` };
  if (info.isSymbolicLink() || !info.isFile()) return { data: null, note: `${label} is a symlink or not a file, and is not read` };
  if (!insideBase(file, base)) return { data: null, note: `${label} resolves outside ${path.basename(base) || "its folder"}, and is not read` };
  if (info.size > MAX_SETTINGS_BYTES) return { data: null, note: `${label} is larger than ${MAX_SETTINGS_BYTES} bytes, and is not read` };
  try {
    const data = parseJson(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (data === null || typeof data !== "object" || Array.isArray(data)) return { data: null, note: `${label} does not hold a JSON object` };
    return { data, note: null };
  } catch (err) {
    return { data: null, note: `${label} is not valid JSON (${err.message.split("\n")[0]})` };
  }
}
