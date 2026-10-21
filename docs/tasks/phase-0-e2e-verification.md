# Phase 0 — end-to-end verification harness

## Goal (one sentence)

Add an automated end-to-end test to the `toolgate` monorepo that proves the Phase 0 "Done when"
criterion from `docs/ROADMAP.md`: a heavy MCP server visibly drops from N→M tools in a real session,
and escalating a filtered-out tool + restarting brings it back.

## Scope

Phase 0 is already implemented and green (`toolgate-proxy`: 19 tests; `toolgate`: 40 tests). This task
adds **verification only** — no new product features. It wires the existing pieces (`toolgate-proxy`,
the `toolgate` launcher, the `fake-upstream.js` fixture) into a single automated flow that exercises
the whole progressive-disclosure loop, so "Phase 0 is done" is provable by running one command.

Concretely, build one integration test (plus a tiny stub agent CLI the launcher can spawn) that:

1. **Baseline drop (N→M):** starts the launcher pointing a heavy server — the existing
   `packages/toolgate-proxy/fixtures/fake-upstream.js`, which advertises **7 tools**
   (`listPRs`, `getPR`, `getPRComments`, `comment`, `approve`, `createPR`, `mergePullRequest`) —
   through `toolgate-proxy` with a baseline allow-list of the review subset (e.g. `listPRs`, `getPR`,
   `getPRComments`). Send `initialize` + `tools/list` and assert the agent sees only **M = 3** tools,
   and that `mergePullRequest` is **absent**.
2. **Escalate + restart recovery:** run `toolgate escalate <server> mergePullRequest` (sets
   `pendingRestart`), relaunch, and assert `mergePullRequest` is now **present** in `tools/list`, and
   that `pendingRestart` was consumed/reset afterward.
3. **Fail-open sanity:** with no allow-list configured, assert all 7 tools pass through unfiltered
   (the proxy never breaks the server).

## Stack & conventions

- Node.js ≥ 20, **ES modules** (`import`/`export`), no runtime dependencies — matches the existing
  packages.
- Tests use the built-in `node:test` runner (`node --test`), consistent with
  `packages/toolgate-proxy/test/*` and `packages/toolgate/test/*`.
- Follow `CLAUDE.md`: SOLID/DRY/KISS/YAGNI, `const` by default, template literals, no silent
  fallbacks (assert loudly), never overwrite whole files for small edits.
- Reuse existing fixtures/harness instead of duplicating: build on
  `packages/toolgate-proxy/fixtures/fake-upstream.js` and the proxy's integration-test approach
  (feed newline-delimited JSON-RPC, read filtered output).

## Assumptions / placement

- Lives in the current monorepo under `packages/` (npm workspaces). Put the e2e test where it can
  drive both packages — either a new `packages/e2e/` workspace, or a top-level `test/e2e/` (the latter was chosen) wired into
  the root `npm test`. Choose the lighter option and state which in the PR.
- If the launcher needs a spawnable "agent CLI" to complete the loop, add a minimal stub under the
  test's fixtures (a script that on start emits `initialize` + `tools/list` to its proxied server and
  prints the tool names it received) — do **not** require a real Claude Code install.
- The heavy server is simulated by the existing fixture; no network and no real MCP server required.

## Acceptance criteria

- `npm test` at the repo root runs the new e2e flow and it **passes**, alongside the existing 59
  package tests (nothing regresses).
- The test asserts, in one run: (a) N=7 → M=3 filtering at baseline, `mergePullRequest` absent;
  (b) after `escalate mergePullRequest` + restart, `mergePullRequest` present and `pendingRestart`
  reset; (c) fail-open shows all 7 tools when no allow-list is set.
- The e2e runs with **no external network, no real agent install, and no new runtime dependencies**.
- Adds a short "Verifying Phase 0" note to `README.md` (or `docs/`) pointing at the command that runs
  this proof.
