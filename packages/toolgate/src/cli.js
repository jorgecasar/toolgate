import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSafe, printable } from "./assets/common.js";
import { configLayerPaths, loadConfig, loadState, resolveConfig, saveState, consumeEscalations, escalateServers, mergeEscalations, withoutEscalations, userConfigDir } from "./config.js";
import { editConfigFile, parseValueFor, restoreHint, trackedAndMissing } from "./configFile.js";
import { route } from "./router.js";
import { formatNeed, resolveNeed } from "./need.js";
import { createRegistry, defaultRegistry } from "./adapters/index.js";
import { extractPrompt, isSubcommand, splitAgentArgs, splitLaunchArgs } from "./wrapper.js";
import { refreshDaemonIfStale, restartDaemon } from "./daemonFreshness.js";
import { launchEnv, sessionFor, wrappedServers } from "./sessionLaunch.js";
import { inspectSession, isSessionFile, readInstructions, updateSession } from "./session.js";
import { runTools } from "./tools.js";
import { runDoctor } from "./doctor/index.js";
import { runUpdate } from "./update/index.js";
import { setProgress } from "./progress.js";
import { detectAgents } from "./agentReport.js";
import { runInit } from "./init.js";
import { runCommands } from "./commands/cli.js";
import { runSubagents } from "./subagents/cli.js";
import { runHooks } from "./hooks/cli.js";
import { runCatalog } from "./catalog/cli.js";
import { catalogForRoute, readCatalog } from "./catalog/read.js";
import { runPermissions } from "./permissions/cli.js";
import { activeSubagents } from "./subagents/register.js";
import { loadApprovals } from "./assets/approval.js";
import { claudeSettingsFor, copyHookUnits, launchPlan } from "./hooks/effective.js";
import { opencodeEnv } from "./permissions/opencode.js";
import { runSkills, settings } from "./skills/cli.js";
import { unsupportedFlag } from "./skills/flags.js";
import { scanCommands } from "./skills/scan.js";
import { readStamp } from "./daemonStamp.js";
import { COLD_START_ATTEMPTS, daemonStatus, defaultExec, ensureDaemon, managedPort, portHolder, qmdBinOf, stopDaemon } from "./daemon.js";

// `adapters` is a registry (`.get`) or, as a test seam, a plain `{ name: loader }` map.
function toRegistry(adapters) {
  return typeof adapters?.get === "function" ? adapters : createRegistry(adapters, { validate: false });
}

function resolveAdapter(name, adapters = defaultRegistry) {
  return toRegistry(adapters).get(name);
}

// The words that name a toolgate command; any other first word is an agent or a task.
const SUBCOMMANDS = new Set(["init", "skills", "commands", "subagents", "catalog", "hooks", "permissions", "config", "daemon", "doctor", "update", "route", "need", "tools", "escalate"]);
/** The part of the command line that is toolgate's own: all of it, or what comes before `--` when an agent is launched. */
function launchArgs(argv, env) {
  const at = argv.indexOf("--");
  if (at <= 0) return argv;
  try {
    const [first] = parseArgs(argv.slice(0, at), env).positional;
    return first !== undefined && !SUBCOMMANDS.has(first) ? argv.slice(0, at) : argv;
  } catch {
    return argv;
  }
}
function parseArgs(argv, env = process.env) {
  let adapter;
  let routePrompt;
  // `--policy` never changed a result and was removed; it is noticed so that it fails, not joined to the task text.
  let policyRemoved = false;
  let backend;
  let port;
  let json = false;
  let force = false;
  let noRoute = false;
  let user = false;
  let local = false;
  let remote = false;
  let dryRun = false;
  let prune = false;
  let acceptLicense = false;
  let keepOverrides = false;
  let catalog = false;
  let yes = false;
  let grant = false;
  let effective = false;
  let installRecommended;
  let agent;
  let targets;
  let installQmd = false;
  let installRulesync = false;
  let bridge = false;
  let sourceFilter;
  let serverName;
  let check = false;
  let ref;
  let subdir;
  let kind;
  let dialect;
  const exclude = [];
  const positional = [];
  let quiet = false;
  // Flags toolgate does not know, then what follows `--`: they belong to the agent and reach it as they are.
  const agentArgs = [];
  // Everything toolgate did not take for itself, in order and with the flags' values: the launch path splits it into agent flags and prompt.
  const forwarded = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--adapter" && i + 1 < argv.length) {
      adapter = argv[++i];
    } else if (argv[i] === "--prompt" && i + 1 < argv.length) {
      routePrompt = argv[++i];
    } else if (argv[i] === "--policy" || argv[i].startsWith("--policy=")) {
      policyRemoved = true;
    } else if (argv[i] === "--backend" && i + 1 < argv.length) {
      backend = argv[++i];
    } else if (argv[i] === "--port" && i + 1 < argv.length) {
      port = Number(argv[++i]);
    } else if (argv[i] === "--json") {
      json = true;
    } else if (argv[i] === "--force") {
      force = true;
    } else if (argv[i] === "--quiet" || argv[i] === "-q") {
      quiet = true;
    } else if (argv[i] === "--") {
      agentArgs.push(...argv.slice(i + 1));
      forwarded.push(...argv.slice(i));
      break;
    } else if (argv[i] === "--no-route") {
      noRoute = true;
    } else if (argv[i] === "--install-qmd") {
      installQmd = true;
    } else if (argv[i] === "--install-rulesync") {
      installRulesync = true;
    } else if (argv[i] === "--bridge") {
      bridge = true;
    } else if (argv[i] === "--targets" || argv[i].startsWith("--targets=")) {
      const value = argv[i].includes("=") ? argv[i].slice(argv[i].indexOf("=") + 1) : argv[++i];
      targets = String(value ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    } else if (argv[i] === "--agent" && i + 1 < argv.length) {
      agent = argv[++i];
    } else if (argv[i] === "--user") {
      user = true;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--yes" || argv[i] === "-y") {
      yes = true;
    } else if (argv[i] === "--grant") {
      grant = true;
    } else if (argv[i] === "--effective") {
      effective = true;
    } else if (argv[i] === "--install-recommended" || argv[i].startsWith("--install-recommended=")) {
      // `--install-recommended a,b`, `--install-recommended=a,b` and a bare flag (all of them) are the same
      // for everyone who writes them; after `init` a value that is not a flag is the list.
      let value = argv[i].includes("=") ? argv[i].slice(argv[i].indexOf("=") + 1) : undefined;
      if (value === undefined && positional[0] === "init" && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) value = argv[++i];
      installRecommended = value === undefined ? true : [...new Set(value.split(",").filter(Boolean))];
    } else if (argv[i] === "--keep-overrides") {
      keepOverrides = true;
    } else if (argv[i] === "--catalog") {
      catalog = true;
    } else if (argv[i] === "--prune") {
      prune = true;
    } else if (argv[i] === "--accept-license") {
      acceptLicense = true;
    } else if (argv[i] === "--server") {
      serverName = argv[++i] ?? "";
    } else if (argv[i] === "--source") {
      // A missing value stays "" so that skills can refuse it instead of filtering nothing.
      sourceFilter = argv[++i] ?? "";
    } else if (argv[i] === "--remote") {
      remote = true;
    } else if (argv[i] === "--check") {
      check = true;
    } else if (argv[i] === "--local") {
      local = true;
    } else if (argv[i] === "--ref" && i + 1 < argv.length) {
      ref = argv[++i];
    } else if (argv[i] === "--path" && i + 1 < argv.length) {
      subdir = argv[++i];
    } else if (argv[i] === "--dialect") {
      // A missing value is kept as "" so the install reports it, instead of taking the next word as a name.
      dialect = i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    } else if (argv[i].startsWith("--kind=")) {
      kind = argv[i].slice("--kind=".length);
    } else if (argv[i] === "--kind") {
      // A missing value (the end, or another flag) is kept as "" so the command reports it, instead
      // of searching for "--kind" or swallowing the next flag.
      kind = i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    } else if (argv[i] === "--exclude" && i + 1 < argv.length) {
      exclude.push(argv[++i]);
    } else {
      if (argv[i].startsWith("-")) agentArgs.push(argv[i]);
      positional.push(argv[i]);
      forwarded.push(argv[i]);
    }
  }
  return {
    adapter: adapter ?? env.TOOLGATE_ADAPTER,
    positional,
    quiet,
    agentArgs,
    forwarded,
    prompt: routePrompt,
    policyRemoved,
    backend,
    port,
    json,
    force,
    noRoute,
    user,
    local,
    remote,
    check,
    dryRun,
    prune,
    acceptLicense,
    keepOverrides,
    catalog,
    yes,
    grant,
    effective,
    installRecommended,
    agent,
    targets,
    installQmd,
    installRulesync,
    bridge,
    sourceFilter,
    serverName,
    ref,
    subdir,
    exclude,
    kind,
    dialect,
  };
}

