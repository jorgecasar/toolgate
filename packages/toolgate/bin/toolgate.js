#!/usr/bin/env node
import { failureText, run } from "../src/cli.js";
import { configLayerPaths, loadConfig } from "../src/config.js";
import { useBundledQmd } from "../src/qmdPath.js";

// A `qmd.bin` the user chose (even a plain "qmd") is the program that runs, so the copy that comes with toolgate is not offered next to it.
// Otherwise a `qmd` on the PATH wins, and the bundled copy is used when there is none.
let chosen = false;
try {
  chosen = loadConfig(configLayerPaths({ cwd: process.cwd(), env: process.env })).qmd?.bin !== undefined;
} catch {
  // a config that cannot be read is reported by the command itself
}
if (!chosen) useBundledQmd();
let code;
try {
  code = await run(process.argv.slice(2));
} catch (err) {
  // A launch that could not even start the agent (not installed, not executable): the reason, not a stack; a bug keeps its stack.
  process.stderr.write(failureText(err));
  code = 1;
}
process.exit(code);
