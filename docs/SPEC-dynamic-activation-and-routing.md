# Spec — Dynamic Activation & qmd Routing

Status: draft. Derived from an empirical session against **Claude Code (Opus 4.8, MCP Tool Search
on)**. This spec records findings that revise two positions in `DESIGN.md` (the primary goal and one
non-goal) and defines an isolated build target so the capability can be developed and tested without
touching the host agent.

Audience: whoever implements this inside toolgate. Read `DESIGN.md` and `ROADMAP.md` first — this
spec amends them, it does not replace them.

## 1. Why this spec exists

`DESIGN.md` is written for the world where an MCP client loads **every tool schema of every enabled
server** into context at launch and keeps it there. That premise no longer holds for clients with
**tool search** (deferred tool loading). Measurements below show tool schemas cost **zero** context
on such a client — which both undercuts toolgate's primary goal _for that client class_ and, at the
same time, proves that a capability listed as a non-goal (mid-session activation) actually works.

The tool must therefore become **client-capability-aware** and shift its value from "filter tool
schemas" to "route servers + defer server-level costs".

## 2. Empirical findings

All measured in one Claude Code session via a purpose-built stdio MCP fixture (`toggle-mcp`, see
§10.1), `/context`, and `/mcp`.

| ID  | Finding                                                                                                                                                                                                                          | Evidence                                                                            |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| F1  | With tool search on, **tool schemas defer to 0 tokens**. Filtering tools saves ~0 context.                                                                                                                                       | `/context`: `MCP tools · 31 tools · 0 tokens` (qmd 4 + karajan 27)                  |
| F2  | Server-level `instructions` are **NOT deferred** — sent at `initialize`, present regardless of tool count.                                                                                                                       | aws-dp-mcp instructions ≈ 4.9k tokens; measured across 10 stdio servers             |
| F3  | **spawn + OAuth** are launch-time costs, independent of how many tools are exposed.                                                                                                                                              | slack/datadog/clickup need interactive OAuth; npx/uvx cold-start latency            |
| F4  | A server needs **≥1 exposed tool** to activate and stay registered. A 0-tool server is effectively not usable.                                                                                                                   | toggle-mcp connected only once it advertised `ping`                                 |
| F5  | **Mid-session tool reveal via `notifications/tools/list_changed` works and is live** — the new tool appeared in an already-open `/mcp` panel with no relaunch and no manual refresh, and was then invocable in the same session. | toggle-mcp: 1→2 tools after `touch` of a flag file; `late_pong` returned its marker |
| F6  | **A new server cannot be added mid-session.** Server set is fixed at launch.                                                                                                                                                     | Confirmed repeatedly; the wrapper pins `enabledMcpjsonServers` at launch            |
| F7  | The client's **permission classifier is semantic**. A revealed tool named `reveal_secret` returning `SECRET-42` was auto-denied; renamed `late_pong` it passed.                                                                  | Auto-mode denial on the secret-themed name only                                     |

Corollary (the important one): **for an already-connected server on a tool-search client, all of its
tools are already available to the model at 0 token cost.** Gating those tools behind a
sentinel + escalation + `list_changed` saves no schema tokens (F1), no instructions (F2), and no
spawn/auth (F3). The dynamic-reveal mechanism is real (F5) but, for context savings on this client
class, largely redundant.

## 3. Impact on `DESIGN.md`

| DESIGN.md position                                             | Verdict                                     | Amendment                                                             |
| :------------------------------------------------------------- | :------------------------------------------ | :-------------------------------------------------------------------- |
| Goal: "Cut the fixed context cost of MCP tool schemas"         | Holds only for **non-tool-search** clients  | Make it capability-conditional; add server-level goals (§4)           |
| Non-goal: "Runtime (mid-session) activation … means a restart" | **Refuted for tool-search clients** (F5)    | Promote to an **opt-in capability**, scoped to where it pays off (§6) |
| Two granularities: per server / per tool                       | Per-tool value depends on client class      | Add a **third axis**: server-level cost deferral (instructions/spawn) |
| ROADMAP risk "native support may subsume this"                 | **Partially realized** in Claude Code today | Treat tool-schema filtering as legacy-client value; lead with routing |

## 4. Revised value proposition

toolgate's durable value, restated against the findings:

1. **Server routing** — choose the minimal set of servers to connect from the task, because server
   set is fixed at launch (F6) and servers carry the real costs (F2, F3). This is launch-time and
   restart-time, not mid-session.
