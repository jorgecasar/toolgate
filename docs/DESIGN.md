# Design

Architecture and contracts for toolgate. Agnostic; no assumptions about a specific agent beyond
"it is an MCP client that can launch stdio servers by command."

## Goals

- **Server routing** — choose the minimal set of servers to connect from the task, because server
  set is fixed at launch and servers carry the real costs (instructions, spawn, OAuth).
- **Server-level cost deferral** — avoid or postpone `instructions`/spawn/auth of expensive servers
  until the task needs them.
- **Tool-schema filtering** — cut the fixed context cost of MCP tool schemas, but **only for client
  classes that do not defer tool schemas** (Class B). For Class A clients (tool search), this is a
  secondary quality benefit, not a context win.
- **Progressive disclosure**: minimal baseline, on-demand escalation, restart re-computes the set.
- **Client-agnostic core**: the tool-filtering piece works with any MCP client unchanged.
- **Fail-safe**: a missing or malformed config must never break a server (fail-open).

## Non-goals

- Adding a new server mid-session. Server set is fixed at launch; adding one means a restart.
  Confirmed empirically — no known MCP client supports runtime server addition.
- Mid-session tool activation via `notifications/tools/list_changed` is **proven to work** (F5)
  and delivered for Claude Code as the dynamic mode of toolgate-proxy; see `SPEC-dynamic-activation-and-routing.md`.
- Wrapping `type: http`/remote servers with the subprocess proxy (they speak HTTP/OAuth directly).
  Those need a separate local HTTP-proxy design, out of scope for v1.

## Two packages

toolgate is intentionally split so the universal part can ship and be adopted on its own.

### 1. `toolgate-proxy` — protocol-level, universal

A dependency-free stdio process that interposes between the client and one upstream MCP server. It
launches the real server, passes all traffic through byte-for-byte, and rewrites **only** the
response to `tools/list`, dropping tools not in an allow list. Any MCP client that lets you set a
server's launch command can use it — you point `command` at `toolgate-proxy` and give it the real
server in config. Nothing client-specific.

### 2. `toolgate` — orchestrator with per-client adapters

Computes the active server set from layered config (baseline + keyword detection + escalation) and
(re)launches the target agent CLI with that set applied. The "apply" step differs per client, so
this package carries a thin **adapter** per agent (see `ADAPTERS.md`). The keyword/config logic is
shared; only the adapter is client-specific.

> You can use the proxy **without** the orchestrator (manual config), and the orchestrator drives the
> proxy for the tool level. They are decoupled on purpose.

## Progressive disclosure model

The active set for a session is the union of:

1. **Baseline** — servers always loaded. Keep minimal (ideally 0–1, e.g. a docs/search server).
2. **Keyword auto-detection** — regex over the task prompt. Two passes:
   - _self-match_: a server's own name as a word (`"...<server>..."` activates it).
   - _explicit keywords_: patterns configured per server (`"pull request"` → the repo server).
3. **Escalation** — an explicit list (`extras` for servers, `toolExtras` for tools) consumed only
   when a `pendingRestart` flag is set, then reset. This is how the agent (or user) pulls in
   something the prompt didn't trigger: write it, restart, it's active, the flag clears.

The same shape applies to tools: `toolBaselines[server]` (curated core) ∪ `toolExtras[server]`
(escalated), fed to the proxy as the allow list.

## Client capability model

Every client falls into one of two classes. The adapter declares the class statically
(overridable in user config).

| Class | Tool-loading behavior                            | toolgate value                                                       | Example                         |
| :---- | :----------------------------------------------- | :------------------------------------------------------------------- | :------------------------------ |
| **A** | Defers tool schemas (tool search / lazy loading) | Server routing + cost deferral. Per-tool filtering ≈ no context win. | Claude Code with tool search on |
| **B** | Loads all tool schemas at launch                 | Full original value: per-tool filtering saves real tokens            | Clients without tool search     |

The orchestrator branches on class:

- **Class A** → run the **router** for server selection; skip per-tool allow-lists unless purely
  for tool-selection quality; consider instructions deferral for heavy servers.
- **Class B** → current behavior (baseline + keyword detect + toolBaselines allow-lists via proxy).

