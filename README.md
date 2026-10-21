# toolgate

> A gate in front of your agent's context: only what the task needs passes through.

**Keep an agent's initial context small. Skills, MCP servers and tools are found and activated when a task
needs them, not loaded up front.**

## The problem
<!-- #region problem -->

Agent CLIs load a lot before the agent has done anything. MCP clients put the schemas of **every tool** of
**every enabled server** in context at session start, and keep them there for the whole session: a single
large server can cost thousands of tokens, a handful tens of thousands per request. Installed skills,
commands and subagents do the same with their descriptions, whether or not the task uses them. The result is
less usable context, higher cost and, past a certain count, worse tool selection.

Most agent CLIs only offer a manual, coarse on/off per server. There is no built-in way to say "load only
these 8 tools of this 47-tool server", or "find the skill this task needs instead of installing all of
them".

<!-- #endregion problem -->
## What toolgate does
<!-- #region what -->

toolgate adds **progressive disclosure** at three levels:

1. **Skills on demand.** Skills live in your project (`.toolgate/skills/`), are indexed by
   [QMD](https://github.com/tobi/qmd) and are **not** installed into the agent. A rule tells the agent to ask
   `toolgate route` before each task; it gets back the one skill that fits, with its path, and reads only
   that. The cost in context is one short rule, however many skills exist.
2. **Servers on demand.** Each session starts from a minimal _baseline_ of MCP servers. More are activated by
   keywords in the task, by the servers a skill declares it needs, or explicitly on the next restart. A
   server the task needs but the agent has not configured is reported, and the agent asks you before
   installing anything.
3. **Tools on demand.** Heavy servers can be served through a transparent proxy that trims each server's
   advertised tool list to a curated subset. Unlisted tools are not loaded; pull one in when you need it.

The mental model is lazy loading: **start with the minimum, escalate on demand.**

```text
you ── "add OpenTelemetry tracing" ──► agent
                                         │  Step 0 rule: toolgate route --prompt "<task>"
                                         ▼
                    skill:  observability-and-instrumentation  (path to its SKILL.md)
                    servers needed / missing, warnings
                                         │
                       the agent reads that one skill and follows it
```

<!-- #endregion what -->
## Quickstart
<!-- #region quickstart -->

```bash
git clone https://github.com/jorgecasar/toolgate.git
cd toolgate && npm install && npm install -g ./packages/toolgate

cd your-project
toolgate init                                 # config, Step 0 rule, .gitignore, daemon
toolgate skills install github:addyosmani/agent-skills --exclude using-agent-skills
toolgate route --prompt "I want to do TDD for the discount function"
```

Then open Claude Code in the project and give it a task.
<!-- #endregion quickstart -->
The full walkthrough, with the output of each step, is in [`docs/getting-started.md`](docs/getting-started.md).

## Commands

| Command | What it does |
| --- | --- |
| `toolgate init` | Sets a project up: config, the Step 0 rule, `.gitignore`, the daemon and the index. Safe to repeat. |
| `toolgate doctor` [`--json`] | Diagnoses the setup (agents, qmd and its daemon, config, the Step 0 rule, MCP servers, skills). Exits 1 on errors; warnings do not. |
| `toolgate route --prompt "<task>"` | Returns the skills and MCP servers the task needs, the ones the agent lacks, and warnings. |
| `toolgate skills recommended` | Lists the recommended skill sources (pinned to a commit, see [`docs/recommended-skills.md`](docs/recommended-skills.md)); installs nothing. |
| `toolgate skills install <source>` | Copies the skills of a git repository into `.toolgate/skills/`, pins them in a lock and indexes them. |
| `toolgate skills install recommended:<id>` | Installs a recommended source at its pinned, reviewed commit. |
| `toolgate skills update [name...] [--source <spec>] [--dry-run] [--force] [--prune]` | Moves installed skills to the current upstream; edited copies are kept unless `--force`; new upstream skills are only listed. |
| `toolgate skills remove <name...> [--force] [--dry-run]` | Deletes only what toolgate installed, with its lock entry, license and override. |
| `toolgate skills status [--remote] [--check]` | Per skill: level, origin, `ok` / `edited` / `missing` / `unlocked`, shadowing and overrides. `--remote` asks upstream whether it moved; `--check` exits 1 on drift (2 when upstream could not be asked). |
| `toolgate skills index` / `search "<text>"` | Rebuilds the index; finds skills by keywords and meaning. |
| `toolgate config print` / `set` / `add` / `remove` / `unset` | Shows the layered config and which layer each key comes from; edits it safely. |
| `toolgate daemon start` / `status` / `stop` / `restart` | Manages the shared QMD daemon. |
| `toolgate need "<task>"` [`--json`] | The in-session resolver: skills to read and each MCP server as `available`, `restart-required` (recorded as an escalation, with the tools the catalog matched), the ones the agent lacks (`missing`), warnings, and how to restart. Inside a session toolgate launched, a server behind `toolgate-proxy` that is active, always on or not, gets `revealed` (the tools its catalog card matched are offered now, no restart; the first time, its `instructions` too), or, when the router chose it and nothing matched, `dormant` (`available` and a `hint` say how to enable a tool). |
| `toolgate escalate <server> [tool]` | Marks a server (or one tool) to be present at the next launch. |
| `toolgate tools enable\|disable\|status\|reset` | Inside a session toolgate launched: which tools of a server behind `toolgate-proxy` the agent is offered, without a restart. |
| `toolgate --adapter <agent> "<task>"` | Launches the agent with the computed active set of servers. |

Configuration is layered (user, project, local) and every command above that changes it is idempotent.

## Supported agents

| Agent CLI | Tool filtering (proxy) | Server activation (launcher) | Step 0 rule written by `init` |
| --- | --- | --- | --- |
| Claude Code | ✅ universal | ✅ adapter (`--settings`) | ✅ |
| Codex CLI | ✅ universal | ✅ adapter (`config.toml` / `-c`) | not yet |
| Antigravity CLI | ✅ universal | ✅ adapter (config file) | not yet |
| Any MCP client with `command`-based servers | ✅ universal | ⚠️ adapter needed | n/a |

The proxy works wherever the client lets you define a server's `command`, `args` and `env`. Server-level
activation needs a small adapter because each CLI applies "which servers are active" differently. See
[`docs/ADAPTERS.md`](docs/ADAPTERS.md).

## The proxy

`toolgate-proxy` is a tiny, dependency-free stdio process that sits in front of an MCP server and filters its
`tools/list`. It is protocol-level and client-agnostic: point a server's launch command at it and put the real
server in `TOOLGATE_UPSTREAM_CMD` and `TOOLGATE_UPSTREAM_ARGS`, with the allowed tools in the config's `toolBaselines`. A tool
that is filtered out is brought back with `toolgate escalate <server> <tool>` and a restart.

## Documentation

- [`docs/getting-started.md`](docs/getting-started.md): from an empty project to a working setup.
- [`docs/qmd-integration.md`](docs/qmd-integration.md): the daemon, the skills index and how skills are found.
- [`docs/DESIGN.md`](docs/DESIGN.md): architecture, proxy contract, config schema, security.
- [`docs/ADAPTERS.md`](docs/ADAPTERS.md): per-agent integration and how to add one.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): what is next, and honest risks.

