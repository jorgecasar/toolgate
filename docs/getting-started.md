# Getting started

toolgate keeps an agent's initial context small. Skills are not installed into the agent: they live in
your project, are indexed, and the agent asks `toolgate route` which one the task needs and reads only
that. This guide takes a project from nothing to a working setup. Every command and output below was run
in a new project.

## Requirements

- Linux. toolgate is tested on Linux on every pull request, and on macOS once a week; supporting macOS and Windows fully is the goal.
- Node 20.6 or newer, and git.
- The `qmd` search engine. It comes with toolgate as an optional dependency (`@tobilu/qmd`, which needs
  Node 22 or newer), so there is nothing to install on a current Node. A `qmd` you installed yourself
  (`npm install -g @tobilu/qmd`) takes priority over the bundled one. Without either, `toolgate init` asks
  (in a terminal) whether to run `npm install -g @tobilu/qmd` for you; `--yes` takes the default and installs it, and
  `--install-qmd` installs it without asking; in CI or without a terminal, with neither, it installs nothing and prints
  the command. Meanwhile toolgate still works,
  but searches by keywords only and says so.
- An agent and [rulesync](https://github.com/dyoshikawa/rulesync) (`npm i -g rulesync`). When the project uses rulesync (it has a
  `rulesync.jsonc`, or you chose targets) and `rulesync` is not on the PATH, `toolgate init` asks (in a terminal) whether to run
  `npm install -g rulesync`; `--yes` and `--install-rulesync` install it without asking; in CI or without a terminal,
  with neither, it installs nothing and prints the command. `toolgate init` writes the
  Step 0 rule once, in `.rulesync/rules/`, and rulesync writes it where each agent reads it. Which agents get it is the
  `targets` of `rulesync.jsonc`: only the agents installed on your machine (a
  `CLAUDE.md`, `AGENTS.md` or `GEMINI.md` the project has only says where the preselection comes from). The files you already have become the one root rule `.rulesync/rules/overview.md`
  (they are only read, never edited), and `toolgate init` never runs `rulesync generate` and never writes `"delete": true`.
  In a terminal it asks first whether to use rulesync at all (yes by default; `--yes` takes the default); answering no writes
  the rule straight to each agent's own file.

## 1. Install toolgate

toolgate is not published to npm yet. From a clone:

```bash
git clone https://github.com/jorgecasar/toolgate.git
cd toolgate && npm install
npm install -g ./packages/toolgate      # puts `toolgate` on your PATH
```

## 2. Set a project up

In the project's root:

```bash
toolgate init
```

```text
  created .toolgate/config.json
  created .rulesync/rules/toolgate-router.md
  created rulesync.jsonc (targets: claudecode)
  created .gitignore (+4)
  qmd daemon started on http://localhost:8181/mcp
Next:
  - run `rulesync generate` so the Step 0 rule reaches your agents
  - no skills yet: add them under .toolgate/skills/<name>/SKILL.md, then run `toolgate skills index`
Check it with: toolgate route --prompt "<a task>"
```

What it did:

