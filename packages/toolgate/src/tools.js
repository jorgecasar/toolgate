// `toolgate tools enable|disable|status|reset` (#19 T8): change, from the agent's own shell, which tools of the servers that
// toolgate-proxy wraps are offered in this session. It works on the session file `TOOLGATE_SESSION_STATE` names, and on nothing else:
// a server's baseline is the list the launcher stored in its entry (the list its proxy was started with), so any folder gives the same
// answer and a config changed or broken since the launch changes nothing. The offered tools are that baseline plus what was revealed
// (`enabled`), or only the sentinel when both are empty; `disable` and `reset` never take a baseline tool away.
import { jsonSafe, printable } from "./assets/common.js";
import { instructionLines } from "./need.js";
import { SAFE_TOOL } from "./catalog/sanitize.js";
import { readCatalog } from "./catalog/read.js";
import { MAX_ENABLED, disableTools, enableTools, inspectSession, isSessionFile, markInstructionsShown, readInstructions, resetTools, updateSession, writeFailure } from "./session.js";
import { configLayerPaths } from "./config.js";

const ACTIONS = new Set(["enable", "disable", "status", "reset"]);
const NOTE = "note: a tool already used stays in the conversation; this only stops it from being offered\n";

export function runTools(args, { json = false, env = process.env, loadConfigFn, stdout, stderr, readCatalogFn = readCatalog }) {
  const [action, server, ...rest] = args;
  if (!ACTIONS.has(action)) {
    stderr.write("toolgate tools: use enable <server> <tool...>, disable <server> [tool...], status [server] [--json] or reset [server]\n");
    return 1;
  }
  if ((action === "status" || action === "reset") && args.length > 2) {
    stderr.write(`toolgate tools ${action}: it takes at most one server name\n`);
    return 1;
  }
  const file = env.TOOLGATE_SESSION_STATE;
  if (!file) {
    stderr.write("toolgate: no toolgate session here (TOOLGATE_SESSION_STATE is not set); launch the agent with toolgate\n");
    return 1;
  }
  if (!isSessionFile(file, { env })) {
    stderr.write("toolgate: TOOLGATE_SESSION_STATE is not a toolgate session file\n");
    return 1;
  }
  const current = inspectSession(file, { env });
  if (current.refused) {
    stderr.write(`${current.refused}\n`);
    return 1;
  }
  if (server !== undefined && !Object.hasOwn(current.state.servers, server)) {
    stderr.write(`toolgate: ${printable(server)} is not a dynamic server of this session\n`);
    return 1;
  }
  if ((action === "enable" || action === "disable") && server === undefined) {
    stderr.write(`toolgate tools ${action}: a server name is required\n`);
    return 1;
  }
  if (action === "enable" && rest.length === 0) {
    stderr.write("toolgate tools enable: at least one tool name is required\n");
    return 1;
  }
  for (const tool of rest) {
    if (!SAFE_TOOL.test(tool)) {
      stderr.write(`toolgate: "${printable(tool)}" is not a valid tool name\n`);
      return 1;
    }
  }
  const baseline = (state, name) => state.servers[name].baseline;
  const offeredBy = (state, name) => [...new Set([...baseline(state, name), ...state.servers[name].enabled])];

  if (action === "status") {
    const names = server === undefined ? Object.keys(current.state.servers) : [server];
    if (json) {
      stdout.write(`${jsonSafe(JSON.stringify({ servers: Object.fromEntries(names.map((name) => [name, { enabled: current.state.servers[name].enabled, offered: offeredBy(current.state, name) }])) }))}\n`);
      return 0;
    }
    for (const name of names) {
      const tools = offeredBy(current.state, name);
      stdout.write(`${name}: ${tools.length ? tools.map(printable).join(", ") : "only the sentinel"}\n`);
    }
    return 0;
  }

  const names = action === "reset" && server === undefined ? Object.keys(current.state.servers) : [server];
  if (action === "enable" && enableTools(current.state, server, rest).servers[server].enabled.length > MAX_ENABLED) {
    stderr.write(`${writeFailure(file, `more than ${MAX_ENABLED} tools for ${server}`)}\n`);
    return 1;
  }
  const before = current.state;
  // The instructions the proxy kept back come with the first tools of the server, by whatever path; decided under the lock, from the file as
  // it is then, so that two commands at once show them once.
  let instructions;
  const enableAndShow = (state) => {
    let next = enableTools(state, server, rest);
    if (Object.hasOwn(state.servers, server) && !state.servers[server].instructionsShown) {
      const text = readInstructions(file, server, { env });
      if (text) {
        instructions = text;
        next = markInstructionsShown(next, server);
      }
    }
    return next;
  };
  const change = {
    enable: enableAndShow,
    disable: (state) => disableTools(state, server, rest),
    reset: (state) => names.reduce((next, name) => resetTools(next, name), state),
  }[action];
  const written = updateSession(file, change, { env });
  if (written.refused) {
    stderr.write(`${written.refused}\n`);
    return 1;
  }
  // A relaunch may have taken the server out of the session between the check above and the write: nothing was changed for it.
  if (server !== undefined && !Object.hasOwn(written.state.servers, server)) {
    stderr.write(`toolgate: ${printable(server)} is not a dynamic server of this session\n`);
    return 1;
  }
  if (action === "enable") {
    const card = readCardTools(current.state.projectDir, env, loadConfigFn, server, readCatalogFn);
    for (const tool of new Set(rest)) {
      if (card && !card.has(tool)) stderr.write(`warning: ${printable(tool)} is not in the catalog card of ${printable(server)}\n`);
    }
    stdout.write(`enabled ${server}: ${[...new Set(rest)].map(printable).join(", ")}\n`);
    if (instructions !== undefined) stdout.write(`${instructionLines(server, instructions).map(printable).join("\n")}\n`);
    return 0;
  }
  if (action === "disable") {
    const base = baseline(before, server);
    for (const tool of new Set(rest.filter((name) => base.includes(name)))) stderr.write(`warning: ${printable(tool)} is in toolBaselines of ${printable(server)} and stays offered\n`);
    // Only what is no longer offered: a revealed tool that is also in the baseline stays, so it is not listed as disabled.
    const removed = before.servers[server].enabled.filter((tool) => !written.state.servers[server].enabled.includes(tool) && !base.includes(tool));
    stdout.write(`disabled ${server}: ${removed.length ? removed.map(printable).join(", ") : "none"}\n${NOTE}`);
    return 0;
  }
  for (const name of names) stdout.write(`reset ${name}\n`);
  stdout.write(NOTE);
  return 0;
}

// The tool names of the server's catalog card, looked up in the project the session was launched for (the folder the session file
// records); null when there is none, or the catalog cannot be read. The config is read only for where the catalog is.
function readCardTools(projectDir, env, loadConfigFn, server, readCatalogFn) {
  if (!projectDir) return null;
  try {
    let config = {};
    try {
      config = loadConfigFn(configLayerPaths({ cwd: projectDir, env }));
    } catch {
      // a config that cannot be read means the default catalog folder
    }
    const card = readCatalogFn(config, projectDir).servers.get(server);
    return card ? new Set(card.tools.map((tool) => tool.name)) : null;
  } catch {
    return null;
  }
}