2. **Server-level cost deferral** — avoid or postpone `instructions`/spawn/auth of expensive servers
   until the task needs them.
3. **Tool-schema filtering** — unchanged original value, but **only for client classes that do not
   defer tool schemas** (§5).
4. **Tool-selection quality** — even at 0 token cost, fewer visible tools can improve model tool
   choice; keep as a secondary, measurable benefit, not the headline.

## 5. Client capability model (new, required)

Every adapter MUST declare the target client's tool-loading behavior:

| Class | Behavior                                         | toolgate value                                                       | Example                     |
| :---- | :----------------------------------------------- | :------------------------------------------------------------------- | :-------------------------- |
| A     | Defers tool schemas (tool search / lazy loading) | Server routing + cost deferral. Per-tool filtering ≈ no context win. | Claude Code + tool search   |
| B     | Loads all tool schemas at launch                 | Full original value: per-tool filtering saves real tokens            | Clients without tool search |

The orchestrator branches on class:

- Class A → run the **router** (§7.2) for server selection; skip per-tool allow-lists unless used
  purely for tool-selection quality; consider **instructions deferral** (§7.3) for heavy servers.
- Class B → current behavior (baseline + keyword detect + `toolBaselines` allow-lists via proxy).

Capability is a static property of the adapter, optionally overridable in config
(`client.deferstoolSchemas: true|false`).

## 6. Recommended policy — two-tier server set

The policy for a Class A client. Tiers are config-driven, not hard-coded. (There was a `--policy` flag and a `policy` setting to choose between this and connect-all; they never changed the result and were removed in #205: two tiers is the only behaviour.)

- **Cheap tier — always connect, full tools.** stdio, no OAuth, small `instructions`. Tools cost ~0
  (F1); connecting them freely is fine. No proxy, no routing, no gating. Never triggers a restart.
- **Expensive tier — connect only when routed.** OAuth (slack, datadog, clickup) or heavy
  `instructions` (aws-dp-mcp). Kept out of baseline; added by the router (§7.2) or by escalation.

## 7. Components (isolated build targets)

Each is independently testable. Map onto the existing packages: extend `toolgate-proxy` and the
`toolgate` orchestrator; add a router module and a catalog builder.

### 7.1 Catalog builder — `toolgate catalog build`

Introspects each configured server once (drive `initialize` + `tools/list`) and emits, per server,
a markdown doc suitable for indexing (qmd or an embedded FTS index — see ROADMAP open question).

Per-server front matter MUST include cost metadata so the router can reason about it:

```yaml
server: aws-dp-mcp
transport: stdio # stdio | http
auth: none # none | token | oauth
instructionsChars: 19600 # server-level, NOT deferred (F2)
toolCount: 41
tools:
  - name: <tool>
    description: <one line>
    whenToUse: <task phrasing that should activate it>
```

Body: one section per tool (name, description, when-to-use) so semantic search can map a task need
to a concrete tool. The catalog is the single source both the router and the mid-session `need`
command query.

Implementation notes (`toolgate catalog build [--server <name>] [--dry-run] [--json]`): the file is
`<catalogPath>/<server>.md` (default `.toolgate/catalog/servers/`). Each tool carries `whenToUse`; a text a person wrote is kept on
rebuild by tool name, and a generated one (the first sentence of the description) is marked `whenToUseGenerated: true`. Building
**starts** the servers, so servers of the user's own config run without asking, while those of a repository's `.mcp.json` run only after
a typed `yes` for that exact definition (kept per machine); `--yes`, CI, no terminal, `--force` and `--dry-run` never approve (exit 2).
Everything a server returns is untrusted text and is written as quoted one-line values.

The router and `need` read this catalog (§7.2): matches are capped by `router.catalogMaxServers`, come after the servers that bindings, skills and keywords chose, and never override a binding or the baseline.

### 7.2 Router — `toolgate route`

Pure function; the core of the new value. No side effects; safe to unit-test offline.

```text
toolgate route --prompt "<task text>" [--catalog <path>]
  → stdout JSON:
    {
      "servers":     ["<server>", ...],   // expensive-tier servers to add this launch
      "reason":      "<why each was chosen>",
      "escalations": [ ... ]              // optional: servers the prompt implies but that need OAuth
    }
```

Resolution:

1. Always include the cheap tier: the `baseline` servers and the ones `serverMeta` marks `tier: "cheap"`. There is no `policy` setting.
2. Match the catalog by the words of the prompt → expensive-tier matches (a search by meaning is not used: the score the qmd daemon gives is the rank of a document, not a relevance).
3. Fall back to the existing `keywords` regex when the index is unavailable (**dependency-optional**:
   the router MUST degrade to regex so the core stays shippable without qmd).

The orchestrator feeds `servers` into the client adapter's "apply" step (for Claude Code: merge into
`enabledMcpjsonServers`). This **replaces/augments** the wrapper's current keyword auto-detection.