// The qmd backend queries the shared daemon, so make sure it answers before routing. Only a
// local, enabled endpoint is managed. A failure never blocks the launch: routing then degrades
// to the qmd CLI, and the reason is reported on stderr.
export async function ensureQmdDaemon({ config, backend, env, stderr, ensureFn = ensureDaemon }) {
  if ((backend ?? config?.router?.backend ?? "regex") !== "qmd") return;
  const port = managedPort(config, env);
  if (port === null) return;

  const result = await ensureFn({ port, qmdBin: qmdBinOf(config), env, stderr });
  if (!result.running) {
    stderr.write(`toolgate: qmd daemon unavailable (${result.reason}); routing falls back to the qmd CLI\n`);
  } else if (result.started) {
    stderr.write(`toolgate: started the shared qmd daemon on port ${port}\n`);
  }
}

// Step 0 at launch: route the prompt, activate the servers it implies for this launch only
// (without consuming or persisting escalations) and point the agent at the skills to load.
// A routing failure never blocks the launch, but it is reported on stderr.
export async function applyRouting({ prompt, config, state, backend, stderr }) {
  if (!prompt) return { prompt, state, routed: null };

  let routed;
  try {
    routed = await route(prompt, config, { backend });
  } catch (err) {
    stderr.write(`toolgate: routing skipped: ${err.message}\n`);
    return { prompt, state, routed: null };
  }

  const effectiveState = routed.servers.length
    ? escalateServers(state, routed.servers)
    : state;

  const skillPaths = routed.skills.map((skill) => skill.path || skill.name);
  const commandPaths = (routed.commands ?? []).map((command) => command.path).filter(Boolean);
  const hints = [
    skillPaths.length ? `[toolgate] Relevant skills, read before starting: ${skillPaths.join(", ")}` : null,
    commandPaths.length ? `[toolgate] Relevant commands, read and follow them with the request as arguments: ${commandPaths.join(", ")}` : null,
  ].filter(Boolean);
  const routedPrompt = hints.length ? `${prompt}\n\n${hints.join("\n")}` : prompt;

  return { prompt: routedPrompt, state: effectiveState, routed };
}

// `toolgate "<prompt>"` launches the agent with the computed active set.
// `toolgate escalate <server> [tool]` records a one-shot escalation for the next launch.
// `toolgate --adapter <name> "<prompt>"` selects a specific adapter.
const USAGE = `toolgate: routes a task to the skills and MCP servers it needs, and launches your agent with them.

Usage:
  toolgate [--adapter <agent>] "<task>"        launch the agent with what the task needs
  toolgate --yes [--quiet|-q] "<task>"         run it without the agent's interface and print the result (-q: do not print it)
  toolgate init [--yes] [--dry-run] [--backend qmd|regex] [--install-qmd] [--install-rulesync] [--bridge] [--targets <ids>] [--agent <name> [--user]] [--install-recommended[=<id,...>]]
                                              set the project up (never overwrites; the default agent and the
                                              recommended skills are only asked for, never decided for you)
  toolgate need "<task>" [--json]             what the task needs (the Step 0 router)
  toolgate route --prompt "<task>"            the same, as routing data
  toolgate skills <index|install|update|status|remove|recommended|search> [--user | --local]
  toolgate skills update [--dry-run] [--force] [--prune] [--source <s>] [--accept-license]
  toolgate commands <index|install|update|status|import|bridge|list|search> [--user | --local]
  toolgate subagents <install|update|status|import|list|index|search> [--user | --local]
  toolgate catalog build [--server <name>] [--dry-run] [--json]   (starts MCP servers: those of your own config, and a repository's .mcp.json only after you approve each)
  toolgate hooks <install|update|status|list|review|import|remove> [--effective [--agent <name>] [--check]] [--user | --local]   (a hook runs a command: nothing is applied until you approve it)
  toolgate permissions <install|update|status|list|review|import|remove> [--grant] [--effective [--agent <name>] [--check]] [--user | --local]   (allow rules are grants: only with --grant)
  toolgate config <set|unset|add|remove> <key> [value] [--user | --local]
  toolgate daemon <start|stop|status|restart>
  toolgate doctor                             check the setup
  toolgate update [--dry-run] [--yes] [--json]  run the migrations this version needs (it does not update the package)
  toolgate escalate <server> [tool...]        record that a server is needed
  toolgate tools <enable|disable|status|reset> ...   which tools of a proxied server this session offers (enable <server> <tool...>, disable <server> [tool...], status [server] [--json], reset [server])

Options: --help, -h      show this text (it needs no agent or config)
         --version, -v   print the toolgate version (as the first argument)
`;

