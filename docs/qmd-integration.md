# QMD integration

toolgate uses [QMD](https://github.com/tobi/qmd), a local-first markdown search engine (keyword plus
semantic), to find the skill that handles a task without loading every skill into the agent's context.
Nothing is installed into the agent's own configuration: skills live in `.toolgate/skills/`, are indexed
by QMD, and `toolgate route` returns the one the task needs. New here? Start with
[`getting-started.md`](getting-started.md).

## What is indexed

- One QMD collection **per project** holds the project's skills (see [ADR 0001](adr/0001-skills-use-a-separate-qmd-collection.md)).
  Its default name is `skills-<directory>-<hash of the path>`, and `toolgate skills index` is its only owner.
- The corpus it indexes is generated in `.toolgate/skills-index/` (git-ignored): one card per skill and a
  catalog. Cards carry the name, description, tags, required MCP servers, level and the path of the real
  `SKILL.md`, which is what `route` returns.
- `toolgate init` sets the project up (config, the Step 0 rule, `.gitignore`, the daemon and the index); it
  replaces the old `toolgate-init` script, which also created `global-knowledge` and `local-knowledge`
  collections. Those are no longer created. Existing ones are not touched and can be removed with
  `qmd collection remove <name>`.

## Shared daemon

The `qmd` router backend queries one shared HTTP daemon (`qmd mcp --http --daemon`, port 8181 by
default) instead of spawning a `qmd mcp` over stdio per agent session, so the embedding, reranker and
query-expansion models are loaded once.

```bash
toolgate daemon start    # idempotent: does nothing when the daemon already answers
toolgate daemon status   # exit code 0 when running, 1 when not
toolgate daemon stop     # delegates to `qmd mcp stop`; not running is not an error
toolgate daemon restart  # stop, then start; waits up to a minute, a cold start loads the models
```

- The port comes from `--port`, then `QMD_SHARED_PORT`, then 8181.
- `toolgate init` starts the daemon, and `toolgate "<prompt>"` ensures it before
  routing when the backend is `qmd`. A failure never blocks the launch: routing degrades to the
  `qmd` CLI and the reason is printed on stderr.
- A daemon can end up serving fewer documents than the index holds (found after installing skills into a
  collection that already existed: queries kept returning the old ones, with no error). toolgate compares
  what the daemon reports for the project's collection (the `status` tool) with the documents of the corpus:
  `route` adds a `warnings` entry when they differ, and `skills index`, `skills install`, `skills update`, `skills remove` (unless `--dry-run`) and `init` restart the
  managed daemon themselves when they find it behind, saying so. If it cannot be told (no corpus, a daemon
  that does not report counts) nothing is reported. Run `toolgate daemon restart` to do it by hand.
- Before it queries a local daemon, `route` and `need` probe `GET /health` for one second. A daemon that is down (the port refuses) or hung (the probe times out, answers without 2xx, or answers and then fails the query) is reported in `warnings`, with the command that fixes it (`toolgate daemon start`, or `toolgate daemon restart`), and routing falls back to the `qmd` CLI (keyword search only). A remote `router.qmdUrl` that fails gets a warning without a command, and a disabled one says nothing. `toolgate doctor` shows the same two cases under `daemon.reachable`; `toolgate daemon status` shows the state.
- Only a local endpoint is managed. Set `router.qmdUrl` to a remote URL to use someone else's
  daemon, or to `null` to disable it.
- `router.qmdUrl` decides where your task text is sent, so it counts only in your user config and your local config, and the local one only while git does not version it (a repository can ship a force-added `config.local.json`; fix with `git rm --cached .toolgate/config.local.json`). In the committed project file, or a versioned local file, it is ignored, and `route`, `need` and `doctor` say so: a cloned repository must not be able to send your prompts to a host it chooses. `toolgate config set router.qmdUrl <url> --user` (or `--local`) sets it; `--project` is refused.

## Skills

```bash
toolgate skills index [--force]            # (re)build the corpus and the qmd collection
toolgate skills search "<task>" [--json] [--kind skill|command|all]   # which skill or command handles this task?
```