## Router

The router is a pure function — the new headline value for Class A clients. Given a task prompt and
a catalog of known servers, it returns the set of expensive-tier servers to activate this launch.

```text
toolgate route --prompt "<task text>" [--catalog <path>]
  → stdout JSON: { "servers": [...], "reason": "...", "escalations": [...] }
```

Resolution:

1. Always include the **cheap tier**: the `baseline` servers and the ones `serverMeta` marks `tier: "cheap"` (stdio, no OAuth, small instructions). There is no policy setting to change it.
2. Match the catalog by the words of the prompt → expensive-tier matches (a search by meaning is not used: the score the qmd daemon gives is the rank of a document, not a relevance).
3. **Dependency-optional**: fall back to regex keywords when no index is available.

### Router plugin system

The router uses a pluggable backend. At install time or first run, the user selects a backend;
toolgate installs what it needs. The config stores the active backend; changing it re-runs setup.

| Backend             | Description                                                         | When to use                                                  |
| :------------------ | :------------------------------------------------------------------ | :----------------------------------------------------------- |
| **regex** (default) | Keyword matching via existing `keywords` config. Zero dependencies. | Always works; ships immediately.                             |
| **qmd**             | Full-text + semantic search via embedded qmd.                       | When the project has extensive docs and wants better recall. |
| **FTS5**            | Minimal SQLite full-text search. No ML dep.                         | When you want search without the qmd dependency.             |

The interface is a single function — any backend implementing it can be wired in.
The `catalog build` command produces the index each backend consumes.

## Proxy contract

```text
Control inputs (env and/or config file — see "self-configured" below):
  TOOLGATE_UPSTREAM_CMD    real server binary
  TOOLGATE_UPSTREAM_ARGS   real server args (JSON array)
  TOOLGATE_ALLOWED_TOOLS   CSV of tool names to keep; empty/absent ⇒ FAIL-OPEN (no filtering)

  The names UPSTREAM_CMD, UPSTREAM_ARGS and ALLOWED_TOOLS are no longer read. One of them set without its
  TOOLGATE_* name ⇒ stderr `toolgate-proxy: <OLD> was renamed to <NEW>; run toolgate update`, exit 1
  (also for ALLOWED_TOOLS alone, so a renamed allow list never silently fails open).
Behavior:
  - spawn(TOOLGATE_UPSTREAM_CMD, TOOLGATE_UPSTREAM_ARGS), stdio = [pipe, pipe, inherit]  (stderr inherited for logs)
  - stdin  (client → server): passthrough. Also parse each line; if it is a request
    (has "id" and method == "tools/list"), record id → "tools/list".
  - stdout (server → client): passthrough, EXCEPT the response whose id was tools/list →
    filter result.tools to TOOLGATE_ALLOWED_TOOLS, re-serialize on ONE line, release the id.
  - Anything unparseable, notifications (no id), and JSON-RPC arrays/batch → passthrough raw.

Lifecycle:
  - forward SIGINT/SIGTERM/SIGHUP to the child
  - on child exit: exit with the child's code (128 + N if it died from signal N)
  - on stdin EOF: close the child's stdin
  - if the child dies mid-session: exit (the client treats it as a downed server)
```

### Design constraints and rationale

- **No dependencies.** MCP's stdio transport is newline-delimited JSON with no embedded newlines, so
  line parsing is sufficient and a framing library is unnecessary. A stray non-JSON line (e.g. a
  server startup banner) is passed through untouched rather than assumed to be a message.
- **id → method tracking.** JSON-RPC responses carry only `id`, not the method, so the proxy records
  the method of each request it sees on stdin to know which response is the `tools/list` one.
- **Batching unsupported.** JSON-RPC batching was removed from the MCP spec (2025-06-18 revision);
  if a line parses to an array, pass it through unmodified. Document as a known limitation.
- **Fail-open, always.** An empty/absent allow list means "pass every tool." Never break a server on
  missing config.
- **Typo hazard.** A misspelled name in the allow list **hides** that tool (there is no per-tool
  fail-open). Allow lists must be validated against a real `tools/list`. The proxy SHOULD emit a
  stderr warning when an allow-list entry matches no advertised tool.