/** The installed package version, read from the package.json next to `src/`. */
export function toolgateVersion() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).version;
}
// Commands that run long steps (qmd indexing, downloads) say so on stderr. Not for --json or --dry-run, and not for an agent launch.
const PROGRESS_COMMANDS = new Set(["init", "skills", "commands", "subagents", "catalog"]);
/** The progress settings for this command line, or null when nothing should be said. */
export function progressFor(argv, { stderr = process.stderr, env = process.env } = {}) {
  const command = argv.find((arg) => !arg.startsWith("-"));
  if (!PROGRESS_COMMANDS.has(command) || argv.includes("--json") || argv.includes("--dry-run")) return null;
  // A pipe, CI and --yes get plain lines: no redrawing of one line, no spinner characters.
  const plain = argv.includes("--yes") || argv.includes("-y") || Boolean(env.CI);
  return { stream: stderr, animated: Boolean(stderr.isTTY) && !plain };
}
export async function run(argv, deps = {}) {
  setProgress(progressFor(argv, { stderr: deps.stderr ?? process.stderr, env: deps.env ?? process.env }));
  try {
    return await runCommand(argv, deps);
  } finally {
    setProgress(null);
  }
}
async function runCommand(argv, deps) {
  const {
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    loadConfigFn = loadConfig,
    loadStateFn = loadState,
    saveStateFn = saveState,
    adapters = defaultRegistry,
  } = deps;

  const configLayers = configLayerPaths({ cwd, env: deps.env ?? process.env });
  const statePath = path.join(cwd, ".toolgate", "state.json");

  // Help asks for no agent and reads no config: it must work in a project that has nothing set up.
  // When toolgate launches an agent (`toolgate <agent> ... -- ...`, `toolgate "<task>" -- ...`), what follows `--` is for the
  // agent, which may have a --help of its own. Anywhere else (a subcommand, or nothing before `--`) the whole line is toolgate's.
  const own = launchArgs(argv, deps.env ?? process.env);
  if (own.includes("--help") || own.includes("-h")) {
    stdout.write(USAGE);
    return 0;
  }

  // Only as the first argument: `-v` after an agent name belongs to the agent.
  if (argv[0] === "--version" || argv[0] === "-v") {
    stdout.write(`${toolgateVersion()}\n`);
    return 0;
  }
  const agentCall = splitAgentArgs(argv, (name) => toRegistry(adapters).has(name));
  if (agentCall) {
    return runAgent(agentCall, { configLayers, statePath, cwd, stderr, adapters, deps, loadConfigFn, loadStateFn, saveStateFn });
  }

  const {
    adapter: adapterName,
    positional,
    quiet,
    agentArgs: flagArgs,
    forwarded,
    prompt: routePrompt,
    policyRemoved,
    backend,
    port,
    json,
    force,
    noRoute,
    user,
    local,
    remote,
    check,
    dryRun,
    prune,
    acceptLicense,
    keepOverrides,
    catalog,
    yes,
    grant,
    effective,
    installRecommended,
    agent: initAgent,
    targets,
    installQmd,
    installRulesync,
    bridge,
    sourceFilter,
    serverName,
    ref,
    subdir,
    exclude,
    kind,
    dialect,
  } = parseArgs(argv, deps.env ?? process.env);
  if (policyRemoved) {
    stderr.write("toolgate: --policy was removed: it never changed the result; drop it\n");
    return 1;
  }

  // After the skills index changed, a daemon that still serves the old documents is restarted.
  const refreshDaemon = () =>
    refreshDaemonIfStale({
      cwd,
      config: loadConfigFn(configLayers),
      env: deps.env ?? process.env,
      // With --json stdout is the result alone: what the daemon refresh says goes to stderr.
      stdout: json ? stderr : stdout,
      stderr,
      daemon: deps.daemon ?? { status: daemonStatus, ensure: ensureDaemon, stop: stopDaemon, holder: (daemonPort) => portHolder(daemonPort, { env: deps.env ?? process.env }) },
      fetchFn: deps.fetchFn,
    });

  const catalogContext = ({ serverFilter }) => ({
    json,
    force,
    dryRun,
    yes,
    serverFilter,
    interactive: deps.hooks?.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: deps.hooks?.ask,
    cwd,
    config: loadConfigFn(configLayers),
    stdout,
    stderr,
    env: deps.env ?? process.env,
    homedir: deps.catalog?.homedir,
    buildFn: deps.catalog?.buildFn,
  });
  if (positional[0] === "init") {
    const init = deps.init ?? {};
    const code = await runInit({ cwd, env: deps.env ?? process.env, stdout, daemon: deps.daemon, skillsDeps: deps.skills, yes, installRecommended, agent: initAgent, targets, backend, installQmd, installRulesync, bridge, dryRun, force, user, ...init });
    if (code === 0 && !dryRun) await refreshDaemon();
    return code;
  }
  if (positional[0] === "skills") {
    if (user && local) {
      stderr.write("toolgate skills: choose one of --user and --local\n");
      return 1;
    }
    const unsupported = unsupportedFlag(positional[1], argv);
    if (unsupported) {
      stderr.write(`${unsupported}\n`);
      return 1;
    }
    const config = loadConfigFn(configLayers);
    // `signals.indexed`: the index changed even if the command did not end with 0 (an update that
    // applied some skills and left a conflict), so the daemon still has to catch up.
    const signals = {};
    const code = runSkills(positional.slice(1), {
      json,
      force,
      remote,
      check,
      dryRun,
      prune,
      acceptLicense,
      keepOverrides,
      sourceFilter,
      level: user ? "user" : local ? "local" : "project",
      cwd,
      config,
      stdout,
      stderr,
      env: deps.env ?? process.env,
      install: { ref, subdir, exclude, ...deps.install },
      kind,
      deps: deps.skills,
    }, signals);
    if (!dryRun && ["index", "install", "update", "remove"].includes(positional[1]) && (code === 0 || signals.indexed)) await refreshDaemon();
    // `--catalog`: the servers the installed skills ask for get their catalog entry, each one approved as `catalog build` always does.
    if (catalog && positional[1] === "install" && code === 0 && signals.servers?.size) {
      let catalogCode = 0;
      for (const server of signals.servers) {
        const built = await runCatalog(["build"], catalogContext({ serverFilter: server }));
        catalogCode = catalogCode || built;
      }
      return catalogCode;
    }
    return code;
  }

  if (positional[0] === "commands") {
    if (user && local) {
      stderr.write("toolgate commands: choose one of --user and --local\n");
      return 1;
    }
    const config = loadConfigFn(configLayers);
    // `signals.indexed`: the index changed even if the command did not end with 0 (an update that applied
    // some commands and left a conflict), so the daemon still has to catch up.
    const signals = {};
    // `bridge` covers the agents named, or the ones found on the PATH.
    let bridgeAgents;
    if (positional[1] === "bridge") {
      bridgeAgents = positional.length > 2
        ? positional.slice(2).map((name) => defaultRegistry.canonical(name))
        : (await detectAgents({ execFn: deps.bridge?.execFn ?? defaultExec })).map((agent) => agent.name);
    }
    const code = runCommands(positional.slice(1), {
      bridgeAgents,
      json,
      force,
      remote,
      check,
      dryRun,
      prune,
      acceptLicense,
      sourceFilter,
      level: user ? "user" : local ? "local" : "project",
      cwd,
      config,
      stdout,
      stderr,
      env: deps.env ?? process.env,
      install: { ref, subdir, exclude, dialect, ...deps.install },
      deps: deps.skills,
    }, signals);
    if (!dryRun && ["index", "install", "update", "import"].includes(positional[1]) && (code === 0 || signals.indexed)) await refreshDaemon();
    return code;
  }

  if (positional[0] === "subagents") {
    if (user && local) {
      stderr.write("toolgate subagents: choose one of --user and --local\n");
      return 1;
    }
    const signals = {};
    const code = runSubagents(positional.slice(1), {
      json,
      force,
      remote,
      check,
      dryRun,
      prune,
      acceptLicense,
      sourceFilter,
      level: user ? "user" : local ? "local" : "project",
      cwd,
      config: loadConfigFn(configLayers),
      stdout,
      stderr,
      env: deps.env ?? process.env,
      install: { ref, subdir, exclude, dialect, ...deps.install },
      deps: deps.skills,
    }, signals);
    if (!dryRun && ["index", "install", "update", "import"].includes(positional[1]) && (code === 0 || signals.indexed)) await refreshDaemon();
    return code;
  }

  if (positional[0] === "catalog") {
    return runCatalog(positional.slice(1), catalogContext({ serverFilter: serverName }));
  }
  if (positional[0] === "hooks") {
    if (user && local) {
      stderr.write("toolgate hooks: choose one of --user and --local\n");
      return 1;
    }
    return runHooks(positional.slice(1), {
      json,
      force,
      remote,
      check,
      dryRun,
      prune,
      sourceFilter,
      yes,
      effective,
      agent: initAgent,
      adapters: defaultRegistry,
      interactive: deps.hooks?.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ask: deps.hooks?.ask,
      level: user ? "user" : local ? "local" : "project",
      cwd,
      config: loadConfigFn(configLayers),
      stdout,
      stderr,
      env: deps.env ?? process.env,
      install: { ref, subdir, exclude, ...deps.install },
    });
  }

  if (positional[0] === "permissions") {
    if (user && local) {
      stderr.write("toolgate permissions: choose one of --user and --local\n");
      return 1;
    }
    return runPermissions(positional.slice(1), {
      json,
      force,
      remote,
      check,
      dryRun,
      prune,
      sourceFilter,
      yes,
      grant,
      effective,
      agent: initAgent,
      adapters: defaultRegistry,
      interactive: deps.hooks?.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ask: deps.hooks?.ask,
      level: user ? "user" : local ? "local" : "project",
      cwd,
      config: loadConfigFn(configLayers),
      stdout,
      stderr,
      env: deps.env ?? process.env,
      install: { ref, subdir, exclude, ...deps.install },
    });
  }

  if (positional[0] === "config") {
    return runConfig(positional.slice(1), { json, user, local, force, cwd, configLayers, stdout, stderr });
  }
  if (positional[0] === "daemon") {
    const env = deps.env ?? process.env;
    const daemon = deps.daemon ?? { status: daemonStatus, ensure: ensureDaemon, stop: stopDaemon, holder: (daemonPort) => portHolder(daemonPort, { env }) };
    // `toolgate daemon` always works on a local port: with a remote or disabled `router.qmdUrl` it falls back to the environment and `qmd.port`.
    let daemonConfig = {};
    try {
      daemonConfig = loadConfigFn(configLayers);
    } catch {
      // a config that cannot be read keeps `toolgate daemon` working with the environment and the default
    }
    const daemonPort = managedPort(daemonConfig, env, { flagPort: port }) ?? managedPort({ qmd: daemonConfig?.qmd }, env);
    return runDaemon(positional[1], { port: daemonPort, qmdBin: qmdBinOf(daemonConfig), env, stdout, stderr, daemon });
  }

  if (positional[0] === "doctor") {
    return runDoctor({
      cwd,
      env: deps.env ?? process.env,
      json,
      stdout,
      daemon: deps.daemon,
      fetchFn: deps.fetchFn,
      ...deps.doctor,
    });
  }

  if (positional[0] === "update") {
    return runUpdate({ cwd, env: deps.env ?? process.env, dryRun, yes, json, stdout, ...deps.update });
  }
  if (positional[0] === "route") {
    return runRoute(routePrompt, { backend, configLayers, adapter: adapterName, adapters, cwd, stdout, stderr, loadConfigFn, deps });
  }

  if (positional[0] === "need") {
    return runNeed(positional.slice(1).join(" "), {
      backend, json, configLayers, statePath, adapter: adapterName, adapters, cwd, stdout, stderr, loadConfigFn, loadStateFn, saveStateFn, deps,
    });
  }

  if (positional[0] === "tools") {
    return runTools(positional.slice(1), { json, env: deps.env ?? process.env, loadConfigFn, stdout, stderr });
  }

  if (positional[0] === "escalate") {
    return runEscalate(positional.slice(1), { statePath, stdout, stderr, loadStateFn, saveStateFn });
  }

  const config = loadConfigFn(configLayers);
  const agent = adapterName ?? config.defaultAgent;
  if (!agent) {
    stderr.write(
      'toolgate: no agent selected. Set "defaultAgent" in the user, project or local config, or pass --adapter <name>.\n',
    );
    return 1;
  }
  const known = toRegistry(adapters);
  if (!known.has(agent)) {
    stderr.write(`toolgate: unknown agent "${printable(agent)}"; run toolgate init --agent <one of ${known.names().join(", ")}>\n`);
    return 1;
  }
  const adapterModule = await resolveAdapter(agent, adapters);

  // The agent's own flags go to it whole, each with its value (`--resume <id>` is not a task); the first other word is the task.
  const { prompt, agentArgs } = adapterModule.agentCli
    ? splitLaunchArgs(forwarded, adapterModule.agentCli)
    : { prompt: positional.find((word) => !word.startsWith("-")), agentArgs: flagArgs };
  const state = loadStateFn(statePath);

  // With or without a prompt: `need` inside an interactive session queries the daemon too, so a launch that uses the qmd backend starts it when
  // it is down (the shared one, as `init` does), and `toolgate daemon stop` lasts only until the next launch.
  if (!noRoute) {
    await ensureQmdDaemon({
      config,
      backend,
      env: deps.env ?? process.env,
      stderr,
      ensureFn: deps.daemon?.ensure,
    });
  }
  const routing = noRoute
    ? { prompt, state }
    : await applyRouting({ prompt, config, state, backend, stderr });

  const applied = approvedForLaunch({ adapterModule, config, cwd, env: deps.env ?? process.env, stderr, copyUnits: deps.hookCopier });
  const mcpJsonPath = path.join(cwd, ".mcp.json");
  const session = sessionFor({ capability: adapterModule.capability, agent: known.canonical(agent), stderr, env: deps.env ?? process.env, projectDir: cwd, setIntervalFn: deps.setIntervalFn, clearIntervalFn: deps.clearIntervalFn });
  const sessionEnv = session.open(wrappedServers({ config, state: routing.state, prompt: routing.prompt, mcpJsonPath }));
  const stopWatching = session.watch();
  let result;
  try {
    result = await adapterModule.launch({
      prompt: routing.prompt,
      config,
      state: routing.state,
      mcpJsonPath,
      env: launchEnv(sessionEnv),
      projectDir: cwd,
      stderr,
      subagents: subagentsToRegister({ adapterModule, config, state: routing.state, routed: routing.routed, cwd, env: deps.env ?? process.env, stderr }),
      applied,
      // --yes takes the defaults, so a prompt runs without the agent's interface and its result is printed; --quiet does not print it.
      headless: yes && Boolean(prompt),
      quiet,
      agentArgs,
    });
  } catch (err) {
    // Escalations are consumed after the agent ends, so a launch that threw leaves them pending; say so.
    if (state.pendingRestart) stderr.write(keptEscalationsLine(launchFailure(undefined, err)));
    throw err;
  } finally {
    // Whatever happens to the agent, the copies of the hook scripts and the session file made for this launch go.
    stopWatching();
    applied.cleanup();
    // A launch that threw has no escalations to wait for.
    if (!result) session.close();
  }

  // The earlier escalations are consumed only when the agent started cleanly: a failed launch keeps them for the next one, and
  // its session file goes (the next launch makes its own).
  const failure = launchFailure(result);
  if (failure) {
    if (state.pendingRestart) stderr.write(keptEscalationsLine(failure));
    session.close();
    return result.code ?? 0;
  }
  // Only what this launch took is consumed: what the agent escalated during the session (or another process meanwhile) stays pending.
  if (state.pendingRestart) saveStateFn(statePath, withoutEscalations(currentState(loadStateFn, statePath, state), state));
  session.close({ pending: pendingRestart(loadStateFn, statePath) });

  return result.code ?? 0;
}