### 7.3 Dynamic proxy mode — `toolgate-proxy` (delivered for Claude Code, #19)
Backward-compatible superset of the static proxy contract in `DESIGN.md` ("Dynamic proxy mode"). It is on when the proxy finds a trusted
session file of toolgate's for its server (`TOOLGATE_SESSION_STATE`, `TOOLGATE_SERVER`); otherwise it is the static proxy. As built:
- **Control channel (the only new trust surface).** A per-session file written by toolgate and only read by the proxy: no socket, no port,
  local to the user (modes 700 and 600, owner, link, path and size checks). The proxy watches it (`fs.watch` plus a one-second check) and,
  when the offered set changes, sends `notifications/tools/list_changed` after the client's `notifications/initialized` (reference behavior,
  F5).
- **Sentinel (F4), as a meta-tool.** The offered set is the baseline plus what was revealed; when it is empty the proxy lists one neutral tool,
  `toolgate_status` (naming rule §8), so the server stays registered. It answers calls to it itself.
- **Instructions deferral (F2, the one real context win on Class A).** Not a per-server key: the instructions leave `initialize` exactly when
  nothing of the server is offered, are kept in a file of the session, and reach the agent once, with its first tools (`need`, `tools enable`).
- **`list_changed` capability.** `capabilities.tools.listChanged = true` in `initialize` when dynamic.
Unchanged: fail-open, dependency-free, id tracking, signal and lifecycle forwarding, passthrough integrity. Hiding is not a boundary:
calls to tools that are not offered are forwarded; permissions are the gate.
### 7.4 Mid-session need resolver — `toolgate need` (delivered for Claude Code, #19)
```text
toolgate need "<task>"
  → route, then for each server the task needs:
     always on (baseline, cheap), no session or not wrapped → available
     active in this toolgate session (wrapped by the proxy), whether chosen by the router or always on (the catalog card of every
     active server is matched against the task, outside the `router.catalogMaxServers` cap, since it adds no server):
        catalog matched tools of it (not offered yet)       → revealed   (tools go into the session file; the proxy offers them live, F5)
        all matched tools offered already                   → available
        nothing matched                                     → dormant    (available + hint: toolgate tools enable <server> <tool>)
     not active, or no session                              → restart-required (recorded as before; with a session the matched tools
                                                               are recorded too, so the relaunch already offers them)
```
`revealed` and `available` entries carry `instructions` the first time when the proxy kept them back. `toolgate tools enable|disable|status|reset`
changes the offered tools by hand. On a Class A client with tool search the reveal saves the names of the tools and, above all, the server's
instructions (F1, F2); with tool search off it also saves the schemas. Agents without `dynamicTools` keep `restart-required`.
## 8. Naming constraint (F7)

