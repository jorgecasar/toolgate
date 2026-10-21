// `toolgate hooks install|update|status|list|review|remove`: see `assets/reviewCli.js`. A hook runs a command, so nothing is
// applied without this user approving its exact content on this machine.
import { createReviewCli } from "../assets/reviewCli.js";
import { printable } from "../assets/common.js";
import { buildHookImport } from "./import.js";
import { HOOK_KIND, HOOKS_LOCAL_IGNORED, previewHook, scanHooks } from "./install.js";

export const runHooks = createReviewCli({
  kind: HOOK_KIND,
  noun: "hook",
  plural: "hooks",
  scan: scanHooks,
  preview: previewHook,
  row: (unit, state) => [printable(unit.name), unit.level, state, unit.handlers.map((h) => h.event).join(", ")],
  json: (unit, state) => ({ name: unit.name, level: unit.level, description: unit.description, state, handlers: unit.handlers }),
  ignored: HOOKS_LOCAL_IGNORED,
  buildImport: buildHookImport,
  usage: "toolgate hooks: usage: toolgate hooks install <github:owner/repo | git url> [name...] [--ref r] [--path p] [--exclude n] [--user | --local]\n",
});