// How a launch failed, or undefined when the agent started cleanly: it threw, ended by a signal, or exited with a code other than 0.
function launchFailure(result, error) {
  if (error !== undefined) return printable(error instanceof Error ? error.message : String(error));
  const { code, signal } = result;
  if (signal) return `signal ${printable(signal)}`;
  if (code === null) return "signal unknown";
  return code === undefined || code === 0 ? undefined : `exit ${code}`;
}

const MAX_REASON = 300;
const shortReason = (err) => {
  const text = printable(err instanceof Error ? err.message : String(err));
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
};

/**
 * What toolgate prints when a command ends in an exception: for an error of the system (an agent that is not installed or not
 * executable: `code` ENOENT, EACCES…) only its reason, on one line; for anything else, a bug, the stack to debug it.
 */
export function failureText(err) {
  if (err instanceof Error && typeof err.code === "string" && /^E[A-Z0-9]+$/.test(err.code)) return `toolgate: ${shortReason(err)}\n`;
  // The stack keeps its lines; each one is escaped on its own.
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return `toolgate: ${text.split("\n").map(printable).join("\n")}\n`;
}

const keptEscalationsLine = (failure) => `toolgate: the agent did not start cleanly (${failure}); the pending escalations are kept for the next launch\n`;

const currentState = (loadStateFn, statePath, fallback) => {
  try {
    return loadStateFn(statePath);
  } catch {
    return fallback;
  }
};

