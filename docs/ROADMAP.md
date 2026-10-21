# Roadmap

Deliberately small and sequenced so the universal piece ships first and each phase is independently
useful. Dates omitted on purpose — sequence matters more than calendar, and the "native support" risk
below argues for moving quickly.

## Phase 0 — MVP

**Goal:** prove the value end-to-end on one agent, with the reusable core.

- `toolgate-proxy`: self-configured stdio proxy implementing the full contract (fail-open,
  id→method, lifecycle/signals, line framing, allow-list-typo warning). No dependencies.
- `toolgate` launcher with **one adapter (Claude Code)**: layered config, keyword auto-detection,
  `extras`/`toolExtras` + `pendingRestart`, applies the set via `--settings`.
- Config schema + a `catalog` doc format (per-server core + escalatable tools).
- Isolated proxy test harness (feed `initialize` + `tools/list`, assert filtered output, fail-open,
  exit-code propagation).

**Done when:** a heavy server visibly drops from N→M tools in a real session, and escalating a tool +
restart brings it back.

## Phase 1 — More agents

- Codex CLI adapter (`config.toml` composition + `-c` overrides).
- Antigravity CLI adapter (config-file writing; leans on the self-configured proxy).
- Karajan integration (per-subagent proxy profile injection).

## Phase 2 — Router, catalog, and discovery (new headline)

The original Phase 2 items are re-prioritised per empirical findings
(see `SPEC-dynamic-activation-and-routing.md`). Server routing replaces tool-schema filtering as the
headline value for Class A clients.

- **Catalog builder** (`toolgate catalog build`): introspect each configured server once, emit a
  markdown index per server with cost metadata (instructions size, auth type, tool list). The index
  is consumed by the router and the `need` resolver. Pluggable backends: CLI ships with regex
  fallback; qmd or FTS5 can be installed and selected in config.
- **Router** (`toolgate route`): pure function; given a prompt and catalog, returns the
  expensive-tier servers to activate. Regex-first; pluggable index backends for better recall.
  Two-tier policy by default (cheap servers always on, expensive servers routed).
- **Need resolver** (`toolgate need`): unified replacement for hidden-tool discovery. Resolves a
  capability phrase against the catalog → reveals the tool if the server is active, or escalates +
  requests a restart if the server is inactive. No separate `list_hidden_tools` meta-tool.
- Profiles: named tool sets per task type (review / debug / ops) selectable at launch.
- Banner/telemetry: report tokens saved per session. The proxy maintains a **session record**
  (in-memory `Map<toolName, { fullSize, filteredSize, callCount }>`) accumulated during its
  lifetime. On proxy close, the orchestrator reads the record and computes:
  `Estimate = (sum(JSON.stringify(full_tools)) - sum(JSON.stringify(filtered_tools))) / 4`
  The shutdown banner prints the actual tools filtered per server and the estimated token savings.
- Auto-curation helper: probe a server's `tools/list` and suggest a baseline from usage signals.