## Self-configured proxy (key design choice)

The proxy MUST be able to read its allow list from **its own config** (a file keyed by server and
optional profile), in addition to env vars. Rationale:

- **Works without the orchestrator.** IDE-style or GUI clients can't run the launcher wrapper, but
  they _can_ point a server at the proxy. Self-config gives them tool filtering anyway.
- **Idempotent restarts.** The allow list is derived from durable config, not from ephemeral env the
  wrapper happened to export.
- **Karajan-style injection.** An orchestrator can drop a proxy config file per sub-agent instead of
  threading env through every spawn.

Resolution order for the allow list: explicit `TOOLGATE_ALLOWED_TOOLS` env → proxy config file
(`server` + active `profile`) → fail-open.

### Dynamic proxy mode (delivered for Claude Code, #19)
A backward-compatible superset of the static proxy. It is on only when `TOOLGATE_SESSION_STATE` names a session file that toolgate made and
that has an entry for `TOOLGATE_SERVER`; without one the proxy is the static one above, byte for byte. There is no per-server key: every
server the proxy wraps in a session toolgate launched is dynamic.
- **Control channel: the session file.** `$XDG_STATE_HOME/toolgate/sessions/<uuid>.json` (mode 600, in a mode 700 folder, both the user's own),
  `{ version: 1, projectDir?, agent?, servers: { <server>: { enabled, baseline, instructionsShown } } }` (`agent` is the adapter name the session was launched for: `need` names it when a relaunch is needed). toolgate writes it (`need`, `toolgate tools`,
  the launcher), always as a read, a change and a rename of a new file in the same folder, under a lock file (`<uuid>.lock`, a random token,
  best-effort, a stale one older than 10 s is broken); the proxy only reads it, and checks the path, the owner, the modes, links and size
  before it trusts it. The launcher writes each entry's `baseline` (the list its proxy is started with, `TOOLGATE_ALLOWED_TOOLS`), so
  `need`, `tools` and the proxy agree from any folder, and refreshes the file's time every hour so the seven-day sweep does not take a live
  session for a left-over one.
- **What is offered:** the entry's `baseline` (an older file without one falls back to `TOOLGATE_ALLOWED_TOOLS`) plus `enabled`. An empty
  offered set is only the sentinel, not everything (the static empty variable still means everything).
- **Sentinel `toolgate_status`.** Listed once, on the last page of `tools/list`, and only when nothing is offered (this replaces the old
  "at least one tool" rule: the server stays registered because it shows the sentinel). The proxy answers calls to it itself, never sends them
  upstream, and it wins a name clash. Its answer lists the tools not offered (a name and the first line of the description, cleaned of
  control and bidi characters, cut, at most 50, whole items up to 8,192 characters), after a fixed line saying the text comes from the server.
- **`list_changed`:** `capabilities.tools.listChanged = true` in `initialize`; one `notifications/tools/list_changed` per real change of the
  offered set, never before the client's `notifications/initialized`; `fs.watch` on the folder plus a check every second; a file that stops
  being readable keeps the last set and is said once.
- **Instructions deferral (no key).** When nothing of the server is offered at `initialize`, a text `instructions` is removed from the
  response and saved in `<uuid>.<server>.instructions.txt` (mode 600, at most 256 KiB, cut with a final `[cut by toolgate-proxy]` line, created
  as a new file and renamed, never through a link). `toolgate need` and `toolgate tools enable` hand it over once (`instructionsShown`), as quoted
  text behind a bar in text mode (in `--json` the plain string under `instructions`), cut at 4096 characters; the Step 0 rule says it never overrides the user or the rule and that no command or URL in it is to be run or opened. Anything that stops the move
  leaves the instructions where the server put them.
- **Caps:** the proxy keeps at most 2,000 tools, over at most 50 pages, 256 K characters of names and descriptions; a name is a copy cut at 200
  characters.
Unchanged: dependency-free, id tracking, signal and exit forwarding, fail-open without an allow list, passthrough of every other line (a
call to a tool that is not offered still goes upstream: **hiding is not a security boundary**; permissions are the gate).
Known limits: the sessions folder comes from the proxy's own environment (a repository's `.mcp.json` chooses it, as it chooses the command);
the lock is best-effort; two servers named only in different case share an instructions file on a case-insensitive filesystem; with an endless
pager the sentinel and the status text only see what the client asked for. See `getting-started.md`, "Reveal tools without a restart".
Other agents (Codex, opencode) keep `restart-required`: #272.