// Gives back what a failed launch consumed, together with whatever is pending now (the agent may have escalated during the session):
// nothing is dropped. It never throws and never changes the exit code of the agent.
function restoreEscalations({ before, failure, statePath, loadStateFn, saveStateFn, stderr }) {
  const now = currentState(loadStateFn, statePath, undefined);
  try {
    saveStateFn(statePath, now ? mergeEscalations(now, before) : before);
  } catch (err) {
    stderr.write(`toolgate: the agent did not start cleanly (${failure}); the pending escalations could not be kept (${shortReason(err)}), they are lost for the next launch\n`);
    return;
  }
  stderr.write(keptEscalationsLine(failure));
}

// The approved hooks and the permissions this launch passes on (see `hooks/effective.js`), for an adapter that can take them
// through its settings; the copies of the hook scripts are made now and removed by `cleanup` when the agent ends.
function approvedForLaunch({ adapterModule, config, cwd, env, stderr, copyUnits = copyHookUnits }) {
  const none = { settings: {}, cleanup: () => {} };
  const plan = launchPlan({ adapterModule, config, cwd, env });
  if (!plan.applies) return none;
  if (plan.approvalsProblem) stderr.write(`toolgate: ${plan.approvalsProblem}\n`);
  if (plan.error) {
    stderr.write(`toolgate: hooks and permissions were not applied (${plan.error})\n`);
    return none;
  }
  const effective = plan.effective;
  for (const problem of effective.problems) stderr.write(`toolgate: not applied: ${problem}\n`);
  for (const kind of ["hook", "permission"]) {
    const waiting = effective.pending.filter((p) => p.kind === kind);
    if (waiting.length) stderr.write(`toolgate: ${waiting.length} ${kind}${waiting.length === 1 ? "" : "s"} not applied (${waiting.map((p) => `${p.name}: ${p.reason}`).join("; ")}); run \`toolgate ${kind}s review\`\n`);
  }
  if (plan.takesEnv) {
    // What opencode cannot express is said, deny rules above all: a deny that is not applied is a weaker launch than asked for.
    const { unmapped, note } = plan;
    if (note) stderr.write(`toolgate: ${note}\n`);
    if (unmapped.length) stderr.write(`toolgate: ${unmapped.length} permission ${unmapped.length === 1 ? "rule" : "rules"} cannot be applied in opencode: ${unmapped.map((u) => `${u.rule} [${u.list}]: ${u.reason}`).join("; ")}\n`);
    return { settings: {}, env: plan.env, cleanup: () => {} };
  }
  // The hook copies are made apart from the rules: a failure there never takes the deny and ask rules with it, and the copies
  // are removed if anything after them fails.
  let copies = { units: new Map(), skipped: [], cleanup: () => {} };
  try {
    copies = copyUnits(effective.hooks);
    for (const line of copies.skipped) stderr.write(`toolgate: hook not applied: ${line}\n`);
    return { settings: claudeSettingsFor(effective, copies.units), cleanup: copies.cleanup };
  } catch (err) {
    copies.cleanup();
    stderr.write(`toolgate: hooks were not applied (${err.message.split("\n")[0]})\n`);
    try {
      return { settings: claudeSettingsFor({ ...effective, hooks: [] }, new Map()), cleanup: () => {} };
    } catch (second) {
      stderr.write(`toolgate: permissions were not applied (${second.message.split("\n")[0]})\n`);
      return none;
    }
  }
}

