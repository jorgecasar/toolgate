import { flatten, printable, truncate } from "./assets/common.js";
import { SAFE_TOOL } from "./catalog/sanitize.js";
import { escalateServers, escalateSubagents } from "./config.js";
import { enableTools, markInstructionsShown } from "./session.js";

// `toolgate need`: the in-session answer to "I need X". It is the route result plus what each
// server's status is right now. Statuses:
//   available        the server is always on (baseline or cheap tier): nothing to do.
//   restart-required written to the state as an escalation; a relaunch applies it.
//   revealed         the server is active and dynamic in this toolgate session and the catalog matched tools of it: they are
//                    added to the session file and the proxy offers them now, with no restart. The first time, the instructions
//                    the proxy kept back (`instructions`) are given too.
//   dormant          active and dynamic in this session, but nothing matched a tool: nothing changes; `available` lists what its
//                    card knows and `hint` how to reveal one.
// Servers the agent has not configured are listed in `missing` and never written to the state.

const EXCERPT_LENGTH = 200;
// The most of a server's deferred instructions that is handed to the agent (what Claude Code itself keeps of a server's instructions).
export const INSTRUCTIONS_SHOWN = 4096;
const MAX_AVAILABLE = 50;
const safeTools = (tools) => [...new Set((tools ?? []).filter((tool) => typeof tool === "string" && SAFE_TOOL.test(tool)))];

// What `need` shows of a match is the description its card carries, never qmd's snippet, which can start with a position
// marker (`4: @@ -3,4 @@`). A match without a card (or without a description) has no excerpt.
function excerpt(description) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

// How a relaunch happens depends on whether the adapter can resume the conversation.
function restartHint(agent, adapter) {
  if (adapter?.supportsResume === true) {
    return "end the session (e.g. /exit); toolgate relaunches the agent with the conversation resumed";
  }
  // Never "toolgate undefined": without a known agent the text names a placeholder.
  return typeof agent === "string" && agent !== "" ? `end the session and run \`toolgate ${printable(agent)}\` to relaunch it` : "end the session and relaunch it with `toolgate <agent>`";
}

// Subagents are only added to a state that has some to add, so an old state keeps its shape.
const withAgents = (state, names) => (names.length ? escalateSubagents(state, names) : state);
/**
 * @param {Object} routed Result of `route()`.
 * @param {{ state: Object, agent?: string, adapter?: Object, session?: { state: Object, cardTools(server: string): string[], instructionsOf(server: string): string|null, update(change: Function): { state?: Object, refused?: string } } | null }} context
 *   `session` is the toolgate session this runs in, when there is one (see `session.js`): the servers it lists are active and dynamic.
 * @returns {{ result: Object, state: Object|null }} `state` is the one to persist, or null when
 *   nothing new was escalated.
 */