| File or process | What it is |
| --- | --- |
| `.toolgate/config.json` | The project's toolgate config: `router.backend` is `qmd` unless you pass `--backend regex` (it never depends on whether `qmd` is installed on this machine; starting the daemon and indexing are effects, not files). |
| `.rulesync/rules/toolgate-router.md` | The Step 0 rule: it tells the agent to run `toolgate route` before every task. `rulesync generate` copies it to each agent's own file (`.claude/rules/`, `AGENTS.md`, ...). |
| `rulesync.jsonc` | Created when missing: `targets` (the installed and detected agents by default; `toolgate init --targets claudecode,codexcli` picks others, using rulesync's ids) and `features: ["rules"]`. An existing one is never edited: if it lacks a target you asked for, `init` prints the line to add. |
| `.gitignore` | Adds `.toolgate/config.local.json`, `.toolgate/state.json`, `.toolgate/skills-index/` and `.qmd/`. |
| the qmd daemon | One shared process that keeps the search models loaded, used by every project and agent. |

To write your own Step 0 text, point `rule.template` at a file: `toolgate config set rule.template ~/my-rule.md --user` (or `--local`). It counts only in your user config and in a local config git does not version; a project value is ignored with a note, because a cloned repository must not choose what the agent is told. A file that cannot be read stops `init` before it writes anything. The path is not expanded: a `~` typed on the command line is expanded by your shell before toolgate sees it (so `config set` stores the full path), but a `~/my-rule.md` written by hand in a config file stays a literal `~` and is not found. A relative path is relative to the project folder, not to the config file that holds it.

To give the agent the Step 0 rule without a committed file, turn on `client.injectRule` (`toolgate config set client.injectRule true --user`). When toolgate launches Claude Code it then passes the rule as `--append-system-prompt` for that session only, and for Codex as `-c developer_instructions` (which replaces a `developer_instructions` from your Codex config for that session). Nothing is written and no tracked file changes; if you pass that flag (or that `-c`) yourself, yours wins and toolgate says so. The other agents keep using the rulesync file until their CLI is verified to have an equivalent.

`init` never overwrites a file: one that already exists is reported as `unchanged` or `kept`, so it is safe
to run again. It also says plainly what is still missing, instead of reporting success.
A config file that git tracks but your working tree lost (a deleted `.toolgate/config.json`) is not replaced with a fresh one:
`init` and `toolgate config set|add|unset|remove` say `git restore <file>` and stop (`init` exits 1 after doing its other steps;
`--force` creates a new file anyway). Only the project's file is checked, not `config.local.json` or the user's. When the
config exists, `init` also prints, without writing, the managed key it lacks (`router.backend`) and a `--backend` flag it
did not apply.
`init` asks at most three questions, all in a terminal: whether to install `qmd` if it is missing, which agent to launch by
default, and which recommended skills to install. With `--yes` it asks **none** of them and takes the defaults: it installs
`qmd` (and `rulesync`, when the project uses it) if missing, creates the `/toolgate` command and sets the first installed
agent as the default; it does not install recommended skills (they need a flag naming them). In CI or without a terminal, and
without `--yes`, it asks nothing and does none of those optional things (except the default agent: it sets the first installed one);
each skipped question leaves the command to run in the `Next:` list. The flags that name the answer (`--install-qmd`,
`--install-rulesync`, `--bridge`, `--agent`, `--install-recommended`) act in every mode, because you wrote them. `toolgate init --yes`
installs two programs globally with npm, so use `--install-qmd`-style flags or no flag at all in an environment where that is not wanted.

`toolgate init --dry-run` prints what `init` would do (`would create ...`, `would set defaultAgent ...`, `would install
qmd ...`, `would start the qmd daemon`) and changes nothing: no file or folder, no install, no daemon, no network. It
asks no question and takes the same flags (`--agent`, `--targets`, `--backend`, `--install-qmd`,
`--install-rulesync`, `--bridge`, `--install-recommended`), so you can try a command line before running it.

`init` lists the agents it finds on your machine only as information: it configures nothing for them, so the same
flags give the same files on every machine. Rules an older `init` wrote straight into an agent's file
(`.claude/rules/toolgate-router.md`, `AGENTS.md`) are left alone; `init` tells you when one is the
unchanged template, so you can delete it if rulesync now writes it.

`init` also asks which agent `toolgate "<prompt>"` should launch by default (`defaultAgent`). It lists every supported
agent in a fixed order (most used first: claude-code, codex, opencode, antigravity, karajan; `AGENT_ORDER` in
`src/agentReport.js`), marked installed, not installed, or not detectable (only `generic`, which has no binary to look for), and
preselects the first installed one. With `--yes` or without a terminal it asks nothing and sets that first installed
agent, printing the list and `toolgate config set defaultAgent <name> --local` to change it (with none installed it sets
nothing). The answer goes to `.toolgate/config.local.json` (personal, not versioned), or to your user config with
`--user`; it is never written to the project config. A value you set in your own config is never replaced or asked
again. One that comes from the project's `.toolgate/config.json` is the team's: in a terminal `init` asks whether to
change it (Enter keeps it; another agent is written to your local config, which overrides the project's, and the project
file stays as it is), and with `--yes` or without a terminal it keeps it. `toolgate init --agent <name>` sets a specific
one, also over the project's.

## 3. Add skills

A skill is a folder with a `SKILL.md`. Nothing is installed by default; see what is recommended and install it:

```bash
toolgate skills recommended
```

```text
addyosmani/agent-skills  github:addyosmani/agent-skills@aeac41d  MIT  24 skills  not installed
Nothing is installed by this command; install one with: toolgate skills install <source> [name...]
```

```bash
toolgate skills install recommended:addyosmani/agent-skills
```

```text
toolgate: addyosmani/agent-skills: github:addyosmani/agent-skills at aeac41d (MIT), 24 reviewed skills
toolgate: installed 24 skills, updated 0, unchanged 0 from recommended:addyosmani/agent-skills (aeac41d)
```

- A recommendation is pinned to one commit and lists the skills that were reviewed; installing it fetches exactly
  that. A later `toolgate skills update` stays on that commit.
- `toolgate init` lists the recommendations too and, in a terminal, asks which to install (Enter installs nothing).
  `toolgate init --install-recommended[=id,id]` installs them without asking, even with `--yes` (bare, it means the
  shipped list; a source added by a project's config is installed only when you name it, and the question marks it); `--yes` alone, CI
  and any run without a terminal install nothing and print how to look.
- Any repository works too: `toolgate skills install github:<owner>/<repo> [name...]` (`https://` and `ssh` URLs
  as well; `--ref`, `--path` and `--exclude` choose what to read). Nothing downloaded is ever executed.
- The copies go to `.toolgate/skills/`, `.toolgate/skills.lock.json` records source, commit and content hash of
  each, and the source's `LICENSE` is kept next to them. Commit all of it. `--user` installs for yourself
  (`~/.config/toolgate/skills/`); `--local` is for trying a skill on one machine (`.toolgate/skills.local/`,
  gitignored). The installed copies are not executable (on purpose): a skill runs its scripts with an interpreter (`node script.js`, `sh script.sh`).
- A skill that lacks what routing needs (for example the MCP server it requires) gets an override in the config,
  which `install` writes for recommendations: `toolgate config add skills.overrides '{"skill":"browser-testing-with-devtools","mcps":["chrome-devtools"]}'`.

Keep them current and tidy:

| Command | What it does |
| --- | --- |
| `toolgate skills status [--remote] [--check]` | Per skill: level, origin, edited / missing / unlocked, shadowing, overrides; `--remote` asks upstream if it moved |
| `toolgate skills update [name...] [--dry-run] [--force] [--prune]` | Moves installed skills to the current upstream; `--dry-run` shows the file diff first. Edited copies are kept unless `--force`; new upstream skills are only listed |
| `toolgate skills remove <name...> [--force]` | Deletes only what toolgate installed, with its lock entry and overrides |

To write your own, create `.toolgate/skills/<name>/SKILL.md`:

```markdown
---
name: release-checklist
description: Steps to cut and publish a release of this project
tags: [release]
mcps: [github]
---
...the instructions the agent follows...
```

`name` is required. A skill without a `description` is still indexed, but `toolgate doctor` reports it: there is little to find it by. `mcps` lists the MCP servers the skill needs (see
[Missing servers](#missing-servers)). Then run `toolgate skills index`.

### Commands

A command is a markdown file with a `description` (and optionally `argument-hint`), for example the files
of `.claude/commands/`. toolgate treats commands as text it indexes next to the skills; nothing is
registered in the agent, so they cost no context until a task needs one.
```bash
toolgate commands install github:owner/repo      # copies them to .toolgate/commands/
toolgate commands list                           # /name and where each one is
toolgate commands search "review a pull request" # same index as skills, commands only
toolgate commands index                          # same as `toolgate skills index`
toolgate commands status [--remote] [--check]    # copies against the lock (and upstream)
toolgate commands update [name...] [--dry-run]   # move installed commands to their upstream
toolgate commands import [--path dir] [--dialect d]  # bring .claude/commands etc. under toolgate
```
- The copies in `.toolgate/commands/` are the normalized form, not the original file: only `name`,
  `description`, `argument-hint`, `tags` and `mcps` are kept, arguments become `$ARGUMENTS`, and inline
  shell (`` !`cmd` ``) or file inclusion (`@path`) become plain instructions ("run `cmd` and use its output
  here"). Nothing in a command is ever executed by toolgate.
- `--user` and `--local` pick the level of `install`, `update`, `status` and `import`: the user level lives in
  the toolgate config folder, the local one in `.toolgate/commands.local/` (kept out of git).
- `import` copies the commands an agent already has (`.claude/commands`, `.opencode/command(s)`,
  `.agents/commands`, `.agents/workflows`; with `--user`, the ones in your home) in their normalized form. The originals are never
  changed, a folder that is a symlink is left out, and nothing that executes (`!`cmd``, `@file`) is kept. They have
  no remote, so `update` skips them: run `import` again to take their changes.
- `/toolgate` is the one command toolgate registers in an agent, because Claude Code and others reject an unknown
  `/name` before the agent sees it. `toolgate commands bridge [agent...] [--user] [--dry-run] [--force]` writes it
  (`.claude/commands/toolgate.md`, `.opencode/command/toolgate.md`, `.agents/workflows/toolgate.md`,
  Codex only with `--user`, as `~/.codex/prompts/toolgate.md`) for the agents
  you name or the ones found on the PATH. `/toolgate review 123` makes the agent run `toolgate need "review 123"`:
  a first word that is the name of a command finds that command by name (even with a stale index) and the rest
  of the words are its arguments. The file carries a marker with its hash: one you edited is kept (`--force`
  regenerates it) and one toolgate did not generate is never overwritten, not even with `--force`.
  `toolgate init` offers to write it for the installed agents (one question, yes by default; `--yes` writes it and says so;
  Codex only gets the `--user` hint, init never writes your home folder). A file that is byte-identical to a text of an
  older toolgate is refreshed by `toolgate update`.
- `toolgate doctor` checks the commands too: the lock against the copies, and native commands toolgate does not manage.
- `.toolgate/commands.lock.json` records the source, commit and hash of each, apart from the skills lock, and the keys that were not kept (`dropped`) and the placeholders left as text (`unsupported`) when there are some; `install` and `import` print them too.
  The same rules apply as for skills: a command you already had, one from another source or a copy you
  edited is skipped unless you pass `--force`.
- A repository's commands are looked for in `commands/`, `.claude/commands/`, `.opencode/command/` or
  `.agents/commands/` (or `--path`); top-level markdown files are never commands. Folders join into the name
  (`git/commit.md` is `git-commit`). `--dialect <name>` says how the bodies are written (default `claude`).
- Names are at most 100 characters, and `Foo` and `foo` count as one. A repository folder that is a symlink
  leading outside the repository is refused, and a command that cannot be written is reported while the
  others are installed. The dialect is recorded in the lock next to the source.
- Configure other places with `commands.sources` (`toolgate config add commands.sources '{"dir":"cmds"}'`; a
  source can also say its `dialect`), which works like `skills.sources`; `commands.userLevel` and
  `commands.localLevel` are its project-level switches.

## Hosts a lock may name (`skills.allowedHosts`)
The skills lock (`.toolgate/skills.lock.json`) is a file of the repository, so a cloned repository could make `toolgate skills update` or `status --remote` contact a host it chooses. Resolvers, ssh and curl read many spellings of one address in different ways (octal or decimal leading zeros, hex, a single number, percent escapes, an IPv6 address with a dotted tail), so for sources read from a lock toolgate accepts only a host in a form nobody reads two ways: a DNS name whose last label has a letter (not `localhost`), an IPv4 address of four plain decimal numbers without leading zeros, or an IPv6 address in its canonical form (lowercase, no leading zeros, the longest run of zeros as `::`). An address that is loopback, private or link-local (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, or IPv6 that carries such an IPv4 address) is refused, and so is anything else, as "a host that resolvers read differently". ssh runs with `StrictHostKeyChecking=yes`, so a host that is not already in your `known_hosts` is never talked to. A source you type yourself is not checked. If you host skills on a private or unusual address, list the host exactly as written in the lock in your own config: `toolgate config add skills.allowedHosts <host> --user` (it counts in your user config, and in your local config only while git does not version that file; in the committed project file it is ignored, and `route` and `doctor` say so). A hostname that merely resolves to a private address is not detected.

## Where your task text is sent (`router.qmdUrl`)
`router.qmdUrl` points toolgate at a qmd daemon, so it decides where the text of your tasks goes. It counts only in your user config and your local config (when git does not version it; a local file that git tracks is ignored like the committed one): in the committed `.toolgate/config.json` it is ignored, and `route`, `need` and `doctor` say so. Set it with `toolgate config set router.qmdUrl <url> --user` (or `--local`). It must be an http or https URL with a host, or `null` (no daemon). A URL on this machine (`localhost`, `127.0.0.1`, `[::1]`) must name its port, because toolgate starts its daemon on that port while the router calls the URL as written: `http://localhost/mcp`, `http://localhost:80/mcp` (the default port counts as none) and port `0` are refused by `config set` with `router.qmdUrl on this machine must name its port, for example http://localhost:8181/mcp`, and written by hand they are ignored with that text as the warning. A remote URL needs no port; `toolgate config set router.qmdUrl file:///x` and any other value is refused with `router.qmdUrl must be an http or https URL, or null`, and one already written in a file is ignored with the warning `router.qmdUrl in the <layer> config is ignored: it must be an http or https URL, or null` (an earlier layer's valid value stays; `toolgate config unset router.qmdUrl` always works).

## Which qmd runs, and which port (`qmd.bin`, `qmd.port`)
The shared qmd daemon is managed with `toolgate daemon start | status | restart | stop`; the command is `toolgate daemon` (there is no `toolgate qmd`).
- **`qmd.bin`** is the program toolgate runs for every qmd call (daemon, route and `need` searches, skills, commands and subagents indexing, `init`, `doctor`): a command name without a `/` (looked up on the `PATH`, no spaces) or an absolute path, never a relative one. Without it toolgate runs `qmd` from the `PATH`, and the qmd that comes with toolgate when there is none. When it is set, even to `qmd`, the bundled qmd is not added to the `PATH`. It is run without a shell, so `$(id)` is a file name, not a command. It counts only in your user config and your local config (when git does not version it; a local file that git tracks is ignored like the committed one), like `router.qmdUrl`: a repository must not choose which program you run, so in the committed `.toolgate/config.json` it is ignored and `route`, `need` and `doctor` say so. `toolgate config set qmd.bin /path/to/qmd --user` (or `--local`); in the project layer, or with a relative path, `config set` refuses.
- **A launch starts the daemon.** `toolgate <agent>` (and `--adapter`, and `toolgate claude …` with the agent's name first), with or without a prompt, makes sure the shared daemon answers when the router backend is `qmd`, and starts it if it is down. So a daemon you stop with `toolgate daemon stop` is started again by the next launch that uses the qmd backend. To keep it off, launch with `--backend regex` or set `router.backend regex`. There is no key for this.
- **`qmd.port`** (a whole number from 1 to 65535) is the port of the daemon toolgate manages. Same layer rule as `qmd.bin`. The order is: `--port` (only `toolgate daemon`), then a local `router.qmdUrl`, then `QMD_SHARED_PORT`, then `qmd.port`, then 8181. With `router.qmdUrl` remote or `null`, toolgate manages no daemon for the router, and `toolgate daemon` without `--port` uses `QMD_SHARED_PORT`, then `qmd.port`, then 8181.
- **`toolgate init` and the port.** If the port is held by a process toolgate did not start, `init` does not touch it: it takes the next free port from 8182 up to 8281, says `toolgate: port <port> is held by pid <pid>, which toolgate did not start; using <free> and saving qmd.port in your user config`, saves `qmd.port` in your user config and starts the daemon there. In a terminal it asks first (`use port <free> and save it in your user config? [Y/n]`); `--yes` does it at once. Without a terminal and without `--yes`, or if you answer no, nothing is written or started and a note gives the two commands; `--dry-run` only says `would use port <free> and save qmd.port in your user config`. When the holder's pid cannot be told, or no port in that range is free, it is only a note. Closing the input (Ctrl+D) at that question counts as no, like Ctrl+C; every other question keeps Enter or Ctrl+D as its default. When the busy port comes from `QMD_SHARED_PORT`, a local `router.qmdUrl` that points at this machine, or `qmd.port` in an unversioned local config (all win over the user's `qmd.port`), `init` writes nothing, starts nothing and asks nothing, even with `--yes`: it leaves the note `toolgate: port <port> comes from <QMD_SHARED_PORT|router.qmdUrl|qmd.port in the local config> and is held by pid <pid>, which toolgate did not start; change it there (port <free> is free)` (`--dry-run` shows it as `would leave this note: ...`). With a remote `router.qmdUrl` (a URL that is not on this machine) `init` starts no daemon and skips the port step: it says `qmd daemon not started: router.qmdUrl points to <origin>, which toolgate does not manage`, where `<origin>` is only the scheme, host and port (never credentials, path or query); `--dry-run` says `would not start the qmd daemon: ...`.
- **When qmd is upgraded.** A daemon toolgate started leaves a small file, `$XDG_STATE_HOME/toolgate/daemon-<port>.json` (`~/.local/state/toolgate/daemon-<port>.json` without `XDG_STATE_HOME`), with its pid, the version of qmd that started it, the port and the time. Every time toolgate makes sure the daemon is up (launch, `toolgate daemon start`, `init`) it compares that version with the installed one; if they differ it prints `toolgate: qmd changed from <old> to <new>; restarting the qmd daemon` and restarts it. The file counts only while its pid is a process holding the port; otherwise it is discarded and nothing is restarted, and a daemon toolgate did not start is never touched. `toolgate daemon status` adds ` (pid <pid>, qmd <version>, started <time>)` for a daemon it started, and `toolgate daemon stop` removes the file.
## MCP server catalog
`toolgate catalog build [--server <name>] [--dry-run] [--json]` starts each configured MCP server one at a time, lists its tools and writes one markdown file per server to `.toolgate/catalog/servers/` (`router.catalogPath` changes it; it must stay inside the project), with the front matter of SPEC §7.1 and a section per tool, so qmd can index it.
- **Starting a server runs a program.** Servers of your own agent config (`~/.claude.json`) run without asking. A server from the `.mcp.json` of a repository runs only after you type `yes` for that exact command (shown whole, with the names of its environment variables, never their values); the approval is kept on this machine and asked again if the definition changes. `--yes`, CI, no terminal, `--force` and `--dry-run` never approve: the server is skipped and the exit code is 2.
- Each server gets 20 seconds, runs with only the environment variables its definition declares (plus `PATH` and `HOME`), and is stopped together with everything it started. A server that needs OAuth is skipped, never logged in.
- What a server returns is untrusted: names that are not plain are left out, descriptions are one clean line, and nothing is written outside the catalog folder or over a file toolgate did not write.
- A `whenToUse` you write by hand in a catalog file is kept when you build again; the ones toolgate generated (`whenToUseGenerated: true`) are rewritten.
- **`route` and `need` use the catalog.** Once you have built one, a task that matches what a server's tools do (their name, description and the `whenToUse` you wrote) brings that server in, after the ones your bindings, skills and keywords chose, and `need` says which tools matched. A text toolgate generated weighs nothing: only your own `whenToUse`, the tool name and the description are searched. The catalog is text written by the servers, so it can add at most `router.catalogMaxServers` servers (default 3; `0` turns it off), counts a server once, never touches the baseline, and is skipped when a mandatory binding matched. Entries for servers that are no longer configured are ignored and said, and so is a catalog older than your server definitions. A project that never built a catalog sees no change. `toolgate doctor` checks the same things (warnings only).
- **Servers are found by words, not by meaning (yet).** The qmd daemon scores a search by the rank of each document (1, 0.5, 0.33, ...) whatever the task, so it cannot tell a relevant server from an irrelevant one: measured on catalogs of 2, 5 and 20 servers, it admitted two servers for every task, including "bake a chocolate cake". `route` and `need` therefore match the catalog by the words of the task only, with the `regex` and the `qmd` backend alike, and `catalog build` does not index the folder in qmd. A search by meaning will come back with a real similarity threshold (#157).

## Hooks

A hook runs a command on your machine when the agent does something (before a tool, at the end of a turn...). toolgate keeps hooks like skills (a store, a lock, three levels), but **nothing is applied until you approve its exact content on this machine**: a hook that arrives in a repository, from a teammate or from an agent is never an approval.

```bash
toolgate hooks install github:owner/repo [name...]   # shows what would run and asks once
toolgate hooks update                                # new content waits for a new approval
toolgate hooks review                                # approve what arrived with a pull
toolgate hooks status [--check]  /  list             # approved or pending review, per level
toolgate hooks remove <name>                         # the unit and its approval go
```

- A hook is a folder with `HOOK.json` and the scripts it runs. Only commands in exec form are accepted (`command` and `args`, no shell): the command is a bare program name or a file of the unit, no `..`, absolute path, link, placeholder or variable (`$NAME`, `${..}`, `%NAME%`). Other handler types and keys are dropped and listed.
- The confirmation prints every handler with its command and arguments verbatim, then the text of every file of the unit (a long one is cut after 60 lines, with its size and sha256), and on `update` a diff against the copy you approved, so a change only in a script is visible. It asks for a typed `yes` in a terminal. With `--yes`, in CI or without a terminal nothing is approved and nothing is written: the command exits 2 ("waiting for review"). `--force` and `--dry-run` never approve.
- The approval is asked **once**, when the hook is first seen, and holds while its content does not change (`approvals.json` in the toolgate config folder, private to you, never in the repository). A change of content, including a script, asks again; removing a hook upstream does not remove it here by itself.
- The same name at two levels is an error: a hook never hides another. `hooks.userLevel` / `hooks.localLevel` set to false in the project config switch those levels off.
- `toolgate hooks import [--user | --local]` brings the hooks you already have in Claude Code's `settings.json` (`settings.local.json` with `--local`, `~/.claude/settings.json` with `--user`) under toolgate as one unit at that level (`native-claude`, `native-claude-local` or `native-claude-user`), and it goes through the same confirmation and approval. Only `command` hooks in exec form (`command` and `args`) are imported; a shell-form one is skipped with "rewrite it as command and args". A script is copied into the unit only if it is a plain file (not a link) inside the project (inside your home for `--user`); any other handler is skipped with its reason. Your Claude settings are never edited: the originals keep running, so until you remove them from there they run twice.
- **Your own Claude Code settings.** `toolgate doctor` warns (under `claude.settings` and `mcp.strayPins`) when `~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json` holds something that changes what toolgate prepares, and names the file: a server in `disabledMcpjsonServers` that is in `.mcp.json` (Claude Code rejects it even when toolgate activates it, because a disable in any file wins; a launch says so for each active one); an `enabledMcpjsonServers` pin (it enables those servers without asking, a disable in any file overrides it, and with `--strict-mcp-config` nothing loads; interactive approval was not verified); a `permissions.deny` or `ask` rule that matches `toolgate need` (a `Bash` rule with no pattern, `*`, or a pattern such as `toolgate:*` or `tool*`), which blocks or prompts before the Step 0 command; and an `env` entry named `TOOLGATE_*` or `QMD_SHARED_PORT`, which replaces the value toolgate passes at launch (verified for MCP servers, assumed for Bash commands). The list is short on purpose, and toolgate never changes these files.
- `toolgate hooks status --effective [--agent <name>] [--json] [--check]` shows, per agent, exactly which hooks the next launch passes (`passes:`), which are held back because they are not approved on this machine or changed since (`held back:`), and that agents with no hook support pass nothing. It writes nothing. `toolgate doctor` checks the stores against their locks, hooks waiting for review, and agents that cannot apply them.
- At launch, Claude Code gets the approved hooks in the `--settings` file of that session (nothing is written to its own settings). Each hook script runs from a private copy made for the launch, checked against the approved hash and removed when the agent ends, so a file changed after the check is never run. A hook that is not approved, or changed since, is left out and the launch says so (`toolgate hooks review`). If you or your organisation set `disableAllHooks` or `allowManagedHooksOnly`, Claude Code does not run them and toolgate does not try to override that. Your own `--settings` keeps its hooks and permissions: they are combined with toolgate's, yours first. opencode has no hooks, only plugins, so none are applied there.

## Permissions

A permission unit is one JSON file of rules in Claude Code syntax: `deny` and `ask` only narrow what the agent may do; `allow` is a **grant** and stays inactive until you opt in.

```bash
toolgate permissions install github:owner/repo [name...] [--grant]   # shows the rules and asks once
toolgate permissions update | status | list | review [--grant] | remove <name>
```

- Same approval as for hooks: nothing is applied until you approve the exact content on this machine (a typed `yes` in a terminal; with `--yes`, in CI or without a terminal nothing changes and the exit code is 2), asked once and kept while the content does not change. A removed `deny` is shown as a removal and waits like any other change.
- `allow` rules need a second, separate `yes` with `--grant` (on `install` or `review`; `update` and `import` refuse the flag, because a grant is never given from an update or an import). Without it they are stored and listed as "not granted" and nothing passes them on. The grant is kept for the allow rules alone: a change in `deny` or `ask` keeps it, a change in `allow` asks again. Rules that open a whole tool or server (`Bash`, `Bash(*)`, `Bash()`, `mcp__github`) are marked **BROAD** in the confirmation of the unit and in the grant question, which has its own wording ("Grant these allow rules of ...? Type yes to grant"); `status` and `list --json` show only whether the allow rules are granted, not the rules.
- `defaultMode`, `additionalDirectories` and anything else that can widen access are dropped and listed. `mcp__` rules take no parentheses. The same name at two levels is an error.
- At launch, Claude Code gets the `deny` and `ask` rules of every unit (they only narrow, so they need no approval) and the `allow` rules of the units that are approved **and** granted, in the same `--settings` file. Rules that are held back are named in one line. Claude Code combines the lists with your own settings, it does not replace them. opencode gets the same rules as an inline config in `OPENCODE_CONFIG_CONTENT` (it outranks the project's `opencode.json`; `OPENCODE_CONFIG` would not). The mapping is partial and what does not map is named at launch, never dropped: `deny` and `ask` rules on paths and domains become wider patterns (that only narrows); `allow` rules are applied only where opencode can express them exactly (`Bash(...)`, a whole tool), and never for a tool that has a restriction opencode cannot write; the `Bash(cmd:*)` prefix form becomes two patterns (`cmd` and `cmd *`); `mcp__` rules and other tools have no verified equivalent. Because opencode lets the last matching pattern win, toolgate merges its patterns with yours so that **nothing it adds loosens what you wrote**: its allow entries go first (your own rules win over them), its ask entries after your allow entries but before your deny entries, its deny entries last. A plain string such as `bash: "deny"` (or `permission: "deny"` as a whole) in your config is kept as the pattern `*`. Your own `OPENCODE_CONFIG_CONTENT` is merged; one that is not JSON is left alone.
- `toolgate permissions import [--user | --local]` does the same for the `permissions` of Claude Code's settings: one unit named like that, same approval; `allow` rules stay ungranted until `toolgate permissions review --grant` (`import --grant` is refused). Invalid rules are skipped with the reason, `defaultMode`, `additionalDirectories` and other keys are not kept and are listed, and the original settings are not changed and keep applying.
- `toolgate permissions status --effective [--agent <name>] [--json] [--check]` shows the `deny`, `ask` and granted `allow` rules each agent gets; for opencode, the `OPENCODE_CONFIG_CONTENT` it is given and the rules it `cannot express` (a deny that is not applied is flagged `DENY NOT APPLIED`). `--check` exits 2 if something is held back or a deny/ask rule cannot be applied. `toolgate doctor` reports the same, plus allow rules not yet granted.

## Subagents

A subagent is a prompt plus the tools it may use; the agent obeys it with its own permissions. toolgate manages them like skills and commands (a store, a lock, three levels) with the least privilege:

```bash
toolgate subagents install github:owner/repo      # copies them to .toolgate/subagents/
toolgate subagents list                           # name, level, the tools each one gets, path
toolgate subagents status [--remote] [--check]    # copies against the lock (and upstream)
toolgate subagents update [name...] [--dry-run]   # move installed subagents to their upstream
toolgate subagents import [--path dir] [--dialect d]  # bring .claude/agents etc. under toolgate
```

- Only what describes a subagent is kept: `name`, `description`, `tools`, `model`, `tags`, `mcps` and the prompt. `hooks`, `permissionMode`, inline `mcpServers`, `skills`, `color` and anything unknown are dropped and listed.
- A subagent gets the tools its definition lists, never more. A definition with no `tools` does **not** inherit the agent's tools: it gets the read-only default `Read, Grep, Glob`, and the copy says so (`tools-default: true`). An empty `tools` is refused. `install` and `import` say which subagents fell back to the default, and `status`, `list` and `toolgate doctor` show the tools each one really gets (marked `(default)` when they are the default).
- Dialects: `claude` (`.claude/agents/*.md`, the default) and `opencode` (`.opencode/agents/*.md`, `--dialect opencode`). `--user` and `--local` pick the level as for commands; `import` leaves out symlinked folders and folders that resolve outside the project.
- Subagents are indexed with the skills and the commands (`toolgate subagents index` is `toolgate skills index`, `toolgate subagents search` and `toolgate skills search --kind subagent` look only among them); their cards live in `subagents/` of the corpus, so a subagent, a command and a skill can share a name. `route` and `toolgate need` return them in their own `subagents` array (`name`, `path`, `tools`, `toolsDefault`) and the servers they list are asked for like any other asset's. `need` prints `subagent <name>: not registered in this session (tools it would get: ...)`: the Step 0 rule has an item for it, and the active subagents are registered in the agent at launch. The active set is `subagents.baseline` (a list of names in the config), the subagents `route` finds for the launch prompt, and the ones `toolgate need` recorded for the next launch (the same pending restart as for servers); nothing is registered when the set is empty. Claude Code gets them with `--agents` for that session only (nothing is written; your own `--agents` JSON is merged, yours win on a name clash, and one that is a file is left alone), opencode gets marked files in `.opencode/agents/` that are removed when the session ends (a file of yours is never touched). Each one gets only its tools (the read-only default when none are listed), the servers it needs, and a fixed line asking it to end its answer with `NEEDS: <tool or server> - <reason>` when it lacks something, so the agent that invoked it can ask you.

## 4. Check it works

```bash
toolgate doctor
```

It lists what is installed, what is misconfigured and how to fix it; it exits 1 when something is an error
(`--json` for scripts). To see what a task would load:

```bash
toolgate route --prompt "quiero hacer TDD de la funcion de descuentos"
```

```json
{
  "servers": [],
  "missing": [],
  "skills": [
    { "name": "test-driven-development", "path": "/…/.toolgate/skills/test-driven-development/SKILL.md", "level": "project", "score": 0.5, … }
  ],
  "warnings": []
}
```

- `skills` are the matches, best first; the agent reads `skills[0].path` and follows it.
- `commands` has the same shape for commands, kept apart from `skills`: a skill and a command can both match.
  A command is a file to read, not something registered in the agent; the agent reads `commands[0].path` and
  follows it, taking the user's own words as its arguments. An entry may carry `argumentHint` (one line, at most
  120 characters, text from the command's file). The list is empty when a mandatory binding decided the route,
  with the `regex` backend, and while the index predates commands: run `toolgate skills index` once so
  commands appear.
- `toolgate need` lists them as `command <name>: read <path> and follow it`, and its `--json` has a `commands`
  array with `name`, `path`, `argumentHint`, `score` and `excerpt`. When toolgate launches the agent with a prompt
  it adds a second hint line for the commands, next to the one for skills.
- The Step 0 rule that `toolgate init` writes covers commands: item 3 says to read `commands[0].path` and follow it
  only when the user named the command (`/<name>`) or the task is exactly that command; it is independent of the
  skill item, so one task can load a skill and a command. `toolgate init` never overwrites a rule that differs: for one written before commands existed it says so;
  delete the file and run `toolgate init` again to get the new item.
- `servers` are MCP servers the task needs that the agent has configured; `missing` are the ones it does not
  have; `warnings` reports a problem with toolgate's own results (see [Troubleshooting](#troubleshooting)).
- `toolgate skills search "<text>"` lists matches without the rest, and `toolgate config print` shows the
  resolved configuration and which layer each key came from.

## 5. Use it with Claude Code

Open Claude Code in the project and give it a task. Because of the Step 0 rule it first runs
`toolgate route --prompt "<your task>"`, reads the skill it returns, and follows it. To check it is loaded,
ask Claude Code whether it has an instruction about `toolgate route`.

## Configuration

Config comes in layers, lowest priority first:

| Layer | File | Use |
| --- | --- | --- |
| user | `~/.config/toolgate/config.json` (or `$TOOLGATE_DEFAULTS`) | your own defaults and personal skills |
| project | `.toolgate/config.json` | shared with the team, committed |
| local | `.toolgate/config.local.json` | your own trials in this project, git-ignored |

Edit them with commands instead of by hand. Only keys toolgate manages are accepted, so a typo is refused:

```bash
toolgate config set router.backend qmd
toolgate config add skills.sources '{"dir":"team-skills"}'
toolgate config remove skills.sources '{"dir":"team-skills"}'
toolgate config unset router.minScore
toolgate config set router.minScore 0.6 --local      # --user and --local choose the layer
```

Skills follow the layers too: the project's, your user-level ones and your local trials all feed one index.
On a name clash local wins over project over user, `route` reports each skill's `level`, and a project that
wants a uniform stack sets `skills.userLevel` and `skills.localLevel` to `false` in its own config.
Commands (prompt templates) use the same layers through a `commands` block (`commands.sources`,
`commands.userLevel`, `commands.localLevel`); they are indexed with the skills and found with
`toolgate skills search "<text>" --kind command`.

## Govern user-level MCP servers (Claude Code)

By default toolgate only gates the servers of the project's `.mcp.json`; the ones in your `~/.claude.json`
always load and keep costing context. To route them too, opt in:

```bash
toolgate config set client.exclusiveMcp true --local
```

Each launch then writes a private temporary MCP config with exactly the active servers (project and user-level
ones, resolved through the same baseline, keywords, skill `mcps` and escalations) and starts Claude Code with
`--strict-mcp-config`. The file is removed when Claude exits, and the launch prints which servers it left out.
Plugin and claude.ai connector servers do not live in those files, so they are not loaded either; a server
that is active but defined in no config file is reported as not loaded. Claude Code's built-in tools are
unaffected. Other agents degrade to the project-level gating (see [ADAPTERS](ADAPTERS.md)).

Codex runs on your own Codex home (`CODEX_HOME`, else `~/.codex`): toolgate sets nothing there and writes no Codex file. For that launch only it passes `-c mcp_servers.<name>.enabled=false` for each server your `config.toml` defines with a `[mcp_servers.NAME]` header (that is the only form toolgate reads; `[[mcp_servers.NAME]]`, inline tables and dotted keys are left as Codex loads them) that is not active, and `-c mcp_servers.<name>.enabled_tools=[...]` for an active one with a tool baseline, before its own rule arguments and yours, so a `-c` of yours wins. Servers that only a project's `.codex/config.toml` defines, servers whose names contain a character other than letters, digits, `-` and `_` (Codex cannot address them from the command line; toolgate says so once), and active servers your config does not define are left as Codex loads them.

## Day to day

```bash
toolgate skills update --dry-run   # what changed upstream, file by file; then `toolgate skills update`
toolgate skills index                                    # after adding or editing skills by hand
toolgate update [--dry-run] [--yes]                      # after you update toolgate itself: the migrations this version needs
toolgate daemon start | status | restart | stop           # the shared qmd daemon
```
`toolgate update` does not update the package (from a clone: `git pull`, `npm install`, `npm install -g ./packages/toolgate`). It runs the migrations the installed version needs. (1) It replaces `.rulesync/rules/toolgate-router.md` with this version's Step 0 rule, only when the file is byte-identical to a text toolgate has shipped (an edited rule stays, with a note); the same for the `/toolgate` command files. (2) In the project's `.mcp.json` and in your `~/.claude.json` it renames the old `UPSTREAM_CMD`, `UPSTREAM_ARGS` and `ALLOWED_TOOLS` keys of the entries `toolgate-proxy` wraps to their `TOOLGATE_*` names, in place and with nothing else changed; it does that only when rewriting the file leaves everything else byte for byte as it is (otherwise it says what to rename by hand), it does not write a file that is a link or that git ignores because rulesync generates it (it names the entry and the source to edit instead), and `--json` lists each rename as `{ file, server, renamed }`. A file git versions changes only with `--yes` or an answer in a terminal; `~/.claude.json` is Claude Code's own file, so it needs the same explicit yes, and you should close running Claude Code sessions first because they rewrite it. If the file changes while `toolgate update` runs, nothing is written and it says to run it again. `.toolgate/config.json` is never touched, `--dry-run` writes nothing, and it is safe to run twice. Run `rulesync generate` afterwards.

## Working in a git worktree
A git worktree is its own project for toolgate. Its branch may carry other skills, so it has its own skills index and its own qmd collection, and neither is shared with the main checkout. The index (`.toolgate/skills-index/`) and the rules that `rulesync` generates are git-ignored, so a new worktree starts without them. After `git worktree add`, run these once in the new worktree:
```bash
npx rulesync generate     # the generated Step 0 rule the agent reads (.claude/rules/toolgate-router.md and the like)
toolgate skills index     # the skills index of this checkout
```
`toolgate init` indexes the skills too, but it only tells you to run `rulesync generate`. Local skills (`.toolgate/skills.local/`) are not copied from the main checkout: they stay with the checkout they were made in.
Until you do, `toolgate need` and `toolgate route` (qmd backend) find no skills and say `skills are not indexed in this checkout; run toolgate skills index`. `toolgate doctor` reports `skills exist but are not indexed in this checkout` (fix: `toolgate skills index`) and, for each `rulesync.jsonc` target whose rule file is missing, `the Step 0 rule was not generated for <target> (.rulesync source found)` (fix: `npx rulesync generate`). The same two warnings appear in any checkout that has skills but no index, worktree or not.

## Missing servers

A skill can declare the MCP servers it needs with `mcps`. When the agent has not configured one, `route`
returns it under `missing`, and the Step 0 rule has the agent say so and ask before installing anything.
toolgate never edits your MCP configuration. It only knows about servers in the agent's config file
(`.mcp.json` for Claude Code), so one configured elsewhere may be reported as missing: the agent checks its
own tool list first.

## Optional: trim a heavy MCP server's tools

Everything above is about skills. If you also have an MCP server with many tools, `toolgate-proxy` can sit
in front of it and advertise only the tools you list, so the rest never reach the agent's context. It is a
separate package, so install it on its own:

```bash
npm install -g ./packages/toolgate-proxy       # from the clone; puts `toolgate-proxy` on your PATH
```

Point the server's launch command at the proxy in `.mcp.json`, and put the real server in `TOOLGATE_UPSTREAM_*`:

```json
{
  "mcpServers": {
    "repo": {
      "command": "toolgate-proxy",
      "env": {
        "TOOLGATE_UPSTREAM_CMD": "npx",
        "TOOLGATE_UPSTREAM_ARGS": "[\"-y\", \"@acme/repo-mcp\"]",
        "TOOLGATE_ALLOWED_TOOLS": "${TOOLGATE_REPO_TOOLS:-}"
      }
    }
  }
}
```

The proxy reads only the `TOOLGATE_*` names. An entry that still has `UPSTREAM_CMD`, `UPSTREAM_ARGS` or `ALLOWED_TOOLS` without the new name makes the proxy print `toolgate-proxy: <OLD> was renamed to <NEW>; run toolgate update` and exit 1, so a renamed allow list never silently fails open.

List the tools to keep in the config, and launch through toolgate so it exports the value
(`TOOLGATE_<SERVER>_TOOLS`, with the server name upper-cased):

```bash
toolgate config add toolBaselines.repo listPRs
toolgate config add toolBaselines.repo getPR
toolgate "review this pull request"
toolgate escalate repo mergePullRequest         # bring one back: it is present on the next launch
# From inside a session, the agent runs `toolgate need "<task>"` instead: it escalates what the task needs.
```

## Reveal tools without a restart
With Claude Code or opencode, a server behind `toolgate-proxy` can start a session showing only the tools it needs, and show more of its tools in the
same session, with no restart. The agent loads the names of a server's tools and its instructions at the start; this keeps the ones you did
not ask for out of that first load.

It works when toolgate launches the agent (`toolgate "<task>"`, with opencode as the default agent or `--adapter opencode`; or `toolgate claude` for Claude Code) and an active server is wrapped by the proxy. Wrap it
as above, and give the proxy the name of the server and the session file toolgate makes:
```json
{
  "mcpServers": {
    "repo": {
      "command": "toolgate-proxy",
      "env": {
        "TOOLGATE_UPSTREAM_CMD": "npx",
        "TOOLGATE_UPSTREAM_ARGS": "[\"-y\", \"@acme/repo-mcp\"]",
        "TOOLGATE_ALLOWED_TOOLS": "${TOOLGATE_REPO_TOOLS:-}",
        "TOOLGATE_SERVER": "repo",
        "TOOLGATE_SESSION_STATE": "${TOOLGATE_SESSION_STATE:-}"
      }
    }
  }
}
```
In opencode the server is defined in `opencode.json` (or `opencode.jsonc`) with `type: "local"`, `command` as a list and `environment`:
```json
{
  "mcp": {
    "repo": {
      "type": "local",
      "command": ["toolgate-proxy"],
      "environment": {
        "TOOLGATE_UPSTREAM_CMD": "npx",
        "TOOLGATE_UPSTREAM_ARGS": "[\"-y\", \"@acme/repo-mcp\"]",
        "TOOLGATE_SERVER": "repo"
      }
    }
  }
}
```
opencode passes its own environment to a local server, so the session file reaches the proxy without listing `TOOLGATE_SESSION_STATE`.
opencode names a server's tools `<server>_<tool>` (`repo_list_issues`); `toolgate tools enable` and `need` take the server's own tool name (`list_issues`).
toolgate reads these files, the last one that names a server winning (the order was measured with opencode 1.18.4): `$XDG_CONFIG_HOME/opencode/opencode.json(c)`
(`~/.config/opencode` without it), the file `OPENCODE_CONFIG` names, the project's `opencode.json(c)`, and `~/.opencode/opencode.json(c)`. A file that is a symbolic
link is never followed, so what it defines is not seen and its servers are revealed only by a restart; `toolgate doctor` names such a file.

`TOOLGATE_SESSION_STATE` is inherited from the launcher's environment (Claude Code passes it to the server even if the entry does not list it, so listing it is optional; the entry above does it with `${...:-}` to make the empty default explicit). It is empty outside a toolgate launch, and then the proxy is the static one of the section above. In a launch,
toolgate writes a small file for the session in `$XDG_STATE_HOME/toolgate/sessions/` (`~/.local/state/toolgate/sessions/` without it; the folder
is mode 700, the file 600, and both are the user's own) and removes it when the agent ends. A new session starts from nothing revealed; a
relaunch toolgate makes itself (after an escalation) keeps what was revealed. A file a crash left behind is swept after seven days.

What the agent sees of a server in the session is its `toolBaselines` tools plus what was revealed. When that is empty it sees one tool,
`toolgate_status`, which the proxy answers itself (it never goes to the server): it lists the server's other tools and how to make them
available. The server's own instructions are then kept out of Claude Code's first load too, and come with the first tools you reveal. Then:

- `toolgate need "<task>"` reveals the tools the catalog matched for the task, for servers active in the session. The entry says `revealed`
  (with `tools`, and `instructions` the first time) or `dormant` (nothing matched: `available` lists what the server's card knows and
  `hint` says how to enable one: replace its `<tool>` with one of `available`). A server that is not active is still `restart-required`, and `need` records the tools it matched so the
  relaunch already offers them.
- `toolgate tools enable <server> <tool…>`, `disable <server> [tool...]`, `status [server] [--json]` and `reset [server]` change it by hand. A tool
  of `toolBaselines` always stays. `disable` and `reset` only stop a tool from being offered: one already used stays in the conversation.
- `toolgate doctor` warns about each server in `.mcp.json` (and in opencode's config, when opencode is installed) that the proxy does not wrap, or wraps without `TOOLGATE_SERVER` set to the server's name (its tools cannot be revealed without a restart; `need` says `restart-required` for it, and the launcher leaves it out of the session), and
  errors on an entry that still uses the old `UPSTREAM_CMD`, `UPSTREAM_ARGS` or `ALLOWED_TOOLS` names (`toolgate update` renames them).

Known limits:
- **Hiding is not a security boundary.** A tool that is not offered can still be called by a client that knows its name; the proxy only
  filters `tools/list`. What an agent may do is decided by permissions (`toolgate permissions`), not by what is offered.
- Only Claude Code (verified with 2.1.304) and opencode (verified live with 1.18.4) support it (an adapter with `dynamicTools: true`). Other agents keep `restart-required` and are told once.
- For opencode, not verified: whether a file that defines only part of a server (say only `environment`) is merged key by key with an earlier one or replaces it (toolgate takes the server whole from the last file that names it, and reads one that is not well formed as not there); `.opencode/opencode.json` inside the project; and the folders above the project up to the git root. The live check used a server with no tool baseline (only `toolgate_status` was offered).
- The folder of the session files is worked out from the proxy's own `XDG_STATE_HOME` and `HOME`. A `.mcp.json` of a repository can set them
  for its own servers, as it already chooses the command it runs; the proxy still checks that the file is a plain file of the user's, closed
  to others, inside that folder, with a session's name.
- Two toolgate commands changing the session at the same moment take turns on a lock file. The lock is best-effort: a crash that leaves a
  lock more than ten seconds old, and two writers breaking it together, or a process stopped for ten seconds, can lose one change.
- Two servers whose names differ only in case share one instructions file on a filesystem that does not tell the cases apart (macOS and
  Windows by default).
- When the offered set is empty and the client never asks for the last page of a paged `tools/list`, the sentinel is not shown (it is on the
  last page only); the status keeps at most 2,000 tools over 50 pages and says when it left some out.
- `list_changed` is sent once per real change and is not rate limited; a batch of requests is passed through without looking inside it.

With no allow-list the proxy passes every tool through, so a mistake never breaks the server. The proxy and
this loop (filter, escalate, restart, fail-open) are covered by tests against a fake server (`npm run
test:e2e`). The `${VAR:-default}` expansion in an `env` was checked by hand with Claude Code 2.1.304
(a defined variable gives its value, an undefined one the default); confirm that the server shows only the tools you listed. The proxy contract is in [`DESIGN.md`](DESIGN.md).

## Running a prompt
With a default agent set (`toolgate init` does it), the shortest form is `toolgate "<prompt>"`: it opens the agent
with the prompt as its first message. `toolgate --yes "<prompt>"` takes every default and runs it without the
agent's interface, printing the result: `claude -p`, `codex exec`, `opencode run`, `agy --print=<prompt>` (karajan
already runs once). `--quiet` (`-q`) does not print the agent's output; toolgate's own notes and the agent's errors
still appear, and the exit code is the agent's either way. Flags toolgate does not know go to the agent as they are
(`toolgate --yes -p "<prompt>"`), and so does everything after `--` (`toolgate "<prompt>" -- --model x`); a flag of
the agent that takes a value belongs after `--`. `toolgate claude ...` (an agent name first) stays raw.
Claude's `--resume`/`-r` (and `--from-pr`, `--teleport`) take an optional value, and toolgate reads it as Claude does: the word after it is its value unless it starts with `-`. So `toolgate --resume <id> "<task>"` resumes that session and routes the task, while `toolgate --resume "<text>"` passes the text to Claude as its search term and routes nothing. toolgate never rewrites these arguments.
## Troubleshooting

- **`route` returns nothing, or only some skills.** Run `toolgate skills index`. If `warnings` says the qmd
  daemon serves fewer documents than the corpus, run `toolgate daemon restart`; `skills index`,
  `skills install` and `init` do this on their own when they notice.
- **`route` or `need` warns that cards are unreadable.** After an upgrade the cards of the index may be of an
  older format, which is refused instead of guessed at. Run `toolgate skills index` once; `toolgate doctor`
  reports it as `skills.cardFormat`.
- **"not indexed yet" after installing.** The first index loads the search models and can take a while;
  run `toolgate skills index` again.
- **The agent never runs `toolgate route`.** The rule is not loaded: check that
  you ran `rulesync generate` (the rule is in `.rulesync/rules/toolgate-router.md`) and that your agent is one of the `targets` of `rulesync.jsonc`; then restart the session.
- **Installed skills are not indexed.** If your project sets its own `skills.sources`, add the folder:
  `toolgate config add skills.sources '{"dir":".toolgate/skills"}'`.
- **No `qmd`.** On Node 20 or 21 the optional dependency is skipped and a global `qmd` needs Node 22 too. `init` still
  writes `router.backend: qmd`, says qmd is missing and how to get it (a newer Node, or `npm install -g @tobilu/qmd`);
  until then skills are searched by keywords. To not use qmd at all: `toolgate init --backend regex`.

## Where to go next

- [`qmd-integration.md`](qmd-integration.md): the daemon, the index and how skills are found.
- [`DESIGN.md`](DESIGN.md) and [`ADAPTERS.md`](ADAPTERS.md): architecture, the config schema and agent adapters.
- [`ROADMAP.md`](ROADMAP.md): what is next.