// The subagents the adapter registers in this launch (see `activeSubagents`): none when the adapter cannot register
// them. A name that is not found in the sources is said, not guessed.
function subagentsToRegister({ adapterModule, config, state, routed, cwd, env, stderr }) {
  if (!["launchFlag", "projectDir"].includes(adapterModule.capability?.subagents?.kind)) return [];
  try {
    const { definitions, missing } = activeSubagents({ config, state, routed, cwd, env });
    if (missing.length) stderr.write(`toolgate: subagents not found in the sources, so not registered: ${missing.map((name) => printable(name)).join(", ")}\n`);
    return definitions;
  } catch (err) {
    stderr.write(`toolgate: subagents could not be read, so none is registered (${err.message.split("\n")[0]})\n`);
    return [];
  }
}
// `toolgate [flags] <agent> [agent args…]`: the agent's own arguments are forwarded untouched, with
// what toolgate generates added (for Claude, `--settings`). Subcommands of the agent run as-is.
const MAX_RESTARTS = 3;

async function runAgent({ before, agent, after }, ctx) {
  const { configLayers, statePath, cwd, stderr, adapters, deps, loadConfigFn, loadStateFn, saveStateFn } = ctx;
  const env = deps.env ?? process.env;
  const { backend, noRoute } = parseArgs(before, env);
  const registry = toRegistry(adapters);
  const adapterModule = await registry.get(agent);
  const spec = adapterModule.agentCli;
  if (!spec) {
    stderr.write(`toolgate: ${registry.canonical(agent)} cannot be wrapped yet (no argument passthrough)\n`);
    return 1;
  }
  const launchOptions = { mcpJsonPath: path.join(cwd, ".mcp.json"), resume: false };
  if (isSubcommand(after, spec)) {
    const result = await adapterModule.launch(after, { ...launchOptions, raw: true });
    return result.code ?? 0;
  }

  // The prompt only decides what to activate; the arguments themselves are never rewritten.
  const prompt = extractPrompt(after, spec);
  const maxRestarts = deps.maxRestarts ?? MAX_RESTARTS;
  const interactive = !after.some((arg) => (spec.nonInteractive ?? []).includes(arg));
  // The agent cannot restart itself: when the user ends the session with escalations pending,
  // relaunch it here with the new active set and continue the conversation.
  let args = after;
  let resume = false;
  let failed = false;
  // One session file for the servers toolgate-proxy wraps: kept by every relaunch, removed when the agent ends with nothing pending.
  const session = sessionFor({ capability: adapterModule.capability, agent: registry.canonical(agent), stderr, env, projectDir: cwd, setIntervalFn: deps.setIntervalFn, clearIntervalFn: deps.clearIntervalFn });
  try {
  for (let restarts = 0; ; restarts++) {
    const config = loadConfigFn(configLayers);
    const state = loadStateFn(statePath);
    // With or without a prompt, as the task path does: `need` inside an interactive session queries the daemon too. Not again on the relaunch
    // that resumes the conversation after an escalation (`resume` is that internal relaunch, never the user's own `--resume`): the first pass of
    // the same process already made sure of it.
    if (!noRoute && !resume) {
      await ensureQmdDaemon({ config, backend, env, stderr, ensureFn: deps.daemon?.ensure });
    }
    const routing = noRoute || resume ? { state } : await applyRouting({ prompt, config, state, backend, stderr });
    // Consumed before the launch: what the agent escalates during the session is kept for the next one.
    const consumed = state.pendingRestart ? consumeEscalations(state) : undefined;
    if (consumed) saveStateFn(statePath, consumed);
    const applied = approvedForLaunch({ adapterModule, config, cwd, env, stderr, copyUnits: deps.hookCopier });
    const sessionEnv = session.open(wrappedServers({ config, state: routing.state, prompt: resume ? undefined : prompt, mcpJsonPath: launchOptions.mcpJsonPath }));
    const stopWatching = session.watch();
    let result;
    try {
      result = await adapterModule.launch(args, {
        ...launchOptions,
        env: launchEnv(sessionEnv),
        applied,
        projectDir: cwd,
        stderr,
        subagents: subagentsToRegister({ adapterModule, config, state: routing.state, routed: routing.routed, cwd, env, stderr }),
        resume,
        prompt: resume ? undefined : prompt,
        config,
        state: routing.state,
      });
    } catch (err) {
      failed = true;
      if (consumed) restoreEscalations({ before: state, failure: launchFailure(undefined, err), statePath, loadStateFn, saveStateFn, stderr });
      throw err;
    } finally {
      stopWatching();
      applied.cleanup();
    }
    const code = result.code ?? 0;
    const failure = launchFailure(result);
    // What was consumed is idle, so anything pending now was escalated during the session.
    const escalatedDuring = pendingRestart(loadStateFn, statePath);
    if (failure) {
      // The agent did not start cleanly: what was consumed for it goes back, together with what the agent escalated.
      failed = true;
      if (consumed) restoreEscalations({ before: state, failure, statePath, loadStateFn, saveStateFn, stderr });
    }
    if (!escalatedDuring) return code;

    const resumeArg = adapterModule.capability?.resume?.arg;
    const canResume = adapterModule.supportsResume === true && code === 0 && interactive;
    if (!canResume || restarts >= maxRestarts) {
      const why = restarts >= maxRestarts ? `stopped after ${maxRestarts} restarts` : "will take effect on the next launch";
      const command = adapterModule.supportsResume ? `toolgate ${agent} ${resumeArg ?? ""}`.trim() : `toolgate ${agent}`;
      stderr.write(`toolgate: servers were escalated during the session (${why}); run \`${command}\` to apply them\n`);
      return code;
    }
    stderr.write("toolgate: servers were escalated; relaunching with the conversation resumed\n");
    // The first message was already sent; resuming must not send it again.
    args = prompt !== undefined && args[args.length - 1] === prompt ? args.slice(0, -1) : args;
    resume = true;
  }
  } finally {
    // A launch that failed keeps its escalations in the state, not in a session file nobody will resume.
    session.close({ pending: !failed && pendingRestart(loadStateFn, statePath) });
  }
}
// Whether the agent left a restart pending; a state file that cannot be read says no, so the session file is still removed.
function pendingRestart(loadStateFn, statePath) {
  try {
    return loadStateFn(statePath).pendingRestart === true;
  } catch {
    return false;
  }
}
// `toolgate daemon start|status|stop|restart [--port N]` manages the shared qmd http daemon.
// status exits 1 when it is not running; start exits 1 when it never answers.
async function runDaemon(action, { port, qmdBin, env, stdout, stderr, daemon }) {
  if (action === "status") {
    const status = await daemon.status({ port });
    // A process that answers on the port but is not the one qmd's pid file names was not started by toolgate.
    const holder = status.running && daemon.holder ? daemon.holder(port) : { pid: null, foreign: null };
    // The stamp of a daemon toolgate started counts only while its pid is the one holding the port.
    const stamp = status.running ? readStamp(port, { env }) : null;
    const own = stamp && stamp.pid === holder.pid ? ` (pid ${stamp.pid}, qmd ${stamp.version === null ? "unknown" : printable(stamp.version)}, started ${printable(stamp.startedAt)})` : "";
    const foreign = holder.foreign === true ? ` (pid ${holder.pid}, not started by toolgate)` : own;
    stdout.write(
      status.running
        ? `toolgate: qmd daemon running on ${status.url} (uptime ${status.uptime ?? "?"}s)${foreign}\n`
        : status.state === "hung"
          ? `toolgate: qmd daemon not answering on port ${port}\n`
          : `toolgate: qmd daemon not running on port ${port}\n`
    );
    return status.running ? 0 : 1;
  }

  if (action === "start") {
    const result = await daemon.ensure({ port, qmdBin, env, stderr, attempts: COLD_START_ATTEMPTS });
    if (!result.running) {
      stderr.write(`toolgate daemon: ${result.reason}\n`);
      return 1;
    }
    stdout.write(`toolgate: qmd daemon ${result.started ? "started" : "already running"} on ${result.url}\n`);
    return 0;
  }

  if (action === "restart") {
    const result = await restartDaemon({ port, qmdBin, env, stderr, stopFn: daemon.stop, ensureFn: daemon.ensure, statusFn: daemon.status, holderFn: daemon.holder, sleepFn: daemon.sleep });
    if (!result.running) {
      stderr.write(`toolgate daemon: ${result.reason}\n`);
      return 1;
    }
    stdout.write(`toolgate: qmd daemon restarted on ${result.url}\n`);
    return 0;
  }

  if (action === "stop") {
    const result = daemon.stop({ qmdBin, port, env });
    (result.ok ? stdout : stderr).write(`toolgate: ${result.message}\n`);
    return result.ok ? 0 : 1;
  }

  stderr.write("toolgate daemon: expected start, status, stop or restart\n");
  return 1;
}

