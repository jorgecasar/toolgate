// toolgate runs `qmd` by name everywhere. When the user has not installed it but the copy that comes
// with toolgate (the optional `@tobilu/qmd` dependency) is there, its `bin` folder goes at the END of
// the PATH: a `qmd` the user installed always wins, and nothing that runs `qmd` needs to know the difference.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** True when an executable `qmd` is in one of the PATH folders. */
export function qmdOnPath(env = process.env, accessFn = fs.accessSync) {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessFn(path.join(dir, "qmd"), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/**
 * Folder holding the bundled `qmd` launcher, or null when the optional dependency is not installed.
 * The package only exports its `import` entry, so it is found through that entry, not `package.json`.
 */
export function bundledQmdDir({ resolveFn = (id) => import.meta.resolve(id), existsFn = fs.existsSync } = {}) {
  try {
    const entry = fileURLToPath(resolveFn("@tobilu/qmd"));
    const dir = path.join(path.resolve(path.dirname(entry), ".."), "bin");
    return existsFn(path.join(dir, "qmd")) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Makes the bundled `qmd` reachable when there is none on the PATH.
 * @param {Record<string, string | undefined>} [env] Changed in place.
 * @returns {"path" | "bundled" | "none"} where `qmd` will come from
 */
export function useBundledQmd(env = process.env, options = {}) {
  if (qmdOnPath(env, options.accessFn)) return "path";
  const dir = bundledQmdDir(options);
  if (!dir) return "none";
  env.PATH = env.PATH ? `${env.PATH}${path.delimiter}${dir}` : dir;
  return "bundled";
}