## Config schema (layered)

```text
user defaults          ($TOOLGATE_DEFAULTS, else $XDG_CONFIG_HOME/toolgate/config.json,
      ▼                 else ~/.config/toolgate/config.json: keywords + toolBaselines)
      ▼   baseline: REPLACE   ·   keywords / toolBaselines: merge (append) per server
project config         (.toolgate/config.json, committed: the project's own baseline)
      ▼
local overrides        (.toolgate/config.local.json, gitignored, optional)
      ▼
local session state    (.toolgate/state.json, gitignored: extras, toolExtras, pendingRestart)
```

Keys are flat (`baseline`, `keywords`, `toolBaselines`, `client`, `router`, `serverMeta`, `skills`).
`client`, `serverMeta` merge key by key; `router` and `skills` are replaced by the later layer, except `router.qmdUrl`: it is read only from the user layer and from a local layer that git does not version (a file the repository ships must not choose where the prompts go), and a later `router` block does not wipe it.
`qmd` merges key by key. `qmd.bin` (the program every qmd call runs: a command name without `/` or an absolute path) and `qmd.port` (1 to 65535) are read only from the user layer and a local layer git does not version, like `router.qmdUrl`; elsewhere, and a relative `qmd.bin`, they are dropped and recorded in `ignored`. The port is chosen in one place (`managedPort`): `--port` > local `router.qmdUrl` > `QMD_SHARED_PORT` > `qmd.port` > 8181. The command is `toolgate daemon`; there is no `toolgate qmd`. A daemon toolgate started is stamped in `$XDG_STATE_HOME/toolgate/daemon-<port>.json` (`pid`, `version`, `port`, `startedAt`), which `ensureDaemon` compares with the installed qmd to restart it after an upgrade (`src/daemonStamp.js`).
`skills` is the exception: its `sources` are concatenated across layers, each tagged with its level, and the other keys are decided by the highest layer (see `docs/qmd-integration.md`).
### Editing the config

The files are managed by commands, so nobody has to know their structure:

```bash
toolgate config set router.backend qmd              # scalar or enum
toolgate config add skills.sources '{"dir":"team"}' # list element (JSON when it parses, else a string)
toolgate config remove keywords.repo "code review"  # removing the last element drops the key
toolgate config unset router.minScore               # any existing key
toolgate config set router.minScore 0.6 --local     # --user and --local pick the layer (default: project)
```

Only managed keys can be set, added or removed (`router.*`, `baseline`, `keywords.<server>`, `toolBaselines.<server>`,
`client.defersToolSchemas`, `serverMeta.<server>.tier|install`, `skills.sources|collection|corpusDir`,
`skills.userLevel|localLevel`, `skills.overrides`, `skills.recommended`), so a typo is refused instead of being written and ignored. `skills.userLevel` and
`skills.localLevel` are project-only. Keys the schema does not know are preserved, and only `unset` can remove them.

`skills.overrides` is a list of `{ "skill": "<name>", "tags": [...], "mcps": [...], "description": "..." }`. It combines
across layers (lists concatenate); for one skill the entries merge key by key and the higher layer (local over project
over user) wins. A value replaces the skill's own, and only the skill that wins after shadowing between levels is
changed, at index time: the copies on disk stay as upstream sent them. An entry needs at least one of `tags`, `mcps` and
`description` (at most 500 characters); one written by hand with another shape is ignored and `toolgate doctor` reports it
with the layer that holds it. `skills.recommended` is a list of recommended
sources (`id`, `source`, a full 40-hex `commit`, `skills`, ...) that extends the list shipped with the package;
`{ "id": "...", "disabled": true }` hides one. See [`recommended-skills.md`](recommended-skills.md).