const CONFIG_EDITS = new Set(["set", "unset", "add", "remove"]);

// `toolgate config set|unset <key> [<value>]` and `add|remove <key> <value>` edit one layer's file
// (the project's unless --user or --local is given); each prints what it did or that nothing changed.
function runConfigEdit(action, [key, ...values], { user, local, force, cwd, configLayers, stdout, stderr }) {
  const wantsValue = action !== "unset";
  if (user && local) {
    stderr.write("toolgate config: choose one of --user and --local\n");
    return 1;
  }
  if (!key || (wantsValue && values.length === 0) || values.length > (wantsValue ? 1 : 0)) {
    const usage = wantsValue ? `${action} <key> <value>` : "unset <key>";
    stderr.write(`toolgate config: usage: toolgate config ${usage} (quote a value that has spaces)\n`);
    return 1;
  }

  const layerName = user ? "user" : local ? "local" : "project";
  const layer = configLayers.find((candidate) => candidate.name === layerName);
  if (!layer) {
    stderr.write(`toolgate config: no ${layerName} layer to edit\n`);
    return 1;
  }
  // Only the project's file is versioned: a tracked one that is gone is restored, not recreated behind the user's back.
  if (layerName === "project" && !force && trackedAndMissing(layer.path)) {
    stderr.write(`toolgate config: ${restoreHint(layer.path, cwd)}\n`);
    return 1;
  }
  try {
    const { changed, created } = editConfigFile(layer.path, {
      action,
      key,
      value: wantsValue ? parseValueFor(key, action, values[0]) : undefined,
      layer: layerName,
    });
    const where = `${layerName} layer (${layer.path})`;
    stdout.write(`toolgate: ${changed ? `${created ? "created and " : ""}${action} ${key}` : `unchanged ${key}`} in the ${where}\n`);
    return 0;
  } catch (err) {
    stderr.write(`toolgate config: ${err.message}\n`);
    return 1;
  }
}