export function resolveNeed(routed, { state, agent, adapter, session = null, sessionWarning = null }) {
  const missing = new Set(routed.missing.map((entry) => entry.server));
  const fromSession = new Map((routed.sessionTools ?? []).filter(({ server }) => session !== null && Object.hasOwn(session.state.servers, server)).map(({ server, tools }) => [server, tools]));
  // The servers of the session whose card matched the task are needed too, chosen by the router or not (a baseline server is not "chosen").
  const needed = [...new Set([...routed.servers.filter((server) => !missing.has(server)), ...fromSession.keys()])];
  const fromCatalog = new Map([...(routed.catalog ?? []).map(({ server, tools }) => [server, tools]), ...fromSession]);
  // A server of this session is active and dynamic: it is revealed (tools matched) or dormant (none), never escalated. Any other is a
  // restart, as it always was; with a session, the tools the catalog matched are recorded so that the relaunch already offers them.
  const inSession = (server) => session !== null && Object.hasOwn(session.state.servers, server);
  const toReveal = new Map();
  const dormant = [];
  let escalated = [];
  const warnings = [...routed.warnings, ...(sessionWarning ? [sessionWarning] : [])];
  for (const server of needed) {
    if (!inSession(server)) escalated.push(server);
    else if (safeTools(fromCatalog.get(server)).length) toReveal.set(server, safeTools(fromCatalog.get(server)));
    else dormant.push(server);
  }
  // A matched tool the session already offers (in the baseline, or revealed before) is nothing to do: if every one is, the server is just
  // available.
  const offeredAlready = new Set();
  for (const [server, tools] of toReveal) {
    const entry = session.state.servers[server];
    if (tools.every((tool) => entry.baseline.includes(tool) || entry.enabled.includes(tool))) {
      toReveal.delete(server);
      offeredAlready.add(server);
    }
  }
  const instructions = new Map();
  // The servers of the session this call gives tools to, or finds already offered: both get the instructions the proxy kept back, once.
  // An already offered server is touched only if it may have instructions to give: not shown yet, and a file to read (the write decides
  // again, under the lock). Otherwise `need` for a tool that is already there writes nothing, and takes no lock.
  const mayGive = (server) => !session.state.servers[server].instructionsShown && session.instructionsOf(server) !== null;
  const touched = new Map([...toReveal, ...[...offeredAlready].filter(mayGive).map((server) => [server, []])]);
  if (touched.size) {
    // Decided inside the write, under the session's lock, from what the file holds at that moment: two `need` at once cannot both find the
    // instructions unshown, and a server a relaunch has just taken out of the session is not revealed.
    const written = session.update((current) => {
      instructions.clear();
      let next = current;
      for (const [server, tools] of touched) {
        const entry = Object.hasOwn(current.servers, server) ? current.servers[server] : undefined;
        if (!entry) continue;
        // Offered already (baseline, or revealed before): not written again.
        next = enableTools(next, server, tools.filter((tool) => !entry.baseline.includes(tool) && !entry.enabled.includes(tool)));
        if (entry.instructionsShown) continue;
        const text = session.instructionsOf(server);
        if (text) {
          instructions.set(server, text);
          next = markInstructionsShown(next, server);
        }
      }
      return next;
    });
    const gone = written.refused ? [...toReveal.keys()] : [...touched.keys()].filter((server) => !Object.hasOwn(written.state.servers, server));
    if (written.refused) {
      // Nothing was revealed, so these are the restarts they would have been without a session, and the reason is said.
      warnings.push(written.refused.replace(/^toolgate: /, ""));
      instructions.clear();
    }
    for (const server of gone) {
      toReveal.delete(server);
      offeredAlready.delete(server);
      instructions.delete(server);
      escalated.push(server);
    }
    escalated = needed.filter((server) => escalated.includes(server));
  }
  const added = escalated.filter((server) => !state.extras.includes(server));
  const recorded = session === null ? [] : escalated.filter((server) => safeTools(fromCatalog.get(server)).length);
  // A subagent is registered at launch: asking for it is recorded like a server that needs a relaunch.
  const registers = ["launchFlag", "projectDir"].includes(adapter?.capability?.subagents?.kind);
  const agents = registers ? (routed.subagents ?? []).map((subagent) => subagent.name) : [];
  const addedAgents = agents.filter((name) => !(state.subagentExtras ?? []).includes(name));
  // Where a server came from, when it is not a skill or a binding: the tools of the catalog that matched the task.
  const withSource = (server, status) => ({ server, status, ...(fromCatalog.has(server) ? { source: "catalog", tools: fromCatalog.get(server) } : {}) });
  const entryOf = (server) => {
    if (toReveal.has(server)) {
      return { server, status: "revealed", source: "catalog", tools: toReveal.get(server), ...(instructions.has(server) ? { instructions: instructions.get(server).slice(0, INSTRUCTIONS_SHOWN) } : {}) };
    }
    if (offeredAlready.has(server)) {
      return { server, status: "available", source: "catalog", tools: safeTools(fromCatalog.get(server)), ...(instructions.has(server) ? { instructions: instructions.get(server).slice(0, INSTRUCTIONS_SHOWN) } : {}) };
    }
    if (dormant.includes(server)) {
      return { server, status: "dormant", available: safeTools(session.cardTools(server)).slice(0, MAX_AVAILABLE), hint: `toolgate tools enable ${server} <tool>` };
    }
    return withSource(server, "restart-required");
  };
  // A server that is always on and whose card matched is told once, with the tools: not also as plainly available.
  const servers = [...(routed.alwaysOn ?? []).filter((server) => !needed.includes(server)).map((server) => withSource(server, "available")), ...needed.map(entryOf)];

  // What a restart will need: the servers and subagents to add, and the tools the catalog matched for servers of a session that has not got them.
  let stateOut = added.length || addedAgents.length ? withAgents(added.length ? escalateServers(state, added) : state, addedAgents) : null;
  for (const server of recorded) {
    const base = stateOut ?? state;
    // A state file is the user's to edit: what is not a list of tool names for the server counts as none.
    const known = Object.hasOwn(base.toolExtras ?? {}, server) && Array.isArray(base.toolExtras[server]) ? base.toolExtras[server] : [];
    const tools = [...new Set([...known, ...safeTools(fromCatalog.get(server))])];
    if (tools.length !== known.length) stateOut = { ...base, toolExtras: { ...base.toolExtras, [server]: tools }, pendingRestart: true };
  }

  return {
    result: {
      skills: routed.skills.map(({ name, path, score, description }) => ({ name, path, score, excerpt: excerpt(description) })),
      commands: (routed.commands ?? []).map(({ name, path, argumentHint, arguments: given, score, description }) => ({
        name,
        path,
        ...(argumentHint ? { argumentHint } : {}),
        ...(given ? { arguments: given } : {}),
        score,
        excerpt: excerpt(description),
      })),
      subagents: (routed.subagents ?? []).map(({ name, path, tools, toolsDefault, score, description }) => ({ name, path, tools, toolsDefault, registration: registers ? "next-launch" : "unsupported", score, excerpt: excerpt(description) })),
      servers,
      missing: routed.missing,
      warnings,
      binding: routed.binding,
      restart: escalated.length || agents.length ? restartHint(agent, adapter) : null,
    },
    state: stateOut,
  };
}