## Status

Early and in active development. It is not published to npm yet; install it from a clone as above. The skills
router, `init`, `doctor`, the config commands, remote skill installation and the daemon are working and tested; the
Step 0 rule is written for Claude Code only. Per-skill overrides (`skills.overrides`, see [`docs/DESIGN.md`](docs/DESIGN.md)), skill recommendations, `skills status`, `update` and `remove` are in.

## Working on toolgate
This repository uses toolgate itself. Its sources are committed (`rulesync.jsonc`, `.rulesync/`, `.toolgate/config.json`,
the skills and their lock); what they generate for your agent (`CLAUDE.md`, `.claude/`, `.mcp.json`) is not. After cloning:
```bash
npm install         # also runs `npm run setup`: rulesync generate, then toolgate init (Step 0 rule, /toolgate command, local config, daemon, index)
```
`npm install` ends by running the setup (`scripts/postinstall.sh`), and asks its questions in your terminal. The setup writes to your
real home and can start the qmd daemon, so the install runs it only in an interactive install of the main checkout. It prints
`toolgate setup skipped (<reason>); run npm run setup to do it` and goes on, in these four cases, checked in this order:
`CI` (the `CI` variable is set), `TOOLGATE_SKIP_SETUP` (that variable is set), `git worktree` (a linked git worktree) and
`not interactive` (stdin or stdout is not a terminal, as when an agent or a script runs `npm ci`). `npm run setup` always runs it,
to do it after a skipped install or after pulling changes to `.rulesync/`; if the setup fails during the install, the install still succeeds.
`npm install` brings qmd with toolgate (it needs Node 22 or newer). When there is none, `init` asks to install it
(`npm install -g @tobilu/qmd`); answer yes, or skills are searched by keywords only. With qmd, `init` starts the daemon
and indexes the skills into this project's qmd collection; `toolgate doctor` checks both. The agent runs `toolgate` from its own shell, so it must be on your PATH: `setup` ends by telling you whether it is, and if not, `npm install -g ./packages/toolgate` puts it there. The first run is slow: qmd downloads its models (about 300 MB) and embeds the skills, so it can take several minutes; later runs only index what changed. Run it with `npm run setup`, not `toolgate init` alone: `rulesync` is a project dependency that only `npm run` puts on the PATH. `rulesync generate` runs first
because it deletes files in `.claude/` that no rule owns, `/toolgate` included. 

`npm install` ends with an `npm audit` notice (13 vulnerabilities at the time of writing). They are in the dependencies
of qmd (`simple-git` via `node-llama-cpp`) and of rulesync (`braces`, `micromatch`, `fast-glob`, `globby`,
`gray-matter`), tools that run on your machine, not in toolgate's own code. Upstream has no patched version yet, and
`npm audit fix --force` would downgrade rulesync, so they are left as they are. `allowScripts` in `package.json` denies
the install scripts of qmd's native packages: they ship prebuilt binaries and do not need to compile.
## Tests

```bash
npm test             # every package
npm run lint
npm run test:e2e     # the proxy loop end to end: filter, escalate, restart, fail-open
npm run check:qmd-index  # proves two runs of the suite leave your qmd collections alone; needs a real qmd on PATH, not run in CI
```

## License

MIT, see [`LICENSE`](LICENSE). The
skills you install keep their own license: toolgate copies each source's `LICENSE` next to them.
