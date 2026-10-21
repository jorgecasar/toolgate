# Spec: Formal adapter contract, wrapper and new adapters (issue #11)

Status: approved; `contract` in progress.

Decisions: `karajan` is registered (not removed); a bare `toolgate "<prompt>"` has no fallback: the
agent comes from `defaultAgent` in the user, project or local config (or `--adapter`/`TOOLGATE_ADAPTER`)
and it is an error when none is set; `generic` uses fixed formats (`json-mcpServers`,
`toml-mcp_servers`); delivery is one PR per module. Development follows the `/build auto` loop:
approved plan, test-first tasks, a commit per task, pause on failure or risk.

## Capability map

Issue #11 bundles several independently testable capabilities, so it is split into modules. Ids are stable.

| Module id | Responsibility | Depends on |
|---|---|---|
| `contract` | Capability schema, adapter contract, registry with registration-time validation, contract tests, `docs/ADAPTERS.md` | none |
| `wrapper` | `toolgate <agent> [args…]` passthrough, prompt extraction, exit code and signals, `supportsResume` (Claude Code first) | `contract` |
| `adapters` | `karajan` decision, `opencode`, `generic` | `contract` |
| `reporting` | Tier per detected agent in `init`/`doctor`, `init` writes the Step 0 rule per `rules` capability | `contract` |

