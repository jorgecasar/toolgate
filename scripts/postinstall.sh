#!/bin/sh
# `postinstall` of the root package: runs `npm run setup` (rulesync generate, toolgate init, the PATH check) after an install, but only
# in an interactive install of the main checkout. The setup writes to the real HOME and XDG folders and can start the qmd daemon, so it
# must not run for an agent's or a script's `npm ci`, in CI, or in a linked worktree. `npm run setup` by hand is unchanged.
# TOOLGATE_SETUP_CMD replaces the command, for the tests only.
skip() {
  echo "toolgate setup skipped ($1); run npm run setup to do it"
  exit 0
}
[ -n "$CI" ] && skip "CI"
[ -n "$TOOLGATE_SKIP_SETUP" ] && skip "TOOLGATE_SKIP_SETUP"
# A linked worktree has its own git dir, apart from the one it shares with the main checkout. Without git (or outside a repository) this rule does not apply.
if command -v git >/dev/null 2>&1; then
  own=$(cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P)
  common=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
  [ -n "$own" ] && [ "$own" != "$common" ] && skip "git worktree"
fi
{ [ -t 0 ] && [ -t 1 ]; } || skip "not interactive"
sh -c "${TOOLGATE_SETUP_CMD:-npm run setup}" || true