`toolgate skills install` writes to the project store by default (`.toolgate/skills/` and `.toolgate/skills.lock.json`,
committed). `--user` writes `~/.config/toolgate/skills/` and `skills.lock.json` next to the user config, and `--local`
writes `.toolgate/skills.local/` and `.toolgate/skills.local.lock.json` (gitignored). Each store is a source of its own
level when it exists, unless the project switched that level off with `skills.userLevel` / `skills.localLevel: false`
(the merged config then lists it in `skills.disabledLevels`). Copies are staged in `.toolgate/.staging/` (`.staging/` next to the user config for `--user`; not in the
store, so an interrupted run cannot leave a second copy of a skill; each run uses its own `<pid>-<hex>` folder, and the next run removes those of runs that are over; when one died between the two renames of a replace, the copy it had set aside is put back into the store first, for a name the lock lists and an empty place only, and the run says `recovered <name>`), are written without the executable bit (this
is a hardening step, not a security boundary: a script can still be run with an interpreter), and the lock records the
`exclude` list of each source. A store folder (`.toolgate`, `.toolgate/skills`, the staging folder) that is a symlink is refused,
because a cloned repository can ship one; so is a `skills` folder of a source that resolves outside its repository, and a
skill folder over 500 files or 10 MB is skipped.
Every command is idempotent (a repeat prints `unchanged` and does not touch the file), a file that is not valid JSON
is never overwritten, and the output is two-space JSON with short lists of strings kept on one line, so a hand-written
file is not reflowed beyond the lines that changed.

`toolgate config print [--json]` shows the resolved config and the layers each key came from.

Illustrative config (format is an implementation choice — JSON/TOML/YAML):

```jsonc
{
  // --- Existing fields ---
  "baseline": ["docs"],
  "keywords": {
    "repo": ["pull request", "\\bPR\\b", "branch", "merge"],
    "tasks": ["\\bticket\\b", "sprint", "backlog"],
  },
  "toolBaselines": {
    "repo": ["listPRs", "getPR", "getPRComments", "comment", "approve", "createPR"],
  },
  "extras": [], // escalated servers, consumed on pendingRestart
  "toolExtras": {}, // escalated tools per server, same consumption
  "pendingRestart": false,

  // --- Client capability ---
  "client": {
    "defersToolSchemas": null, // null = use adapter default, true/false = override
  },

  "router": {
    "backend": "regex", // "regex" | "qmd" | "fts5"
    "catalogPath": null, // null = .toolgate/catalog/servers/, where `toolgate catalog build` writes (must stay inside the project)
  },

  // --- Per-server overrides (two-tier) ---
  "serverMeta": {
    "aws-dp-mcp": {
      "tier": "expensive", // "cheap" | "expensive"
    },
  },
}
```

The launcher exports (or writes into per-client config) two things the proxy entries reference:

- a per-server allow-list value (`<PREFIX>_<SERVER>_TOOLS`), and
- the path root needed to resolve the proxy binary.

## Source vs generated artifact (operational caveat)

If a client's MCP config file is a **generated artifact** (produced by a sync/scaffolding tool that
regenerates it — e.g. on every session start), then editing that file directly is **not durable**:
the next regeneration overwrites it. Server definitions (routing a server through the proxy) must go
in the **source** that feeds the generator, not the artifact. Before wiring the proxy into any
client, identify which file is the source of truth for that client, or changes will silently vanish.

## Security considerations

- The proxy sits **in the tool-call path**. It is a trust surface: it can read every request and
  response. Keep it small, auditable, and dependency-free; pin versions; sign releases.
- **Passthrough integrity.** The proxy must not alter `tools/call` arguments or results — only filter
  `tools/list`. Any transformation beyond filtering is a footgun.
- **Hidden ≠ denied.** Filtering a tool removes it from the model's view; it is a context optimization,
  **not** a security control. A determined agent with escalation access can re-enable it. Do not rely
  on tool filtering for authorization — use the client's permission system for that.
- **Credentials.** The proxy inherits the upstream server's env (API keys, tokens). It must not log
  them; stderr is inherited from the child, so the proxy itself should stay quiet except for its own
  warnings.