- Skills follow the config layers (user, project, local). Each layer's `skills.sources[]` is added to the
  list, tagged with its level; a relative `dir` resolves against the project (project and local layers) or
  the user config directory (user layer). Other keys (`collection`, `corpusDir`) are decided by the
  highest layer; a user-level `corpusDir` is ignored (the corpus is per project), and `corpusDir` must be a
  folder inside `<project>/.toolgate` that is none of toolgate's own (the stores, the locks, the config files):
  anything else is refused. The index only ever removes cards it generated itself. On a name clash the higher level wins (local over project over user) and `route` /
  `skills search` report the level of each skill. Two skills with the same name inside one level fail.
- The project can restrict this with `skills.userLevel: false` and/or `skills.localLevel: false`
  in `.toolgate/config.json`; only the project layer's switches count.
- Sources come from `skills.sources[]` in `.toolgate/config.json` (`{ "dir": "...", "glob": "*/SKILL.md" }`,
  glob optional). Without it, the existing ones of `.rulesync/skills` and `.toolgate/skills` are used.
- Each `SKILL.md` needs a `name` and a `description` in its YAML frontmatter. `tags` and `mcps` are
  optional lists, and without `mcps` the "Required MCPs" section of the body is read.
- Commands (prompt templates such as `review-pr.md`) are indexed in the same collection. They come from
  `commands.sources[]` (`{ "dir": "...", "glob": "**/*.md", "dialect": "claude" }`, glob and dialect optional;
  without any, `.rulesync/commands` and `.toolgate/commands` are used when they exist), follow the same layers
  and name resolution as skills, and have their own `commands.userLevel` / `commands.localLevel` switches. A
  command needs a `description` in its frontmatter; its name is the file name, with nested folders joined by `-`.
  Their cards live in `commands/<name>.md` of the corpus, so a command and a skill may share a name, and their
  catalog line carries `kind: command`. `skills search` marks them with `kind` in `--json` and a `/` prefix in
  text. `--kind` filters after the query, so it asks qmd for more hits than `limit`; a filtered search can
  still return fewer than `limit` when the first hits are all of the other kind. A project may have commands
  and no skills sources. `route` does not return commands yet.
- The index is rebuilt only when a source git HEAD or a selected file mtime changes (`--force`
  skips that check). It lives in `.toolgate/skills-index/`.
- `toolgate skills index` owns the project's skills collection (see [ADR 0001](adr/0001-skills-use-a-separate-qmd-collection.md)).
  qmd collections are global to the machine, so the default name is per project:
  `skills-<directory>-<hash of the path>` (override with `skills.collection`).
  If a collection of that name already points at another folder, the command fails and says which;
  free the name with `qmd collection remove <name>`.