// `toolgate config print [--json]` dumps the resolved config and the layers each key came from.
function runConfig([action, ...rest], { json, user, local, force, cwd, configLayers, stdout, stderr }) {
  if (CONFIG_EDITS.has(action)) return runConfigEdit(action, rest, { user, local, force, cwd, configLayers, stdout, stderr });
  if (action !== "print") {
    stderr.write("toolgate config: expected print, set, unset, add or remove\n");
    return 1;
  }
  const { config, origins, shown, errors } = resolveConfig(configLayers);
  for (const { layer, path: file, message } of errors) {
    stderr.write(`toolgate config: ignoring ${layer} layer ${file}: ${message}\n`);
  }
  if (json) {
    stdout.write(`${JSON.stringify({ config, origins, layers: configLayers }, null, 2)}\n`);
    return 0;
  }
  const layers = configLayers.map(({ name, path: file }) => `# ${name}: ${file}`).join("\n");
  const keys = Object.entries(shown)
    .map(([key, from]) => `${key}\t${from.join(", ")}`)
    .join("\n");
  stdout.write(`${layers}\n${JSON.stringify(config, null, 2)}\n# origins\n${keys}\n`);
  return 0;
}

function runEscalate([server, tool], { statePath, stdout, stderr, loadStateFn, saveStateFn }) {
  if (!server) {
    stderr.write("toolgate escalate: a server name is required\n");
    return 1;
  }

  const state = loadStateFn(statePath);
  const next = tool
    ? {
        ...state,
        toolExtras: { ...state.toolExtras, [server]: [...new Set([...(state.toolExtras[server] ?? []), tool])] },
        pendingRestart: true,
      }
    : escalateServers(state, [server]);

  saveStateFn(statePath, next);
  stdout.write(`toolgate: escalated ${server}${tool ? `:${tool}` : ""}; it takes effect on the next launch (end the session, e.g. /exit, and toolgate <agent> relaunches it by itself)\n`);
  return 0;
}

// The installed-server check is optional: if it fails, routing still runs and reports nothing missing.
async function lookupInstalled(agent, { adapters, cwd }) {
  try {
    const module = await resolveAdapter(agent, adapters);
    return { module, installed: module.installedServers?.({ cwd }) ?? null };
  } catch {
    return { module: null, installed: null };
  }
}

// The command called `name` in the configured commands sources (project, user and local levels), or null.
function commandLookup(config, cwd, env) {
  return (name) => scanCommands(settings(config, cwd, env).commandSources).find((command) => command.name === name) ?? null;
}
// Shared by `route` and `need`: load the config, check what the agent has configured and route the
// task. A routing failure is reported on stderr under `command` and returns null.
// The catalog for `route`. It is matched by words only: the score the qmd daemon gives is the rank of the document, not a
// relevance, so a search by meaning through it admits irrelevant servers (#157). `route` keeps the `catalogSearch` seam for
// a search that has a real similarity.
function catalogRouting({ config, cwd, homedir }) {
  return { catalog: catalogForRoute({ config, cwd, homedir }) };
}
async function routeTask(command, task, { backend, configLayers, adapter, adapters, cwd, stderr, loadConfigFn, deps }, extra = {}) {
  const config = loadConfigFn(configLayers);
  const agent = adapter ?? config.defaultAgent;
  const { module, installed } = await lookupInstalled(agent, { adapters, cwd });
  try {
    const routed = await route(task, config, { backend, installed, ...catalogRouting({ config, cwd, homedir: deps?.catalog?.homedir }), commandByName: commandLookup(config, cwd, deps?.env ?? process.env), ...extra });
    return { agent, module, routed };
  } catch (err) {
    stderr.write(`toolgate ${command}: ${err.message}\n`);
    return null;
  }
}

async function runRoute(prompt, ctx) {
  if (!prompt) {
    ctx.stderr.write("toolgate route: --prompt is required\n");
    return 1;
  }
  const found = await routeTask("route", prompt, ctx);
  if (!found) return 1;
  // The description of a card is for `need`'s excerpt: `route --json` keeps the shape it had.
  const withoutDescription = (matches) => matches?.map(({ description, ...rest }) => rest);
  const { skills, commands, subagents } = found.routed;
  const shown = { ...found.routed, skills: withoutDescription(skills), commands: withoutDescription(commands), subagents: withoutDescription(subagents) };
  ctx.stdout.write(`${jsonSafe(JSON.stringify(shown, null, 2))}\n`);
  return 0;
}

// `toolgate need "<task>" [--json]`: route the task, then report each server's status and record
// the ones that need a relaunch as escalations. Servers the agent lacks are only reported.
// The toolgate session this `need` runs in, when TOOLGATE_SESSION_STATE names a trusted session file of this user; otherwise null, and `need`
// is what it was before sessions (a value that is not a session file is ignored, as is a file that cannot be trusted).
function needSession({ deps, cwd, configLayers, loadConfigFn }) {
  const env = deps.env ?? process.env;
  const file = env.TOOLGATE_SESSION_STATE;
  if (!file || !isSessionFile(file, { env })) return { session: null, warning: null };
  const inspected = inspectSession(file, { env });
  // A session file that is there by name but cannot be used (not private, not readable, not valid): said, and `need` goes on as without one.
  if (inspected.refused) return { session: null, warning: inspected.refused.replace(/^toolgate: /, "") };
  return { warning: null, session: {
    state: inspected.state,
    // The names of the tools the server's card knows, looked up in the project the session was launched for.
    cardTools(server) {
      try {
        const projectDir = inspected.state.projectDir ?? cwd;
        let config = {};
        try {
          config = loadConfigFn(configLayerPaths({ cwd: projectDir, env }));
        } catch {
          // a config that cannot be read means the default catalog folder
        }
        return (readCatalog(config, projectDir).servers.get(server)?.tools ?? []).map((tool) => tool.name);
      } catch {
        return [];
      }
    },
    instructionsOf: (server) => readInstructions(file, server, { env }),
    update: (change) => updateSession(file, change, { env }),
  } };
}
async function runNeed(task, ctx) {
  const { json, statePath, stdout, stderr, loadStateFn, saveStateFn } = ctx;
  if (!task) {
    stderr.write('toolgate need: a task is required, e.g. toolgate need "open a pull request"\n');
    return 1;
  }
  // The session first: the servers it lists are the ones whose catalog card is matched against the task, whether or not they were chosen.
  const { session, warning: sessionWarning } = needSession(ctx);
  const found = await routeTask("need", task, ctx, { activeServers: session ? Object.keys(session.state.servers) : [] });
  if (!found) return 1;
  // The agent to name when a relaunch is needed: the one of this session, then --adapter, then defaultAgent.
  const agent = session?.state.agent ?? found.agent;
  const { result, state } = resolveNeed(found.routed, { state: loadStateFn(statePath), agent, adapter: found.module, session, sessionWarning });
  if (state) saveStateFn(statePath, state);

  stdout.write(json ? `${jsonSafe(JSON.stringify(result, null, 2))}\n` : formatNeed(result));
  return 0;
}
