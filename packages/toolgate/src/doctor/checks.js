// The checks of `toolgate doctor`. Each takes the shared context and returns findings
// `{ id, level: "ok" | "warn" | "error", message, hint? }`. A check never throws: what it cannot
// determine becomes a finding, and one that depends on something missing says nothing more.
import { ignoredWhat, invalidFix, invalidWhy } from "../configFile.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SAFE_NAME, hasDescription, jsonSafe, printable } from "../assets/common.js";
import { daemonUrls, managedPort, qmdBinOf } from "../daemon.js";
import { checkFreshness, skillsLocation, staleMessage } from "../daemonFreshness.js";
import { detect } from "../init.js";
import { detectAgents, formatAgentLine } from "../agentReport.js";
import { installedServers, readServerDefs } from "../adapters/claude-code.js";
import { collectionIsCurrent } from "../skills/collection.js";
import { staleCards } from "../skills/corpus.js";
import { LOCK_FILE, SKILLS_DIR, hashDir, hashOrNull, readLock } from "../skills/install.js";
import { COMMAND_KIND, COMMANDS_DIR, commandKind } from "../commands/install.js";
import { bridgeState } from "../commands/bridge.js";
import { nativeFolders } from "../commands/native.js";
import { SUBAGENTS_NATIVE } from "../adapters/subagents.js";
import { SUBAGENT_KIND, SUBAGENTS_DIR, subagentKind } from "../subagents/install.js";
import { scanCommands, scanSkills, scanSubagents } from "../skills/scan.js";
import { assetStatus } from "../skills/status.js";
import { userConfigDir } from "../config.js";
import { settings as skillsSettings } from "../skills/cli.js";
import { skillsButNoIndex } from "../skills/unindexed.js";
import { step0NotGenerated } from "../rulesyncSetup.js";
import { deniedTerms } from "./denylist.js";
import { loadApprovals } from "../assets/approval.js";
import { catalogForRoute } from "../catalog/read.js";
import { effectiveSet } from "../hooks/effective.js";
import { HOOK_KIND } from "../hooks/install.js";
import { PERMISSION_KIND } from "../permissions/install.js";
import { opencodeEnv } from "../permissions/opencode.js";
import { claudeSettingsFile, readSettings } from "../assets/nativeSettings.js";
import { claudeSettingsFiles, disabledServersIn, envOverridesIn, pinnedServersIn, step0RulesIn, symlinkedSettings } from "../claudeSettings.js";
import { guardsOffInFiles } from "../guardsOff.js";
import { isCommandServer, isProxied, namesItsServer } from "../proxied.js";
import { MAX_MCP_BYTES, oldProxyNames, renamedText } from "../proxyEnv.js";

const finding = (id, level, message, hint) => ({ id, level, message, ...(hint ? { hint } : {}) });
const ok = (id, message) => finding(id, "ok", message);
const warn = (id, message, hint) => finding(id, "warn", message, hint);
// One warning per item that says nothing about what it is for: route and need show it without a description. The file
// is shown relative to the project when it lives inside it.
function descriptionFindings(kind, items, cwd, hintFor) {
  return items
    .filter((item) => !hasDescription(item))
    .map((item) => {
      const relative = path.relative(cwd, item.path);
      const file = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : item.path;
      return warn(`${kind}.description`, `${printable(item.name)} has no description (${printable(file)})`, hintFor(item));
    });
}
const FRONTMATTER_HINT = 'add "description:" to its frontmatter';
// The MCP server a tool names: `mcp__<server>__<tool>`, or `mcp__<server>` for all of its tools. An agent's own tools
// (Read, Bash, ...) name none, and are not looked up.
// The servers of plugins (`plugin_...`) and the claude.ai connectors (`claude_ai_...`) come with the agent, not with a config file: not looked up.
const serverOfTool = (tool) => {
  const server = /^mcp__([\w.-]+?)(?:__.*)?$/.exec(tool)?.[1] ?? null;
  return server !== null && !/^(?:plugin_|claude_ai_)/.test(server) ? server : null;
};
// One warning per tool a command or subagent allows from an MCP server the agent has not configured.
function toolServerFindings(kind, items, toolsOf, configured, cwd) {
  const findings = [];
  for (const item of items) {
    const relative = path.relative(cwd, item.path);
    const file = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : item.path;
    for (const tool of toolsOf(item)) {
      const server = serverOfTool(tool);
      if (server !== null && !configured.includes(server)) {
        findings.push(warn(`${kind}.toolServers`, `${printable(item.name)} allows ${printable(tool)}, but the MCP server ${printable(server)} is not configured (${printable(file)})`, `configure ${printable(server)} in the agent, or remove the tool`));
      }
    }
  }
  return findings;
}
// One error per file that could not be read as the asset: the scan skipped it, so it is not indexed.
function invalidFindings(kind, skipped = [], cwd) {
  return skipped.map(({ file, reason }) => {
    const relative = path.relative(cwd, file);
    const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
    return error(`${kind}.invalid`, `${printable(shown)}: ${printable(reason)}; it is not indexed`, "fix its frontmatter");
  });
}
const error = (id, message, hint) => finding(id, "error", message, hint);

const RULESYNC_RULE = path.join(".rulesync", "rules", "toolgate-router.md");
const RULE_FILES = [path.join(".claude", "rules", "toolgate-router.md"), RULESYNC_RULE];