- `toolgate route` checks the servers a task needs (a skill's Required MCPs plus keyword matches) against
  the servers the agent has configured: `.mcp.json` and `~/.claude.json` (user and local scope) for
  Claude Code, `~/.codex/config.toml` and `.codex/config.toml` for Codex,
  `~/.gemini/config/mcp_config.json` for Antigravity. The ones that are not configured stay in
  `servers` and are also listed in `missing: [{ server, install, checkedIn }]`, and the Step 0 rule has
  the agent name them and ask before installing. `install` is `serverMeta.<server>.install` from the
  config, or `null`. If no config can be read, or one is malformed, or the check fails, nothing is
  reported missing. Servers configured elsewhere (plugin or managed servers) are not seen, so the agent
  confirms against its own tool list first. toolgate never edits MCP configuration by itself.
- `toolgate skills install recommended:<id> [name...]` installs a reviewed source from the shipped list at its pinned
  commit (see [recommended-skills.md](recommended-skills.md)).
- `toolgate skills update [name...] [--source s] [--dry-run] [--force] [--prune] [--user|--local]` moves what the
  lock says was installed to the current upstream of the recorded ref. Per skill: `unchanged`, `updated`, `restored`
  (copy missing), `kept` (edited here, unchanged upstream), `conflict` (edited and changed upstream: skipped unless
  `--force`), `removed upstream` (kept; `--prune` deletes it) or `skipped` (invalid upstream, copy stays). New upstream
  skills are only listed. `--dry-run` fetches into the cache and prints the file diff with what changes the agent's
  behaviour (non-text files, MCP servers gained, description, license). A source that cannot be fetched is reported and
  the others continue. Exit 1 on an error, an unknown name or source, or when nothing could be applied. The source's
  commit in the lock moves only when every skill reached it; each skill records the commit it came from.
  A license that changed upstream is never applied by itself: `update` says so and names `--accept-license`, which
  copies the upstream license files (also when no skill changed, and replacing a hand-edited copy; `--dry-run` shows what
  it would copy). The flag itself writes nothing to the lock (the source's commit there moves with any complete update, as always), and `update` exits 1 for it only if a license file could not be copied. The same flag works
  for `commands update` and `subagents update`.
- `toolgate skills remove <name...> | --source <spec> [--force] [--dry-run] [--keep-overrides] [--user|--local]` deletes
  only skills that are in the lock of that level (your own skills are never touched), only unedited copies unless
  `--force`, and never follows a symlink. It also removes the lock entry, the source and its license when nothing else
  comes from it, and the skill's override from the config of the same level (an override in another layer is left and
  mentioned). A name given twice counts once; `--source` and names cannot be combined.
- `toolgate skills status [--remote] [--check] [--json]` is read-only and offline unless `--remote` (one `git ls-remote`
  per source). States: `ok`, `edited` (differs from the lock), `missing` (in the lock, no copy), `unlocked` (a
  folder the lock does not know, such as your own skill); shadowing across levels and the overrides applied are
  shown. `--check` exits 1 when something is `edited`, `missing` or upstream is newer, and 2 when `--remote` could
  not reach a source. A source pinned to a full commit SHA (a recommended install) is not compared with anything
  upstream: `--remote` only checks that the server answers. A branch wins over a tag of the same name, as it does when
  installing. `toolgate doctor` runs the same check for the user and local locks.
- `toolgate commands install|update|status|import|list|index|search` is the commands side: `install` has the options of `skills install`
  plus `--dialect`, and writes the normalized copies to `.toolgate/commands/` with their own lock,
  `.toolgate/commands.lock.json`. `index` is the same operation as `skills index` (one collection holds both) and
  `search` is `skills search --kind command`.
  `update` and `status` work like the skills ones on the commands lock; `import` brings the commands of the agent's own
  folders in as `local:` sources, which `update` and `status --remote` skip. All take `--user` or `--local`.
- `toolgate skills install <github:owner/repo | https or ssh git URL> [name...] [--ref r] [--path p] [--exclude n] [--force]`
  copies the skills of a remote repository into `.toolgate/skills/` and indexes them. The repository is fetched
  with `git clone --depth 1` into a cache outside the project (`$XDG_CACHE_HOME/toolgate/sources`), so nothing
  downloaded is ever executed and `file://`, `ext::` and other protocols are refused. Skills are looked for in
  `<name>/SKILL.md` under `skills/` (or the repository root, or `--path`). Each copy is a generated artifact:
  `.toolgate/skills.lock.json` records its source, commit and content hash, the source's `LICENSE` is kept in
  `.toolgate/skills/.licenses/`, and running the command again updates only what changed upstream. A skill the
  user already had, one installed from another source, or a copy edited by hand is skipped (and reported) unless
  `--force` is given. A skill that is invalid (no `description`, an unsafe name, a symlink) is reported and
  skipped without stopping the others. Commit `.toolgate/skills/` and the lock so the whole team shares the same
  skills. If the project declares its own `skills.sources`, `.toolgate/skills` must be one of them to be indexed.
- When qmd cannot run, search falls back to a keyword match over the generated `_index.md` and the
  result says `source: "fallback"` and why. Symlinked skill files are rejected, never followed.

## Requirements

- Node 20.6 or newer.
- The `qmd` engine. `@tobilu/qmd` is an optional dependency of toolgate (it needs Node 22 or newer): when no
  `qmd` is on the PATH, the bundled copy is put at the end of the PATH when the CLI starts, so a `qmd` you
  installed yourself always wins. On Node 20 or 21 it is skipped; then toolgate falls back to the `regex` router
  backend and `skills search` to a keyword match over the generated catalog, and says so.
- git, for `toolgate skills install`.