Build order: `contract` → `wrapper`, `adapters` (parallel) → `reporting`.
`doctor` (#20) is shipped: it reuses the shared tier function that `init` uses.

## Objective

Any agent CLI can be wrapped by toolgate, to the degree its capabilities allow, and toolgate states plainly what it cannot do. Today the adapter contract is informal: `cli.js` has a hard-coded map, `karajan` is unreachable, and `toolgate --resume` launches Claude with the prompt `--resume`. Success is a single validated registry, capability-checked features, and a drop-in `toolgate claude …`.

Users: people running `alias claude='toolgate claude'`; authors of new adapters.

## Assumptions (correct me now)

1. Capabilities are declared as a frozen object exported as `capability`, extending the existing `{ defersToolSchemas }`.
2. Missing capability degrades a feature and prints what to do by hand; it never fails the launch.
3. The registry keeps lazy `import()` loaders, validating on first load plus a cheap static check of declared names at registration.
4. `opencode` details (config paths, flags) are not known yet. They are researched from official docs during implementation and marked "unknown" in the matrix where unverified, never guessed.
5. `generic` is configured under a `adapters.generic.<name>` key in the existing toolgate config layers.
6. Existing `--adapter <name>` stays working; `toolgate <agent>` is the new primary form.

## Tech stack

Node >= 20.6, ESM, `node:test`, ESLint 9. No new dependencies.

## Commands

```
Test:   npm test
Lint:   npm run lint
Build:  npm run build
E2E:    npm run test:e2e
```

## Project structure

```
packages/toolgate/src/adapters/         → one file per adapter
packages/toolgate/src/adapters/index.js → registry + validateAdapter (new)
packages/toolgate/src/capability.js     → extended capability schema + tier computation
packages/toolgate/src/wrapper.js        → arg passthrough and prompt extraction (new)
packages/toolgate/test/adapters/        → per-adapter tests + contract.test.js (new)
docs/ADAPTERS.md                        → contract, capability list, matrix
```

## Contract

Adapter module exports:

| Export | Contract |
|---|---|
| `capability` | frozen object, see below |
| `readServers(cwd)` | server names configured for the agent |
| `applyServers(activeSet)` | make exactly this set active (flag, file or override), per `launchGating` |
| `installDiscovery(ctx)` | inject the Step 0 rule/skills per `rules`; no-op when `none` |
| `buildToolEnv(config, state, active)` | env for the proxies |
| `launch(args, { resume })` | start the agent, resolves `{ code, signal, … }` |
| `supportsResume` | boolean; with `capability.resume.arg` |

Capability fields: `rules` (`none` | `projectFile{path}` | `launchInjection`), `launchGating` (`none` | `settingsFlag` | `configFile` | `flagOverrides`), `exclusiveMcpConfig`, `resume` (`{ supported, arg }`), `dynamicTools`, `defersToolSchemas`, `passthrough`.

Tiers: 1 skills on demand (`rules`), 2 servers at launch (`launchGating`), 3 automatic restart (`resume`), 4 mid-session reveal (`dynamicTools`). Each includes the previous.

Registry rejects, at registration: missing exports, unknown capability values, `resume.supported` without `arg`, `rules: projectFile` without a path, non-frozen or unknown capability keys. Error names the adapter and the field.

## Code style

```js
export const capability = Object.freeze({
  defersToolSchemas: true,
  rules: { kind: "projectFile", path: ".claude/rules/toolgate-router.md" },
  launchGating: "settingsFlag",
  resume: { supported: true, arg: "--continue" },
});
```

Double quotes, semicolons, 2 spaces, trailing commas, injected deps (`spawnFn`, `readFileFn`) as in current adapters.

## Testing strategy

- `contract.test.js` runs the same assertions over every registered adapter: required exports, capability validity, `launch` honors `{resume}`, `buildToolEnv` is pure.
- Registry tests: each invalid-capability case above fails with a readable message.
- Wrapper tests with a fake agent binary that records argv: flags before the agent name are toolgate's; everything after is untouched; `--resume`, `--model haiku "hi"`, `mcp`, `doctor`, `update` forwarded verbatim; ambiguous prompt gives baseline only; exit code and signals forwarded.
- One real `claude -p` check, skipped when `claude` is absent.
- `generic`: declarative config renders the expected file for a fixture; `opencode`: golden config per launch in a temp dir.
- Tier tests: table of capability combinations to tier and "what would raise it".

## Success criteria

1. `toolgate claude --resume` runs `claude --settings <tmp> --resume`; `toolgate claude --model haiku "hi"` passes all args intact.
2. Agent subcommands (`mcp`, `doctor`, `update`) run with no settings file written and no state touched.
3. The routing prompt is extracted only from `-p "<prompt>"` or an unambiguous trailing non-flag argument; otherwise baseline only.
4. Exit code is returned; SIGINT/SIGTERM reach the agent.
5. `cli.js` has no adapter map; an invalid adapter fails at registration with its name and field.
6. `karajan`: see Open Questions. Either it is registered with tests passing, or its code, tests, `docs/` mentions and the `.gitignore` entry are gone.
7. `opencode` and `generic` register and pass the contract tests.
8. `docs/ADAPTERS.md` lists the contract, capabilities, tiers and a matrix where unverified cells say "unknown".
9. `toolgate init` writes the Step 0 rule only where `rules` allows, and prints each detected agent's tier and what would raise it.
10. `npm run build` and `npm run test:e2e` pass.

## Boundaries

- Always: tests first for each module; capability checks instead of agent-name checks; docs updated with the code.
- Ask first: new dependencies; changing the `--adapter` CLI surface or the config schema beyond `adapters.generic`; shipping a capability value for an agent from memory rather than docs.
- Never: edit user MCP config or tracked agent files without the existing `init` confirmation flow; guess unknown agent behavior; break `toolgate "<prompt>"` for current users without a documented migration.

## Open questions

1. **Karajan:** wire it into the registry (code and tests exist) or remove it with its mentions in `docs/ADAPTERS.md`, `ROADMAP.md`, `DESIGN.md` and `.gitignore`? It is an orchestrator, not an agent CLI. I lean towards removal; your call.
2. **Backward compatibility:** keep `toolgate "<prompt>"` (no agent name, default to `claude-code`) as a deprecated form, or require the agent name?
3. **Naming:** agent names are `claude`, `codex`, `opencode`... but the adapter id today is `claude-code`. Accept both as aliases?
4. **`generic` scope:** command, config file path and one format template (JSON `mcpServers` or TOML). Should the template language be a fixed set of formats (`json-mcpServers`, `toml-mcp_servers`) instead of free templates? I lean towards fixed formats.
5. **Delivery:** one PR per module, in the build order above?
