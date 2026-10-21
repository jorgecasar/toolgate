import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CATALOG_PATH = ".toolgate/catalog/servers";

/**
 * The folder the catalog is written to: `router.catalogPath`, or the default. It has to stay inside the project, and no
 * part of it that exists may be a link, so a build can never write elsewhere.
 */
export function resolveCatalogPath(config, cwd) {
  const configured = config?.router?.catalogPath;
  const wanted = typeof configured === "string" && configured !== "" ? configured : DEFAULT_CATALOG_PATH;
  const root = path.resolve(cwd);
  const dir = path.resolve(root, wanted);
  const relative = path.relative(root, dir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`catalogPath ${JSON.stringify(wanted)} is not a folder inside the project`);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${path.relative(root, current)} is a link or not a folder, so the catalog is not written there`);
  }
  return dir;
}
