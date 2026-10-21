// `toolgate subagents import`: brings the subagents an agent already has (`.claude/agents`, ...) under
// toolgate, as neutral copies in the store with an entry in the lock whose source is the local folder.
// The originals are never changed.
import { SUBAGENTS_NATIVE } from "../adapters/subagents.js";
import { formatImport, importExitCode, importUnits } from "../commands/import.js";
import { SUBAGENT_KIND, subagentKind } from "./install.js";

/** @param {Parameters<typeof importUnits>[1]} options same options as `importCommands` */
export const importSubagents = (options) => importUnits({ kind: SUBAGENT_KIND, kindFor: subagentKind, capabilities: SUBAGENTS_NATIVE }, options);
export const formatImportSubagents = (report, { dryRun = false } = {}) => formatImport(report, { dryRun, noun: "subagent" });
export { importExitCode };
