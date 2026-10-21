// Where each agent keeps the commands of its own: `toolgate commands import` brings them in, and `toolgate
// doctor` says when there are some that toolgate does not manage. The folders come from the adapters'
// `commands` capability. Nothing here reads or runs a command.
import fs from "node:fs";
import path from "node:path";
import { COMMANDS_CAPABILITY } from "../adapters/commands.js";

/** The folders of one level, with the agent and dialect each belongs to. */
const foldersOf = (user, capabilities) =>
  Object.entries(capabilities)
    .filter(([, commands]) => commands.kind === "nativeDir")
    .flatMap(([agent, commands]) => (user ? commands.userDirs : commands.projectDirs).map((rel) => ({ agent, rel, dialect: commands.dialect })));

/** Whether `dir`, with every link in its path followed, is inside `base` (also followed). */
export function insideBase(dir, base) {
  try {
    const relative = path.relative(fs.realpathSync(base), fs.realpathSync(dir));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

/**
 * The native command folders that exist. A folder that is a symlink is reported and not used: it can
 * lead anywhere, and a command folder is read only where it really is.
 * @param {{ base: string, user?: boolean, capabilities?: object }} options `base` is the project, or the home directory when `user`;
 *   `capabilities` is the table of folders per agent (commands by default, `SUBAGENTS_NATIVE` for subagents)
 * @returns {{ folders: Array<{ agent: string, dir: string, label: string, dialect: string }>, notes: string[] }}
 */
export function nativeFolders({ base, user = false, capabilities = COMMANDS_CAPABILITY }) {
  const folders = [];
  const notes = [];
  const label = (rel) => (user ? `~/${rel}` : rel);
  for (const folder of foldersOf(user, capabilities)) {
    const dir = path.join(base, folder.rel);
    let info;
    try {
      info = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) notes.push(`${label(folder.rel)} is a symlink, and symlinks are not followed; it was left out`);
    else if (info.isDirectory() && !insideBase(dir, base)) notes.push(`${label(folder.rel)} resolves outside ${user ? "your home folder" : "the project"}; it was left out`);
    else if (info.isDirectory()) folders.push({ agent: folder.agent, dir, label: label(folder.rel), dialect: folder.dialect });
  }
  return { folders, notes };
}