### Dynamic proxy mode (delivered for Claude Code, #19)
The dynamic proxy (session file as control channel, sentinel, instructions deferral, `list_changed`) is no longer deferred: it ships for Claude
Code, with `toolgate need` revealing tools live and `toolgate tools` doing it by hand. See `SPEC-dynamic-activation-and-routing.md` §7.3 and
§7.4 and `getting-started.md`, "Reveal tools without a restart". Still open: the same for Codex and opencode (#272), and measuring what a
revealed tool frees after `/clear`.
## Phase 3 — Polish for adoption

- One-command install per agent; `toolgate doctor` (shipped in #20: agents, qmd and daemon, config, Step 0 rule, MCP servers,
  skills; checking allow lists against live `tools/list` is still open).
- Docs site; contribution guide for new adapters.
- Optional: HTTP-proxy variant to also cover `type: http` servers (separate design).

## Exploración futura: índice local propio (skills/comandos/subagentes)

Idea a explorar, no comprometida a ninguna fase todavía: que el propio `toolgate` incluya una base
de datos embebida con un índice de búsqueda sobre toda la información relevante del proyecto: skills,
slash-commands y subagentes disponibles, además de la documentación.

Referencia concreta apuntada por el usuario: **[qmd](https://github.com/tobi/qmd)** ("Query Markup
Documents"), un motor de búsqueda local sobre markdown/notas/documentación pensado explícitamente
para flujos agentic (expone salida en JSON pensada para LLMs y un servidor MCP). Combina tres
técnicas sobre una única base SQLite: full-text BM25 vía FTS5, búsqueda semántica vectorial
(embeddings locales vía `node-llama-cpp`, sin llamadas a APIs externas) y un re-ranking final con LLM;
todo corre on-device. El contenido se organiza en "collections" (directorios + patrón glob), cada
documento se trocea en chunks respetando límites naturales (encabezados, bloques de código) y opcionalmente
con chunking consciente del AST vía tree-sitter para código.

La idea generalizaría el modelo de _progressive disclosure_ más allá de los tools MCP: en vez de
cargar por adelantado el catálogo completo de skills/comandos/subagentes, `toolgate` (o el propio
agente) consultaría este índice local **al vuelo** — vía algo como `qmd` embebido, o su propio servidor
MCP como fuente adicional — para descubrir y cargar solo lo relevante para la tarea en curso — el
mismo principio de "baseline + activación bajo demanda" ya descrito para servidores y tools, aplicado
a estos otros tres tipos de recursos.

Preguntas abiertas antes de comprometerlo a una fase: ¿integrar `qmd` como dependencia/proceso externo
(rompe el principio "dependency-free" del proxy, aunque el orquestador ya podría tolerarlo como
dependencia opcional) o reimplementar solo la parte de índice FTS5 que se necesita, sin embeddings ni
modelos locales?; quién genera y mantiene el índice (¿el propio `toolgate` al arrancar, o un paso de
indexado explícito tipo `toolgate index`, similar a las "collections" de `qmd`); y cómo encaja con el
mecanismo de descubrimiento de tools ocultos ya previsto en la Fase 2 (`list_hidden_tools` / catálogo) —
¿son el mismo índice, o dos mecanismos paralelos que conviene unificar?

_Resuelto para skills: colección qmd propia (`skills`), mismo daemon y mismo wrapper de búsqueda que el
catálogo MCP; ver [ADR 0001](adr/0001-skills-use-a-separate-qmd-collection.md)._

## Honest risks

### Prior art

Proxy-based MCP tool filtering already exists and some has traction:

- Atlassian **mcp-compressor** — wraps a server, reports 70–97% tool-description reduction, tunable
  verbosity. <https://www.atlassian.com/blog/development/mcp-compression-preventing-tool-bloat-in-ai-agents>
- **mcp-filter** (pro-vi) — filters upstream tools to a chosen subset.
  <https://github.com/pro-vi/mcp-filter>
- **MCProxy** (igrigorik) — aggregates and search-filters tools across servers.
  <https://github.com/igrigorik/MCProxy>

**Implication:** the proxy alone is not a differentiator. The defensible value is the **progressive
disclosure model** (baseline → keyword auto-detect → escalate → restart) and **multi-agent adapters**
under one config — not the filtering mechanism itself. If you build this, lead with that, and consider
interoperating with (not reinventing) an existing proxy where it's stronger.

### Native support may subsume this

- Claude Code has an open request for client-side tool filtering:
  <https://github.com/anthropics/claude-code/issues/7328>
- The MCP protocol has a proposal for dynamic tool discovery (server-advertised subsets / search):
  <https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1821>

**Implication:** if clients or the protocol add native tool filtering / lazy tool loading, an external
proxy loses much of its reason to exist. Scope toolgate as **"useful now, possibly subsumed in
6–12 months."** Keep it small, avoid deep coupling, and treat the orchestration/UX layer (which native
features are less likely to cover) as the durable part.

### Maintenance tail

- Each agent's MCP config format evolves (e.g. Antigravity's env-var bug); the adapter matrix is a
  standing compat cost.
- The proxy is in the tool-call path — a security/trust surface that must stay minimal and audited.

## Decision guide

Build it if: you value the multi-agent + progressive-disclosure UX, can move fast, and are willing to
either differentiate from prior art or wrap it. Don't build it if: you only need single-server tool
trimming on one client — an existing proxy already covers that, and native support is coming.