Any tool name and result string that toolgate **injects or reveals** (sentinels, meta-tools,
fixtures) MUST be semantically neutral. Avoid trigger words (`secret`, `password`, `token`,
`reveal`, `exfiltrate`, `dump`, …) that a client's permission classifier may auto-deny. `toolgate
doctor` warns on server and tool names in the config that match the denylist in
`packages/toolgate/src/doctor/denylist.js`: `secret`, `password`, `passwd`, `token`, `credential`,
`apikey`, `reveal`, `exfiltrate`, `exfil`, `dump`, `leak`, `steal`, `bypass`. A name is split
into words (`reveal_secret`, `revealSecret`) and a term must match a whole word, with an optional
`s`, `ed` or `ing` (`tokens` matches, `tokenizer` does not). The check covers only the names in the
config; the sentinels and meta-tools toolgate injects itself are covered by this rule, not by `doctor`.

## 9. Isolation & integration seam

The point of this spec is that toolgate is built and tested **without** modifying the host agent.

- **Launch seam.** The host wrapper (`toolgate` or any adapter) calls `toolgate route` and
  applies the result through the client's own config mechanism. toolgate never edits the agent's
  internals — only computes sets and (for the proxy) sits in the stdio path.
- **Source-of-truth caveat (carried from `DESIGN.md` §"Source vs generated artifact", and confirmed
  the hard way in testing).** Proxy server definitions and any injected servers MUST be written to
  the **source** that feeds the client's MCP config generator, never the generated artifact. In the
  reference environment `.mcp.json` is a symlink to a template regenerated on session start; a server
  added only to the artifact vanished on the next launch. Adapters MUST identify and target the
  source file.
- **Everything else stays in toolgate:** catalog, router, proxy, need-resolver, config schema.
- **Standalone tests** use a mock upstream (the toggle-mcp fixture) and the proxy harness — no real
  agent required.

## 10. Test plan

### 10.1 Reference fixture — `toggle-mcp`

A minimal dependency-free stdio MCP server used as the mock upstream. Behavior:

- Advertises one sentinel tool (`ping`) at start → validates F4 (server activates with ≥1 tool).
- Watches a flag input; on trigger, adds a second **neutrally-named** tool and emits
  `notifications/tools/list_changed` → validates F5 (live reveal).
- Second tool, when called, returns a runtime marker → validates invocability post-reveal.

Ship it under `test/e2e` as the canonical fixture. (A proven implementation exists from the
session that produced this spec; port it verbatim, keeping neutral names per §8.)

### 10.2 Assertions

- **Proxy (static, existing):** `initialize` + `tools/list` → filtered output; fail-open on empty
  allow list; exit-code propagation; typo warning.
- **Proxy (dynamic, delivered):** the sentinel is the only tool when nothing is offered; a change to the
  session file widens `tools/list` and emits `list_changed` (once per real change, after the client's
  `notifications/initialized`); a revealed tool is invocable; the instructions of a server with nothing offered
  are kept in a file of the session and given once with its first tools.
- **Router:** prompt → expected server set, with and without the index (regex fallback).
- **Capability branch:** Class A path skips per-tool filtering; Class B path applies it.
- **Negative (F6):** adding a server mid-session is NOT attempted; `need` returns
  `restart-required` for an inactive server.
- **Naming (F7):** an injected tool with a denylisted name is flagged by `doctor`.

## 11. Open decisions

Carried from `ROADMAP.md` plus new ones from the findings:

1. **Index dependency.** Embed qmd (external process/dep, breaks proxy's dependency-free rule but the
   orchestrator can tolerate it) vs reimplement a minimal FTS5 subset. Router MUST work without it
   (regex fallback), so this only affects match quality.
2. **Is instructions-deferral worth it?** Only aws-dp-mcp meaningfully benefits (~4.9k). Possibly not
   worth the added proxy complexity for a single server — decide per deployment.
3. **Default policy.** Two-tier (routed) vs connect-all-with-sentinels. Decided: two-tier is the only
   behaviour; the `--policy` flag and the `policy` setting were removed in #205 (they never changed the result).
4. **Unify discovery mechanisms.** Phase 2's `list_hidden_tools` meta-tool and the catalog/router
   overlap. Prefer one: the catalog + `need` resolver, with an optional meta-tool only for clients
   where the agent cannot shell out to `toolgate need`.
5. **Class detection.** Static per-adapter flag vs runtime probe of the client. Start static.

## 12. Phasing (amends ROADMAP)

- **Keep Phase 0** (static proxy, Class B value) as-is — still the shippable, universal core.
- **Add:** capability model (§5) + router (§7.2) + catalog builder (§7.1). This is the new headline
  value and is independent of the proxy.
- **Delivered for Claude Code (#19):** the dynamic proxy mode (§7.3) and the `need` reveal path (§7.4). The use case that
  justified them: start a session with the minimum tools of each server and reveal more live (F5), and keep a server's
  instructions out of the first load (F2). Codex and opencode are #272.

## 13. One-paragraph summary for the reader

Tool search already makes MCP tool schemas free on Claude Code, so toolgate's original "filter tool
schemas" goal is a **Class B** (no-tool-search) value only. On **Class A** clients the real costs are
server-level (`instructions`, spawn, OAuth) and the server set is frozen at launch — so toolgate's
durable job is **routing the right servers in at launch** (via a catalog-backed router) and, only
where it demonstrably pays, **deferring server-level costs**. Mid-session tool reveal via
`list_changed` is proven to work and is delivered for Claude Code with the session file as its control channel; mind the
semantic permission classifier when naming anything injected.
