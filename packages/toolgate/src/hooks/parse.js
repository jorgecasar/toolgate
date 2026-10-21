// Hook reader: turns a hook unit (a folder with `HOOK.json` and the scripts it runs) into the neutral form toolgate
// stores, shows and applies. A hook runs a command on the user's machine, so only the narrowest shape is accepted: a
// `command` handler in exec form (`command` + `args`, no shell), whose command is a file of the unit or a bare program
// name. Everything else is dropped and listed, or refused. Nothing here runs anything.
import fs from "node:fs";
import path from "node:path";
import { RESERVED_NAMES, SAFE_NAME, parseJson, printable } from "../assets/common.js";

/** @typedef {{ event: string, matcher?: string, if?: string, command: string, args: string[], timeout?: number }} Handler */
/** @typedef {{ name: string, description: string, handlers: Handler[], files: string[], dir: string, kind: "hook", dropped: string[] }} Hook */

/** The events Claude Code documents (https://code.claude.com/docs/en/hooks); an unknown one is an error, not a guess. */
export const HOOK_EVENTS = Object.freeze([
  "SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PermissionRequest", "PermissionDenied",
  "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "MessageDisplay", "SubagentStart", "SubagentStop",
  "TaskCreated", "TaskCompleted", "Stop", "StopFailure", "TeammateIdle", "InstructionsLoaded", "ConfigChange", "CwdChanged",
  "DirectoryAdded", "FileChanged", "WorktreeCreate", "WorktreeRemove", "PreCompact", "PostCompact", "PreModelSwitch",
  "PostModelSwitch", "Elicitation", "ElicitationResult", "SessionEnd",
]);
export const RESERVED_HOOK_NAMES = new Set([...RESERVED_NAMES, "toolgate"]);
export const MAX_HOOK_FILE_BYTES = 16 * 1024;
export const MAX_UNIT_BYTES = 1024 * 1024;
export const MAX_UNIT_FILES = 20;
export const MAX_HANDLERS = 16;
export const MAX_ARGS = 32;
export const MAX_TEXT = 512;
const MAX_TIMEOUT = 600;
const PROGRAM = /^[\w.+-]{1,100}$/;
// What looks like an expansion (`$NAME`, `${...}`, `$(...)`, a backtick, `%NAME%`): in exec form nothing expands it today, but an adapter
// could, and the meaning of a hook must not depend on the agent that applies it.
const EXPANSION = /\$[A-Za-z_{(]|`|%[A-Za-z_]\w*%/;
// What a handler may carry besides its type; everything else is dropped.
const HANDLER_KEYS = new Set(["type", "event", "matcher", "if", "command", "args", "timeout"]);
const TOP_KEYS = new Set(["name", "description", "handlers"]);

const fail = (dir, message) => new Error(`${dir}: ${message}`);
const plainText = (value) => typeof value === "string" && value.length > 0 && Array.from(value).length <= MAX_TEXT && printable(value) === value;

// The files of the unit as relative paths. A symlink or anything that is not a regular file is an error: it could point anywhere.
function unitFiles(dir) {
  const found = [];
  let bytes = 0;
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw fail(dir, `${path.relative(dir, full)} is a symlink and symlinks are not followed`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        found.push(path.relative(dir, full).split(path.sep).join("/"));
        bytes += fs.statSync(full).size;
        if (found.length > MAX_UNIT_FILES) throw fail(dir, `more than ${MAX_UNIT_FILES} files`);
        if (bytes > MAX_UNIT_BYTES) throw fail(dir, `larger than ${MAX_UNIT_BYTES} bytes`);
      } else throw fail(dir, `${path.relative(dir, full)} is not a regular file`);
    }
  };
  visit(dir);
  return found.sort();
}

// `command`: a bare program name, or a path to a file of the unit.
function checkCommand(dir, command, files) {
  if (typeof command !== "string" || command === "") throw fail(dir, 'a handler needs a "command"');
  if (EXPANSION.test(command)) throw fail(dir, `command ${printable(command).slice(0, 60)} holds a placeholder or substitution; toolgate generates the real path`);
  // A name made only of dots is not a program (`.`, `..`).
  if (PROGRAM.test(command) && !/^\.+$/.test(command)) return;
  const parts = command.split("/");
  // An absolute path starts with an empty part, so it fails the same test.
  const plain = !command.includes("\\") && parts.every((part) => part !== "" && !/^\.+$/.test(part) && /^[\w.+-]+$/.test(part));
  if (!plain) throw fail(dir, `command ${printable(command).slice(0, 60)} must be a bare program name or a relative path inside the unit (no "..", no absolute path)`);
  if (!files.includes(command)) throw fail(dir, `command ${printable(command).slice(0, 60)} is not a file of the unit`);
}

/**
 * @param {string} dir The folder of the unit
 * @param {Object} [options]
 * @param {string} [options.relative] Name from the folder when the file has none
 * @returns {Hook}
 */
export function parseHook(dir, { relative } = {}) {
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw fail(dir, "a hook is a folder, and a symlink is not followed");
  const files = unitFiles(dir);
  const file = path.join(dir, "HOOK.json");
  const fileInfo = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!fileInfo || !fileInfo.isFile()) throw fail(dir, "HOOK.json is missing");
  if (fileInfo.size > MAX_HOOK_FILE_BYTES) throw fail(dir, `HOOK.json is larger than ${MAX_HOOK_FILE_BYTES} bytes`);
  let data;
  try {
    data = parseJson(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    throw fail(dir, `HOOK.json is not valid JSON (${err.message.split("\n")[0]})`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw fail(dir, "HOOK.json must hold an object");

  const name = data.name ?? relative ?? path.basename(dir);
  if (typeof name !== "string" || !SAFE_NAME.test(name) || RESERVED_HOOK_NAMES.has(name)) throw fail(dir, `"${printable(String(name)).slice(0, 60)}" cannot be used as a hook name`);
  if (!plainText(data.description)) throw fail(dir, 'HOOK.json needs a "description" (plain text, one line)');
  if (!Array.isArray(data.handlers) || data.handlers.length === 0) throw fail(dir, 'HOOK.json needs a non-empty "handlers" list');
  if (data.handlers.length > MAX_HANDLERS) throw fail(dir, `more than ${MAX_HANDLERS} handlers`);

  const dropped = new Set(Object.keys(data).filter((key) => !TOP_KEYS.has(key)));
  const handlers = [];
  for (const raw of data.handlers) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw fail(dir, "a handler must be an object");
    // Only a command runs a program. The other kinds (http, mcp_tool, prompt, agent) are not accepted: dropped and listed.
    if (raw.type !== "command") {
      dropped.add(`handler:${printable(String(raw.type)).slice(0, 30)}`);
      continue;
    }
    for (const key of Object.keys(raw)) if (!HANDLER_KEYS.has(key)) dropped.add(key);
    if (!HOOK_EVENTS.includes(raw.event)) throw fail(dir, `"${printable(String(raw.event)).slice(0, 40)}" is not a hook event Claude Code documents`);
    if (!Array.isArray(raw.args)) throw fail(dir, "shell form is not accepted: write the handler as command and args (the program and each argument apart)");
    checkCommand(dir, raw.command, files);
    if (raw.args.length > MAX_ARGS) throw fail(dir, `more than ${MAX_ARGS} args`);
    for (const arg of raw.args) {
      if (!plainText(arg) && arg !== "") throw fail(dir, "an arg must be plain text of at most 512 characters");
      if (EXPANSION.test(arg)) throw fail(dir, `arg ${printable(arg).slice(0, 40)} holds a placeholder, variable or substitution`);
    }
    for (const key of ["matcher", "if"]) {
      if (raw[key] !== undefined && !plainText(raw[key])) throw fail(dir, `"${key}" must be plain text of at most ${MAX_TEXT} characters`);
    }
    if (raw.timeout !== undefined && !(Number.isInteger(raw.timeout) && raw.timeout >= 1 && raw.timeout <= MAX_TIMEOUT)) throw fail(dir, `"timeout" must be a whole number of seconds from 1 to ${MAX_TIMEOUT}`);
    handlers.push({
      event: raw.event,
      ...(raw.matcher === undefined ? {} : { matcher: raw.matcher }),
      ...(raw.if === undefined ? {} : { if: raw.if }),
      command: raw.command,
      args: [...raw.args],
      ...(raw.timeout === undefined ? {} : { timeout: raw.timeout }),
    });
  }
  if (handlers.length === 0) throw fail(dir, "no handler is a command in exec form; nothing would run");
  return { name, description: data.description, handlers, files, dir, kind: "hook", dropped: [...dropped].sort() };
}

/** The normalized `HOOK.json`: the kept fields in a fixed order, so the same hook always has the same text and hash. */
export function renderHook(hook) {
  const handlers = hook.handlers.map((h) => ({ event: h.event, ...(h.matcher === undefined ? {} : { matcher: h.matcher }), ...(h.if === undefined ? {} : { if: h.if }), type: "command", command: h.command, args: h.args, ...(h.timeout === undefined ? {} : { timeout: h.timeout }) }));
  return `${JSON.stringify({ name: hook.name, description: hook.description, handlers }, null, 2)}\n`;
}
