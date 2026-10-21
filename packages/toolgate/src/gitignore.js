// Adds patterns to a project's .gitignore without touching what is there.
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} cwd
 * @param {string[]} patterns
 * @param {{ header?: string, dryRun?: boolean, refuseLinks?: boolean }} [options] A comment line written above the new patterns; with `dryRun` nothing is written and the result says what would be; with `refuseLinks` a `.gitignore` that is a symlink is an error, never read or written through
 * @returns {{ created: boolean, added: number }}
 */
export function appendIgnored(cwd, patterns, { header, dryRun = false, refuseLinks = false } = {}) {
  const file = path.join(cwd, ".gitignore");
  // A cloned repository can commit `.gitignore` as a symlink to a file outside the project. The callers that write it without
  // being asked to (a default install) refuse a link; the others keep following it, as they always did.
  if (refuseLinks && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${file} is a symlink, and toolgate does not write through symlinks`);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = patterns.filter((pattern) => !present.has(pattern));
  if (missing.length === 0) return { created: false, added: 0 };
  if (dryRun) return { created: current === "", added: missing.length };

  // A header that is already there (with entries, or alone) is not written twice: the new entries go under it.
  const lines = current.split("\n");
  const at = header ? lines.findIndex((line) => line.trim() === header) : -1;
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && lines[end].trim() !== "") end++;
    lines.splice(end, 0, ...missing);
    fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
    return { created: false, added: missing.length };
  }

  const separator = current === "" || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(file, `${current}${separator}${header ? `${header}\n` : ""}${missing.join("\n")}\n`);
  return { created: current === "", added: missing.length };
}