/**
 * The deferred instructions of a server as lines for the agent: a header, then every line of the server's text behind a bar, so that it
 * reads as quoted data and not as something to follow. The text is cut to what is handed over (a caller may pass it whole).
 */
export function instructionLines(server, text) {
  return [`instructions of ${server} (shown once):`, ...text.slice(0, INSTRUCTIONS_SHOWN).split(/\r?\n/).map((line) => `  | ${line}`)];
}
// The short form the agent reads: one line per fact, nothing it has to parse.
export function formatNeed(result) {
  const lines = [];
  for (const skill of result.skills) {
    lines.push(`skill ${skill.name}: read ${skill.path || "(no path)"}${skill.excerpt ? ` - ${skill.excerpt}` : ""}`);
  }
  // Nothing is registered in the agent: the command is a file to read, with the user's own words as its arguments.
  for (const command of result.commands) {
    // The hint is text from the command's file: shown quoted and short, as data.
    const hint = command.argumentHint ? ` (argument hint from the file: ${JSON.stringify(truncate(flatten(command.argumentHint), 120))})` : "";
    // What the user typed after the command name: quoted, as data for the command to use.
    const given = command.arguments ? ` (the user's arguments: ${JSON.stringify(truncate(flatten(command.arguments), 500))})` : "";
    lines.push(`command ${command.name}: read ${command.path || "(no path)"} and follow it${hint}${given}${command.excerpt ? ` - ${command.excerpt}` : ""}`);
  }
  // A subagent is not read: it exists in the agent only once registered, which happens at launch.
  for (const subagent of result.subagents) {
    const tools = subagent.tools.map((tool) => printable(truncate(flatten(tool), 100))).join(", ");
    const when = subagent.registration === "next-launch" ? "registered at the next launch, not in this session" : "this agent cannot register subagents, so it is not available";
    lines.push(`subagent ${subagent.name}: ${when} (tools it would get: ${tools}${subagent.toolsDefault ? ", the read-only default" : ""})${subagent.excerpt ? ` - ${subagent.excerpt}` : ""}`);
  }
  for (const entry of result.servers) {
    const { server, status, source, tools } = entry;
    // The names of the tools come from the server: shown short and as data.
    const names = (list) => list.map((tool) => printable(truncate(flatten(tool), 100))).join(", ");
    if (status === "revealed") {
      lines.push(`server ${server}: revealed (${names(tools)})`);
      if (entry.instructions !== undefined) lines.push(...instructionLines(server, entry.instructions));
      continue;
    }
    if (status === "dormant") {
      lines.push(`server ${server}: dormant, nothing matched a tool${entry.available.length ? `; it can provide: ${names(entry.available)}` : ""} (run ${entry.hint})`);
      continue;
    }
    const origin = source === "catalog" ? ` (from the catalog${tools?.length ? `: ${names(tools)}` : ""})` : "";
    lines.push(`server ${server}: ${status}${origin}`);
    if (entry.instructions !== undefined) lines.push(...instructionLines(server, entry.instructions));
  }
  if (result.restart) lines.push(`restart required: ${result.restart}`);
  for (const { server, install, checkedIn } of result.missing) {
    lines.push(`missing ${server}: not configured (checked ${checkedIn}); ask the user before installing${install ? `: ${install}` : ""}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (!lines.length) lines.push("nothing needed: proceed normally");
  return `${lines.map(printable).join("\n")}\n`;
}
