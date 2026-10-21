import fs from "node:fs";
import path from "node:path";
import { resolveCatalogPath } from "./path.js";
import { catalogServer, isCatalogFile } from "./render.js";

/** The file a server's catalog is written to; the name was checked as a safe file name by `readServerDefsByOrigin`. */
export const catalogFile = (dir, server) => path.join(dir, `${server}.md`);

/** The text of the catalog file of `server` if there is one we may read, else null. A link is never followed. */
export function readExisting(dir, server) {
  const file = catalogFile(dir, server);
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 * 1024) return null;
  return fs.readFileSync(file, "utf8");
}

/**
 * Writes one catalog file: inside the catalog folder only (no link on the way), never over a file toolgate did not write,
 * and atomically, so a failure keeps the previous file.
 */
export function writeCatalog({ cwd, config, server, text }) {
  const dir = resolveCatalogPath(config, cwd);
  fs.mkdirSync(dir, { recursive: true });
  resolveCatalogPath(config, cwd);
  const file = catalogFile(dir, server);
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (info) {
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${path.relative(cwd, file)} is a link or not a file, so it is not written`);
    const existing = fs.readFileSync(file, "utf8");
    if (!isCatalogFile(existing)) throw new Error(`${path.relative(cwd, file)} is not a catalog written by toolgate; refusing to overwrite it`);
    // On a file system that ignores case, `Foo.md` and `foo.md` are one file: the catalog of another server is not replaced.
    if (catalogServer(existing) !== server) throw new Error(`${path.relative(cwd, file)} is the catalog of the server ${JSON.stringify(catalogServer(existing))}, not ${JSON.stringify(server)}; refusing to overwrite it`);
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
  fs.renameSync(temp, file);
  return file;
}