export function readJsonFile(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) ?? {} };
  } catch (err) {
    return err.code === "ENOENT" ? {} : { invalid: err.message };
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export async function checkAgents(ctx) {
  ctx.agents = await detectAgents({ execFn: ctx.execFn, registry: ctx.registry });
  return ctx.agents.length
    ? ctx.agents.map((agent) => (agent.tier === 0 ? warn : ok)("agents", formatAgentLine(agent)))
    : [error("agents", "no supported agent CLI was found on the PATH")];
}

export function checkQmd(ctx) {
  ctx.qmd = detect({ cwd: ctx.cwd, execFn: ctx.execFn, qmdBin: qmdBinOf(ctx.config) }).qmd;
  return ctx.qmd
    ? [ok("qmd.installed", "qmd is installed")]
    : [error("qmd.installed", "qmd was not found", "npm i -g @tobilu/qmd (needs Node 22 or newer)")];
}

export async function checkDaemon(ctx) {
  const port = managedPort(ctx.config, ctx.env);
  if (port === null) return [ok("daemon.reachable", "the qmd endpoint is remote or disabled; toolgate does not manage it")];

  const status = await ctx.daemon.status({ port });
  if (!status.running) {
    // Hung: something holds the port and does not answer, so starting another would not help.
    if (status.state === "hung") return [error("daemon.reachable", `the qmd daemon on port ${port} is not answering`, "toolgate daemon restart")];
    return [error("daemon.reachable", `the qmd daemon is not running on port ${port}`, "toolgate daemon start; toolgate daemon status shows its state")];
  }
  const findings = [ok("daemon.reachable", `the qmd daemon is running on port ${port}`)];

  const { collection, corpusDir } = skillsLocation(ctx.config, ctx.cwd);
  if (!fs.existsSync(corpusDir)) {
    findings.push(warn("daemon.collection", "there is no skills index yet", "toolgate skills index"));
    return findings;
  }
  if (ctx.qmd === false) {
    // Without the qmd CLI the collection cannot be listed; qmd.installed already reports the cause.
    findings.push(warn("daemon.collection", `the qmd collection "${collection}" was not checked because qmd is not installed`));
  } else if (!collectionIsCurrent({ qmdBin: qmdBinOf(ctx.config), collection, corpusDir, execFn: ctx.execFn })) {
    findings.push(error("daemon.collection", `the qmd collection "${collection}" does not exist or does not index the skills corpus`, "toolgate skills index --force"));
    return findings;
  } else {
    findings.push(ok("daemon.collection", `the qmd collection "${collection}" indexes the skills corpus`));
  }

  const fresh = await checkFreshness({ url: daemonUrls(port).mcp, collection, corpusDir, fetchFn: ctx.fetchFn });
  if (fresh.state === "stale") {
    findings.push(error("daemon.fresh", staleMessage({ collection, ...fresh }), "toolgate daemon restart"));
  } else if (fresh.state === "unknown") {
    findings.push(warn("daemon.fresh", "could not compare the daemon's documents with the corpus"));
  } else {
    findings.push(ok("daemon.fresh", `the daemon serves ${plural(fresh.actual, "document")} (corpus: ${fresh.expected})`));
  }
  return findings;
}

export function checkConfig(ctx) {
  const findings = [];
  for (const { layer, path: file, message } of ctx.configErrors) {
    findings.push(error("config.layers", `the ${layer} config layer ${file} is not valid: ${message}`, "fix the JSON; the layer is ignored until then"));
  }
  if (findings.length === 0) findings.push(ok("config.layers", "every config layer parses"));

  if (ctx.mcpServers) {
    const names = new Set(Object.keys(ctx.mcpServers));
    for (const key of ["keywords", "toolBaselines", "serverMeta"]) {
      const unknown = Object.keys(ctx.config[key] ?? {}).filter((name) => !names.has(name));
      if (unknown.length) {
        findings.push(warn("config.unknownServers", `${key} names servers that are not in .mcp.json: ${unknown.join(", ")}`, "remove them, or add the servers to .mcp.json; a word in a prompt would report them as missing"));
      }
    }
  }

  // The catalog is no longer indexed in qmd, so this key does nothing. It is still accepted for one release, with this note.
  if (ctx.config.router?.catalogCollection !== undefined) {
    findings.push(warn("router.catalogCollection", "router.catalogCollection has no effect: the catalog is not a qmd collection any more, and the key will be removed in a later release", "toolgate config unset router.catalogCollection (with --user or --local for the layer that sets it)"));
  }
  const backend = ctx.config.router?.backend ?? "regex";
  if (backend === "regex" && ctx.qmd) {
    findings.push(warn("router.backend", 'the router backend is "regex" although qmd is available', 'toolgate config set router.backend qmd'));
  }
  return findings;
}

function frontmatterOf(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match ? match[1] : "";
}

export function checkRule({ cwd }) {
  const present = RULE_FILES.filter((file) => fs.existsSync(path.join(cwd, file)));
  if (present.length === 0) {
    return [error("rule.step0", "the Step 0 rule (toolgate-router.md) was not found", "toolgate init")];
  }
  const findings = [];
  // The agent reads the generated file, not the rulesync source: a target whose file `rulesync generate` has not written yet
  // (a new git worktree) is reported, and the source is not counted as the rule that loads.
  const notGenerated = present.includes(RULESYNC_RULE) ? step0NotGenerated(cwd) : [];
  for (const file of present) {
    const frontmatter = frontmatterOf(fs.readFileSync(path.join(cwd, file), "utf8"));
    if (/^paths\s*:/m.test(frontmatter)) findings.push(error("rule.step0", `${file} has a "paths:" frontmatter, so it only loads after a matching file is read`, "remove the paths: key"));
    else if (file !== RULESYNC_RULE || notGenerated.length === 0) findings.push(ok("rule.step0", `${file} is present and loads at session start`));
  }
  for (const target of notGenerated) findings.push(warn("rule.step0", `the Step 0 rule was not generated for ${printable(target)} (.rulesync source found)`, "npx rulesync generate"));
  return findings;
}


export function checkMcp(ctx) {
  const findings = [];
  if (ctx.mcpServers === null) {
    return [ctx.mcpInvalid
      ? error("mcp.baseline", `.mcp.json is not valid: ${ctx.mcpInvalid}`)
      : warn("mcp.baseline", ".mcp.json was not found, so there are no servers to govern")];
  }

  const missing = (ctx.config.baseline ?? []).filter((name) => !Object.hasOwn(ctx.mcpServers, name));
  findings.push(
    missing.length
      ? error("mcp.baseline", `baseline servers missing from .mcp.json: ${missing.map(printable).join(", ")}`, "add them to .mcp.json or remove them from baseline")
      : ok("mcp.baseline", "every baseline server is in .mcp.json")
  );

  // An entry that still uses a name toolgate-proxy no longer reads: the proxy would not start, so this is an error, in its own words.
  const stale = new Set();
  for (const [name, def] of Object.entries(ctx.mcpServers)) {
    if (!isProxied(def)) continue;
    for (const pair of oldProxyNames(def.env)) {
      stale.add(name);
      // `toolgate update` does not migrate a file this big: the same words as its own line, and the rename is by hand.
      const big = (ctx.mcpBytes ?? 0) > MAX_MCP_BYTES;
      findings.push(
        error("mcp.proxy", big ? `${renamedText(pair).replace(/; run toolgate update$/, "")}; .mcp.json is larger than ${MAX_MCP_BYTES / 1024 / 1024} MiB; not migrated` : renamedText(pair), big ? `rename it by hand in the entry of ${printable(name)}` : `rename it in the entry of ${printable(name)}, or run toolgate update`),
      );
    }
  }

  // A server toolgate-proxy does not wrap cannot have tools revealed in a session, only by a restart. The ones with a tool baseline get their
  // own, older warning below; an entry that is not a command (an http server) cannot be wrapped by a stdio proxy, so it is not nagged about.
  // The same two cases for every server, with or without a tool baseline: not wrapped at all, or wrapped but without `TOOLGATE_SERVER`
  // (which makes the proxy a static one: its tools are filtered, but a session cannot reveal more of them).
  for (const [name, def] of Object.entries(ctx.mcpServers)) {
    if (!isCommandServer(def)) continue;
    const hint = 'wrap it with toolgate-proxy (docs/getting-started.md, "Reveal tools without a restart")';
    if (!isProxied(def)) findings.push(warn("mcp.dynamic", `${printable(name)} is not wrapped by toolgate-proxy, so its tools cannot be revealed without a restart`, hint));
    else if (!stale.has(name) && !namesItsServer(def, name)) {
      findings.push(warn("mcp.dynamic", `${printable(name)} is wrapped by toolgate-proxy but its entry does not set TOOLGATE_SERVER to "${printable(name)}", so its tools cannot be revealed without a restart`, 'add "TOOLGATE_SERVER": "<the server name>" to its env (docs/getting-started.md, "Reveal tools without a restart")'));
    }
  }

  for (const name of Object.keys(ctx.config.toolBaselines ?? {})) {
    const def = Object.hasOwn(ctx.mcpServers, name) ? ctx.mcpServers[name] : undefined;
    if (!def) continue;
    if (stale.has(name)) continue; // said above, in the proxy's own words
    if (!isProxied(def)) {
      if (isCommandServer(def)) findings.push(warn("mcp.proxy", `${printable(name)} has a tool baseline but is not wrapped by toolgate-proxy, so it is not applied`, "wrap it with toolgate-proxy"));
      continue;
    }
    const problems = [];
    if (!def.env?.TOOLGATE_UPSTREAM_CMD) problems.push("TOOLGATE_UPSTREAM_CMD is missing");
    try {
      if (!Array.isArray(JSON.parse(def.env?.TOOLGATE_UPSTREAM_ARGS ?? "[]"))) problems.push("TOOLGATE_UPSTREAM_ARGS is not a JSON array");
    } catch {
      problems.push("TOOLGATE_UPSTREAM_ARGS is not valid JSON");
    }
    if (!def.env?.TOOLGATE_ALLOWED_TOOLS) problems.push("TOOLGATE_ALLOWED_TOOLS is missing");
    findings.push(
      problems.length
        ? error("mcp.proxy", `${printable(name)} is wrapped incorrectly: ${problems.join("; ")}`)
        : ok("mcp.proxy", `${printable(name)} is wrapped by toolgate-proxy`)
    );
  }
  return findings;
}

export function checkStrayPins({ cwd, homedir }) {
  const findings = [];
  const symlinks = new Set(symlinkedSettings({ cwd, homedir: homedir ?? os.homedir() }));
  for (const level of ["user", "project", "local"]) {
    const source = claudeSettingsFile({ level, projectDir: cwd, homeDir: homedir ?? os.homedir() });
    const { data, note } = readSettings(source);
    // A file that is not there says nothing; one that cannot be read (a link, a folder, too large, not an object, not JSON) is said, not read as "no pins".
    // A link is said under claude.settings (checkClaudeSettings); the other cases here.
    if (note && !note.includes("does not exist") && !symlinks.has(source.label)) findings.push(warn("mcp.strayPins", note));
    const pinned = pinnedServersIn(data);
    if (data?.enabledMcpjsonServers !== undefined) {
      const names = pinned.length ? ` (${pinned.map(printable).join(", ")})` : "";
      findings.push(
        warn(
          "mcp.strayPins",
          `${source.label} pins enabledMcpjsonServers${names}: this pin enables them without asking, and a disabledMcpjsonServers entry in any file overrides it; with --strict-mcp-config it loads nothing`,
          "remove the key from that file if toolgate should decide which servers load",
        ),
      );
    }
  }
  return findings.length ? findings : [ok("mcp.strayPins", "no enabledMcpjsonServers pins in the Claude settings")];
}

// Settings of the user's own Claude Code that change what toolgate prepares (a short list, each with its reason). Respected, never changed.
export function checkClaudeSettings(ctx) {
  const findings = [];
  for (const where of symlinkedSettings({ cwd: ctx.cwd, homedir: ctx.homedir ?? os.homedir() })) {
    findings.push(warn("claude.settings", `${printable(where)} is a symbolic link; toolgate does not read it, so its settings were not checked`));
  }
  for (const { where, data } of claudeSettingsFiles({ cwd: ctx.cwd, homedir: ctx.homedir ?? os.homedir() })) {
    const file = printable(where);
    for (const server of disabledServersIn(data)) {
      if (ctx.mcpServers && Object.hasOwn(ctx.mcpServers, server)) {
        findings.push(warn("claude.settings", `${file} disables ${printable(server)} (disabledMcpjsonServers); Claude Code rejects it even when toolgate activates it`, `remove ${printable(server)} from disabledMcpjsonServers in ${file}`));
      }
    }
    for (const { list, rule } of step0RulesIn(data)) {
      findings.push(
        warn(
          "claude.settings",
          list === "deny"
            ? `${file} denies ${printable(rule)}, which blocks the Step 0 command (toolgate need)`
            : `${file} asks for ${printable(rule)}, so every task prompts before toolgate need runs`,
          `narrow or remove ${printable(rule)} in ${file}`,
        ),
      );
    }
    for (const name of envOverridesIn(data)) {
      findings.push(warn("claude.settings", `${file} sets ${printable(name)} in env, which overrides the value toolgate passes at launch to MCP servers`, `remove ${printable(name)} from env in ${file}`));
    }
  }
  return findings;
}

export function checkUserServers(ctx) {
  if (ctx.config.client?.exclusiveMcp === true) {
    return [ok("mcp.userLevel", "client.exclusiveMcp is on: only the active servers load")];
  }
  const project = new Set(Object.keys(ctx.mcpServers ?? {}));
  const outside = Object.keys(readServerDefs({ project: { mcpServers: ctx.mcpServers ?? {} }, homedir: ctx.homedir, cwd: ctx.cwd })).filter((name) => !project.has(name));
  return outside.length
    ? [warn("mcp.userLevel", `user-level servers load outside toolgate's control: ${outside.join(", ")}`, "toolgate config set client.exclusiveMcp true")]
    : [ok("mcp.userLevel", "no user-level servers load outside toolgate's control")];
}

export function checkNaming(ctx) {
  const names = new Set(ctx.config.baseline ?? []);
  for (const key of ["keywords", "toolBaselines", "serverMeta"]) {
    for (const server of Object.keys(ctx.config[key] ?? {})) names.add(server);
  }
  for (const tools of Object.values(ctx.config.toolBaselines ?? {})) {
    for (const tool of Array.isArray(tools) ? tools : Object.keys(tools ?? {})) names.add(tool);
  }
  const findings = [...names].flatMap((name) => {
    const terms = deniedTerms(name);
    return terms.length
      ? [warn("naming.denylist", `"${name}" contains ${terms.map((t) => `"${t}"`).join(", ")}, which the client's permission classifier may deny`, "rename it to something neutral (F7)")]
      : [];
  });
  return findings.length ? findings : [ok("naming.denylist", "no injected name matches the denylist")];
}

// The command that removes an override from the layer that holds it. The JSON goes in single
// quotes, so a quote inside it is closed, escaped and reopened.
function removeOverrideHint(layer, entry) {
  const flag = layer === "user" || layer === "local" ? ` --${layer}` : "";
  return `toolgate config remove skills.overrides${flag} '${JSON.stringify(entry).replaceAll("'", "'\\''")}'`;
}

export function checkSkills(ctx) {
  const { cwd } = ctx;
  const findings = [];
  const options = skillsSettings(ctx.config, cwd);
  const installedDir = path.resolve(cwd, SKILLS_DIR);
  // A `skills.sources` that is not a list indexes nothing: it is dropped at load, and said here as the error it is.
  for (const entry of ctx.config?.ignored ?? []) {
    if (entry.key === "skills.sources") findings.push(error("skills.sources", "skills.sources must be a list", `fix it in the ${printable(entry.layer)} config: toolgate config add skills.sources '{"dir":"<folder>"}'${entry.layer === "project" ? "" : ` --${entry.layer}`}`));
  }

  if (fs.existsSync(installedDir) && !options.sources.some((source) => typeof source?.dir === "string" && path.resolve(cwd, source.dir) === installedDir)) {
    findings.push(warn("skills.unindexed", `${SKILLS_DIR} holds skills but is not one of the skills sources, so they are not indexed`, `toolgate config add skills.sources '{"dir":"${SKILLS_DIR}"}'`));
  }

  try {
    const lock = readLock(path.join(cwd, LOCK_FILE));
    for (const what of lock.invalid) findings.push(error("skills.lockDrift", printable(`${LOCK_FILE}: ${what}`)));
    for (const name of Object.keys(lock.skills)) {
      // The lock is committed: only a plain name is turned into a path to hash.
      if (!SAFE_NAME.test(name)) {
        findings.push(error("skills.lockDrift", `${LOCK_FILE} has an entry whose name is not a plain name, it was not checked: ${printable(name)}`));
        continue;
      }
      const dir = path.join(installedDir, name);
      if (!fs.existsSync(dir)) {
        findings.push(error("skills.lockDrift", `${printable(name)} is in ${LOCK_FILE} but missing from ${SKILLS_DIR}`, "toolgate skills install <source> " + printable(name)));
        continue;
      }
      let hash = null;
      try {
        hash = hashOrNull(dir, hashDir);
      } catch (err) {
        findings.push(error("skills.lockDrift", `${printable(name)} could not be read: ${printable(err.message.split("\n")[0])}`));
        continue;
      }
      if (hash !== lock.skills[name].hash) {
        findings.push(warn("skills.lockDrift", `${printable(name)} was edited by hand: it differs from ${LOCK_FILE}`, "toolgate skills install --force to restore it"));
      }
    }
  } catch (err) {
    findings.push(error("skills.lockDrift", err.message));
  }

  // The user and local levels have their own stores and locks; the project's is checked above.
  // A level the project switched off is not used, so its lock is not a problem to report.
  const off = ctx.config?.skills?.disabledLevels ?? [];
  for (const level of off) findings.push(ok("skills.lockDrift", `the ${level} level is switched off by this project; its lock is not checked`));
  try {
    const status = assetStatus({ projectDir: cwd, userDir: userConfigDir({ cwd, env: ctx.env ?? process.env, homedir: ctx.homedir }), levels: ["user", "local"].filter((level) => !off.includes(level)) });
    for (const row of status.rows) {
      if (row.states.includes("missing")) findings.push(error("skills.lockDrift", `${printable(row.name)} is in the ${row.level} lock but missing from its store`, `toolgate skills install --${row.level} <source> ${printable(row.name)}`));
      if (row.states.includes("edited")) findings.push(warn("skills.lockDrift", `${printable(row.name)} (${row.level}) was edited by hand: it differs from its lock`, `toolgate skills install --${row.level} --force to restore it`));
    }
    for (const problem of status.problems) findings.push(error("skills.lockDrift", printable(problem)));
  } catch (err) {
    findings.push(warn("skills.lockDrift", `levels could not be checked: ${printable(err.message.split("\n")[0])}`));
  }
  for (const { layer, entry } of ctx.config?.skills?.invalidOverrides ?? []) {
    findings.push(error("skills.overrides", `the ${layer ?? "project"} config has an override that cannot be applied and is ignored: ${jsonSafe(JSON.stringify(entry))}`, "fix it in that file; it needs a skill and at least one of tags, mcps and description"));
  }
  const stale = staleCards(skillsLocation(ctx.config, cwd).corpusDir);
  if (stale.length) {
    findings.push(warn("skills.cardFormat", `${stale.length} card${stale.length === 1 ? " was" : "s were"} written by an older version and cannot be read (${stale.slice(0, 3).map((name) => Array.from(printable(name)).slice(0, 60).join("")).join(", ")}${stale.length > 3 ? ", …" : ""}): route and need skip them`, "toolgate skills index"));
  }

  let skills = [];
  if (options.sources.length) {
    try {
      skills = scanSkills(options.sources, options.overrides);
      findings.push(...invalidFindings("skills", skills.skipped, cwd));
      // An empty index still has orphans; a failed scan does not tell, so it is checked only here.
      const known = new Set(skills.map((skill) => skill.name));
      for (const { layer, ...entry } of options.overrides ?? []) {
        if (!known.has(entry.skill)) findings.push(warn("skills.overrides", `an override in the ${layer ?? "project"} config names "${printable(entry.skill)}", which is not an indexed skill`, removeOverrideHint(layer, entry)));
      }
    } catch (err) {
      findings.push(warn("skills.levels", `skills could not be scanned: ${err.message.split("\n")[0]}`));
    }
  }
  // Overrides are applied by the scan, so a skill whose override gives a description is not reported.
  findings.push(
    ...descriptionFindings("skills", skills, cwd, (skill) => `${FRONTMATTER_HINT}, or toolgate config add skills.overrides '{"skill":${jsonSafe(JSON.stringify(skill.name))},"description":"<text>"}'`)
  );
  for (const skill of skills) {
    if (skill.level !== "project") findings.push(warn("skills.levels", `${skill.name} exists only at the ${skill.level} level`));
    if (skill.shadows?.length) findings.push(warn("skills.levels", `${skill.name} (${skill.level}) shadows the ${skill.shadows.join(", ")} level`));
  }

  // A skill is found by its folder as well as by its name, so the two must agree (only for a SKILL.md in a folder of
  // its own: a custom glob without one has no folder to compare).
  for (const skill of skills) {
    const folder = path.basename(path.dirname(skill.path));
    if (path.basename(skill.path) === "SKILL.md" && folder !== skill.name) {
      const relative = path.relative(cwd, skill.path);
      const file = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : skill.path;
      findings.push(error("skills.name", `${printable(skill.name)} is in folder ${printable(folder)} (${printable(file)})`, `rename the folder, or set "name: ${printable(folder)}"`));
    }
  }

  const installed = installedServers({ cwd, homedir: ctx.homedir });
  if (installed) {
    for (const skill of skills) {
      const absent = (skill.mcps ?? []).filter((name) => !installed.servers.includes(name));
      if (absent.length) findings.push(warn("skills.mcps", `${skill.name} needs MCP servers the agent has not configured: ${absent.join(", ")}`));
    }
  }

  // Skills that `toolgate skills index` would index, and no index here (a new git worktree): not "skills are indexed".
  if (skillsButNoIndex(ctx.config, cwd, ctx.env ?? process.env)) findings.push(warn("skills.index", "skills exist but are not indexed in this checkout", "toolgate skills index"));
  return findings.length ? findings : [ok("skills", "skills are indexed, in sync with the lock, and have their servers")];
}



/**
 * The same checks as for skills, for commands: the store is indexed, the lock agrees with it at every level, the
 * levels and servers are as they should be, and the commands an agent keeps of its own are told about.
 * A project with no command at all gets no finding.
 */
export function checkCommands(ctx) {
  const { cwd } = ctx;
  const env = ctx.env ?? process.env;
  const findings = [];
  const options = skillsSettings(ctx.config, cwd, env);
  const storeAbs = path.resolve(cwd, COMMANDS_DIR);
  const hasStore = fs.existsSync(storeAbs) && fs.readdirSync(storeAbs).some((name) => name.endsWith(".md"));

  if (hasStore && !options.commandSources.some((source) => typeof source?.dir === "string" && path.resolve(cwd, source.dir) === storeAbs)) {
    findings.push(warn("commands.unindexed", `${COMMANDS_DIR} holds commands but is not one of the commands sources, so they are not indexed`, `toolgate config add commands.sources '{"dir":"${COMMANDS_DIR}"}'`));
  }

  // Every level has its own store and lock. A level the project switched off is not used, so its lock is not a problem.
  const off = ctx.config?.commands?.disabledLevels ?? [];
  let installed = 0;
  try {
    const status = assetStatus({
      kind: COMMAND_KIND,
      projectDir: cwd,
      userDir: userConfigDir({ cwd, env, homedir: ctx.homedir }),
      levels: ["user", "project", "local"].filter((level) => !off.includes(level)),
      sources: options.commandSources,
    });
    installed = status.rows.length;
    const flag = (level) => (level === "project" ? "" : ` --${level}`);
    for (const row of status.rows) {
      if (row.states.includes("missing")) findings.push(error("commands.lockDrift", `${printable(row.name)} is in the ${row.level} lock but missing from its store`, `toolgate commands update${flag(row.level)} ${printable(row.name)}`));
      if (row.states.includes("edited")) findings.push(warn("commands.lockDrift", `${printable(row.name)} (${row.level}) was edited by hand: it differs from its lock`, `toolgate commands update${flag(row.level)} --force ${printable(row.name)} to restore it`));
      if (row.shadows.length) findings.push(warn("commands.levels", `${printable(row.name)} (${row.level}) shadows the ${row.shadows.join(", ")} level`));
    }
    for (const problem of status.problems) {
      findings.push((/could not be scanned/.test(problem) ? warn : error)(/could not be scanned/.test(problem) ? "commands.levels" : "commands.lockDrift", printable(problem)));
    }
  } catch (err) {
    findings.push(warn("commands.lockDrift", `levels could not be checked: ${printable(err.message.split("\n")[0])}`));
  }
  for (const level of off) findings.push(ok("commands.lockDrift", `the ${level} level is switched off by this project; its lock is not checked`));

  const known = (() => {
    try {
      const scanned = scanCommands(options.commandSources);
      findings.push(...invalidFindings("commands", scanned.skipped, cwd));
      return scanned;
    } catch {
      // A problem with a source itself (a missing folder, a duplicate name) is already said, as `commands.levels`, by
      // the status check above.
      return [];
    }
  })();
  findings.push(...descriptionFindings("commands", known, cwd, () => FRONTMATTER_HINT));
  const servers = installedServers({ cwd, homedir: ctx.homedir });
  if (servers) {
    for (const command of known) {
      const absent = (command.mcps ?? []).filter((name) => !servers.servers.includes(name));
      if (absent.length) findings.push(warn("commands.mcps", `${printable(command.name)} needs MCP servers the agent has not configured: ${absent.map(printable).join(", ")}`));
    }
    findings.push(...toolServerFindings("commands", known, (command) => command.allowedTools ?? [], servers.servers, cwd));
  }

  // The commands an agent keeps of its own are not managed by toolgate until they are imported.
  try {
    const managed = new Set(known.map((command) => command.name));
    const { folders } = nativeFolders({ base: cwd });
    for (const folder of folders) {
      const { items } = commandKind(folder.dialect).discover(folder.dir);
      const loose = items.filter((item) => !managed.has(item.name));
      if (loose.length) {
        findings.push(warn("commands.native", `${loose.length} command${loose.length === 1 ? "" : "s"} in ${printable(folder.label)} ${loose.length === 1 ? "is" : "are"} not managed by toolgate (${loose.slice(0, 3).map((item) => printable(item.name)).join(", ")}${loose.length > 3 ? ", …" : ""}): the agent loads them all on its own`, "toolgate commands import"));
      }
    }
  } catch (err) {
    findings.push(warn("commands.native", `the commands of the agents could not be listed: ${printable(err.message.split("\n")[0])}`));
  }

  // The /toolgate bridge: the one command registered in an agent, for each agent found with a commands folder.
  for (const agent of ctx.agents ?? []) {
    const { state, file } = bridgeState({ agent: agent.name, base: cwd });
    const shown = file ? printable(file) : "";
    if (state === "missing") findings.push(ok("commands.bridge", `${printable(agent.name)} has no /toolgate command (${shown}); commands are still reached through the Step 0 rule. To register it: toolgate commands bridge ${printable(agent.name)}`));
    else if (state === "outdated") findings.push(warn("commands.bridge", `${shown} was generated by an older toolgate`, `toolgate commands bridge ${printable(agent.name)}`));
    else if (state === "edited") findings.push(warn("commands.bridge", `${shown} was edited by hand`, `toolgate commands bridge ${printable(agent.name)} --force to regenerate it`));
    else if (state === "foreign") findings.push(warn("commands.bridge", `${shown} exists and toolgate did not generate it, so /toolgate is not toolgate's here`, "rename it, then: toolgate commands bridge " + printable(agent.name)));
    else if (state === "current") findings.push(ok("commands.bridge", `${printable(agent.name)} has /toolgate (${shown})`));
    else if (state === "unsafe") findings.push(warn("commands.bridge", `${shown} is behind a symlink and is not used`));
  }

  if (findings.some((finding) => finding.level !== "ok")) return findings;
  return installed + known.length > 0 ? [...findings, ok("commands", "commands are indexed, in sync with their lock, and have their servers")] : findings;
}

/**
 * The checks for subagents: the store is one of the sources, the lock agrees with it at every level, the
 * servers they need are configured, the subagents an agent keeps of its own are told about, and the tools each
 * one really gets are listed. A project with no subagent at all gets no finding.
 */
export function checkSubagents(ctx) {
  const { cwd } = ctx;
  const env = ctx.env ?? process.env;
  const findings = [];
  const options = skillsSettings(ctx.config, cwd, env);
  const storeAbs = path.resolve(cwd, SUBAGENTS_DIR);
  const hasStore = fs.existsSync(storeAbs) && fs.readdirSync(storeAbs).some((name) => name.endsWith(".md"));

  if (hasStore && !options.subagentSources.some((source) => typeof source?.dir === "string" && path.resolve(cwd, source.dir) === storeAbs)) {
    findings.push(warn("subagents.unindexed", `${SUBAGENTS_DIR} holds subagents but is not one of the subagents sources, so they are not used`, `toolgate config add subagents.sources '{"dir":"${SUBAGENTS_DIR}"}'`));
  }

  const off = ctx.config?.subagents?.disabledLevels ?? [];
  let installed = 0;
  try {
    const status = assetStatus({
      kind: SUBAGENT_KIND,
      projectDir: cwd,
      userDir: userConfigDir({ cwd, env, homedir: ctx.homedir }),
      levels: ["user", "project", "local"].filter((level) => !off.includes(level)),
      sources: options.subagentSources,
    });
    installed = status.rows.length;
    const flag = (level) => (level === "project" ? "" : ` --${level}`);
    for (const row of status.rows) {
      if (row.states.includes("missing")) findings.push(error("subagents.lockDrift", `${printable(row.name)} is in the ${row.level} lock but missing from its store`, `toolgate subagents update${flag(row.level)} ${printable(row.name)}`));
      if (row.states.includes("edited")) findings.push(warn("subagents.lockDrift", `${printable(row.name)} (${row.level}) was edited by hand: it differs from its lock`, `toolgate subagents update${flag(row.level)} --force ${printable(row.name)} to restore it`));
      if (row.shadows.length) findings.push(warn("subagents.levels", `${printable(row.name)} (${row.level}) shadows the ${row.shadows.join(", ")} level`));
    }
    for (const problem of status.problems) {
      findings.push((/could not be scanned/.test(problem) ? warn : error)(/could not be scanned/.test(problem) ? "subagents.levels" : "subagents.lockDrift", printable(problem)));
    }
  } catch (err) {
    findings.push(warn("subagents.lockDrift", `levels could not be checked: ${printable(err.message.split("\n")[0])}`));
  }
  for (const level of off) findings.push(ok("subagents.lockDrift", `the ${level} level is switched off by this project; its lock is not checked`));

  const known = (() => {
    try {
      const scanned = scanSubagents(options.subagentSources);
      findings.push(...invalidFindings("subagents", scanned.skipped, cwd));
      return scanned;
    } catch {
      // A problem with a source itself (a missing folder, a duplicate name) is already said, as `subagents.levels`, by
      // the status check above.
      return [];
    }
  })();
  findings.push(...descriptionFindings("subagents", known, cwd, () => FRONTMATTER_HINT));
  // What each one gets, so a copy that is wider than expected is visible.
  for (const subagent of known) {
    findings.push(ok("subagents.tools", `${printable(subagent.name)} gets: ${subagent.effectiveTools.map(printable).join(", ")}${subagent.tools ? "" : " (the read-only default: its definition lists no tools)"}`));
  }
  const servers = installedServers({ cwd, homedir: ctx.homedir });
  if (servers) {
    for (const subagent of known) {
      const absent = (subagent.mcps ?? []).filter((name) => !servers.servers.includes(name));
      if (absent.length) findings.push(warn("subagents.mcps", `${printable(subagent.name)} needs MCP servers the agent has not configured: ${absent.map(printable).join(", ")}`));
    }
    findings.push(...toolServerFindings("subagents", known, (subagent) => subagent.tools ?? [], servers.servers, cwd));
  }

  // The subagents an agent keeps of its own are loaded by the agent whether or not toolgate manages them.
  try {
    const managed = new Set(known.map((subagent) => subagent.name));
    const { folders } = nativeFolders({ base: cwd, capabilities: SUBAGENTS_NATIVE });
    for (const folder of folders) {
      const { items } = subagentKind(folder.dialect).discover(folder.dir);
      const loose = items.filter((item) => !managed.has(item.name));
      if (loose.length) {
        findings.push(warn("subagents.native", `${loose.length} subagent${loose.length === 1 ? "" : "s"} in ${printable(folder.label)} ${loose.length === 1 ? "is" : "are"} not managed by toolgate (${loose.slice(0, 3).map((item) => printable(item.name)).join(", ")}${loose.length > 3 ? ", …" : ""}): the agent registers them all on its own`, "toolgate subagents import"));
      }
    }
  } catch (err) {
    findings.push(warn("subagents.native", `the subagents of the agents could not be listed: ${printable(err.message.split("\n")[0])}`));
  }

  return findings;
}

// Hooks and permissions: the store against its lock, the units still waiting for an approval or a grant on this machine, and
// the agents that cannot apply them. Silent when no unit is installed, so a project that does not use them sees nothing.
function checkReviewed({ ctx, kind, noun, plural }) {
  const { cwd } = ctx;
  const env = ctx.env ?? process.env;
  const findings = [];
  const off = ctx.config?.[plural]?.disabledLevels ?? [];
  const userDir = userConfigDir({ cwd, env, homedir: ctx.homedir });
  let rows = [];
  try {
    const status = assetStatus({ kind, projectDir: cwd, userDir, levels: ["user", "project", "local"].filter((level) => !off.includes(level)), sources: [] });
    rows = status.rows;
    const flag = (level) => (level === "project" ? "" : ` --${level}`);
    for (const row of rows) {
      if (row.states.includes("missing")) findings.push(error(`${plural}.lockDrift`, `${printable(row.name)} is in the ${row.level} lock but missing from its store`, `toolgate ${plural} update${flag(row.level)} ${printable(row.name)}`));
      if (row.states.includes("edited")) findings.push(warn(`${plural}.lockDrift`, `${printable(row.name)} (${row.level}) was edited by hand: it differs from its lock`, `toolgate ${plural} update${flag(row.level)} --force ${printable(row.name)} to restore it`));
    }
    for (const problem of status.problems) findings.push(warn(`${plural}.levels`, printable(problem)));
  } catch (err) {
    return [warn(`${plural}.lockDrift`, `levels could not be checked: ${printable(err.message.split("\n")[0])}`)];
  }
  if (!rows.length) return findings;
  let effective;
  try {
    effective = effectiveSet({ projectDir: cwd, userDir, config: ctx.config ?? {}, approvals: loadApprovals(userDir) });
  } catch (err) {
    return [...findings, warn(`${plural}.pending`, `approvals could not be read: ${printable(err.message.split("\n")[0])}`)];
  }
  for (const problem of effective.problems) findings.push(warn(`${plural}.levels`, printable(problem)));
  const waiting = effective.pending.filter((p) => p.kind === noun);
  if (waiting.length) findings.push(warn(`${plural}.pending`, `${waiting.length} ${noun}${waiting.length === 1 ? "" : "s"} not applied: ${waiting.map((p) => `${printable(p.name)} (${p.level}: ${printable(p.reason)})`).join("; ")}`, `toolgate ${plural} review${noun === "permission" ? " [--grant]" : ""}`));
  else {
    // A unit that could not be read is not installed as far as the launch is concerned: only the valid ones are counted.
    const invalid = effective.problems.filter((p) => p.startsWith(`${noun} `)).length;
    const valid = rows.length - invalid;
    findings.push(ok(`${plural}.pending`, invalid ? `every valid installed ${noun} (${valid}) is approved on this machine; ${invalid} invalid ${noun}${invalid === 1 ? " is" : "s are"} not applied` : `every installed ${noun} is approved on this machine`));
  }
  const deny = noun === "permission" ? effective.permissions.deny.length : 0;
  for (const agent of ctx.agents ?? []) {
    const capability = agent.adapter?.capability?.[plural]?.kind;
    if (capability === "none" || capability === "unknown") {
      const message = `${rows.length} ${noun}${rows.length === 1 ? "" : "s"} installed but ${printable(agent.name)} cannot apply them (${plural}: ${capability}${capability === "unknown" ? ", not verified" : ""})`;
      findings.push((deny && capability === "none" ? error : warn)(`${plural}.adapter`, deny ? `${message}; its ${deny} deny rule${deny === 1 ? " is" : "s are"} NOT applied there` : message));
    }
    if (noun === "permission" && capability === "configEnv") {
      for (const u of opencodeEnv(effective.permissions, {}).unmapped.filter((x) => x.list !== "allow")) {
        findings.push(warn("permissions.unmapped", `${printable(agent.name)} cannot express ${printable(u.rule)} [${u.list}]${u.list === "deny" ? ": NOT APPLIED there" : ""}: ${printable(u.reason)}`));
      }
    }
  }
  return findings;
}

// Claude Code settings of the user that turn toolgate's hooks and ask rules off: respected, and said (the launch says it too).
export function checkGuardsOff(ctx) {
  return guardsOffInFiles({ cwd: ctx.cwd, homedir: ctx.homedir ?? os.homedir() }).map(({ setting, where }) =>
    warn("claude.guardsOff", `${printable(where)} sets ${setting}: toolgate's hooks and ask rules do not apply in Claude Code`, `remove it from ${printable(where)} to turn toolgate's guards back on`));
}
export const checkHooks = (ctx) => checkReviewed({ ctx, kind: HOOK_KIND, noun: "hook", plural: "hooks" });
export const checkPermissions = (ctx) => checkReviewed({ ctx, kind: PERMISSION_KIND, noun: "permission", plural: "permissions" });

// The MCP server catalog: silent for a project that never built one. Otherwise it must still describe the servers that are
// configured, and be newer than their definitions. Warnings only: the router still works without it.
export function checkCatalog(ctx) {
  const catalog = catalogForRoute({ config: ctx.config ?? {}, cwd: ctx.cwd, homedir: ctx.homedir });
  if (!catalog) return [];
  const findings = [];
  const hint = "toolgate catalog build";
  const orphans = [...catalog.servers.keys()].filter((server) => !catalog.known.has(server));
  const unknown = [...catalog.known].filter((server) => !catalog.servers.has(server));
  if (orphans.length) findings.push(warn("catalog.orphans", `the catalog has entries for servers that are no longer configured: ${orphans.map((s) => printable(s)).join(", ")}`, hint));
  if (unknown.length) findings.push(warn("catalog.missing", `the catalog does not describe ${unknown.map((s) => printable(s)).join(", ")}`, hint));
  const oldest = Math.min(...[...catalog.servers.values()].map((entry) => entry.mtimeMs));
  if (catalog.definitionMtime > oldest) findings.push(warn("catalog.stale", "the catalog is older than the definitions of the MCP servers", hint));
  if (!findings.length) findings.push(ok("catalog.fresh", `the catalog describes ${catalog.servers.size} server${catalog.servers.size === 1 ? "" : "s"}`));
  return findings;
}

// Settings the merge dropped because the layer they came from is not trusted with them (`router.qmdUrl` in the project file).
export function checkIgnored(ctx) {
  return (ctx.config?.ignored ?? []).filter((entry) => entry.key !== "skills.sources").map((entry) => warn("config.ignored", `${printable(entry.key)} in the ${printable(entry.layer)} config is ignored: ${entry.reason === "invalid" || entry.reason === "port" ? invalidWhy(entry.key, entry.reason) : entry.reason === "tracked" ? "git versions that file, so it ships with the repository" : ignoredWhat(entry.key)}`, entry.reason === "invalid" || entry.reason === "port" ? `fix the value: toolgate config set ${entry.key} ${invalidFix(entry.key)} --user` : entry.reason === "tracked" ? `git rm --cached .toolgate/config.local.json, or set it with: toolgate config ${entry.key === "skills.allowedHosts" ? "add" : "set"} ${entry.key} <value> --user` : `set it in your user or local config: toolgate config ${entry.key === "skills.allowedHosts" ? "add" : "set"} ${entry.key} <value> --user`));
}
