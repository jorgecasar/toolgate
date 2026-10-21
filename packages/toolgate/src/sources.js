// After an install, the store the copies went to has to be one of the sources of its kind, or nothing indexes them.
// Telling the user to run `toolgate config add` was the old answer; this does the same through the config module, in
// the layer of the install: the project's for a project install, the local one for `--local`, the user's for `--user`
// (a source resolves against the base of the layer that declares it, which is where `storeFor` puts that level's store).
import path from "node:path";
import { printable } from "./assets/common.js";
import { configLayerPaths } from "./config.js";
import { editConfigFile, restoreHint, trackedAndMissing } from "./configFile.js";

/**
 * @param {{ kind: "skills" | "commands" | "subagents", level: "project" | "local" | "user", storeDir: string, cwd: string, env: object }} options
 * @returns {{ file: string, layer: string, added: boolean }}
 * @throws with the reason when the config cannot be edited (unparsable, a tracked project config that is missing, no permission)
 */
export function addStoreSource({ kind, level, storeDir, cwd, env }) {
  const layer = configLayerPaths({ cwd, env }).find((candidate) => candidate.name === level);
  if (!layer) throw new Error(`there is no ${level} config layer`);
  if (level === "project" && trackedAndMissing(layer.path)) throw new Error(restoreHint(layer.path, cwd));
  const { changed } = editConfigFile(layer.path, { action: "add", key: `${kind}.sources`, value: { dir: storeDir }, layer: level });
  return { file: layer.path, layer: level, added: changed };
}

/**
 * Makes sure the store is one of the sources `options[sourcesKey]` holds, adding it to the config of the level when it is
 * not. Returns whether it is one now; when it is not it has already said why and what to run by hand.
 */
export function ensureIndexedSource({ kind, noun, level, storeDir, root, options, sourcesKey, cwd, env, stdout, write = true }) {
  const store = path.resolve(root, storeDir);
  if (options[sourcesKey].some((source) => path.resolve(source.dir) === store)) return true;
  // Nothing installed or found there (the only item was invalid, say): there is no store worth a line in the config.
  let reason = "nothing was installed";
  if (write) {
    try {
      const result = addStoreSource({ kind, level, storeDir, cwd, env });
      if (result.added) {
        options[sourcesKey] = [...options[sourcesKey], { dir: store }]; // so the same run indexes it
        const shown = path.relative(cwd, result.file);
        stdout.write(`toolgate: added ${kind}.sources {"dir":"${storeDir}"} to the ${result.layer} config (${shown.startsWith("..") ? result.file : shown}), so these ${noun} are indexed\n`);
        return true;
      }
      reason = `the ${result.layer} config already lists it, but it does not resolve to this store`;
    } catch (err) {
      reason = printable(err.message.split("\n")[0]);
    }
  }
  stdout.write(`toolgate: ${storeDir} is not one of the configured ${kind} sources, so these ${noun} are not indexed (${reason}); add it with: toolgate config add ${kind}.sources '{"dir":"${storeDir}"}'\n`);
  return false;
}
