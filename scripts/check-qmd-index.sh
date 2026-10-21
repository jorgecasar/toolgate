#!/bin/sh
# Proves the test suite leaves the qmd index alone: runs the full suite twice in a disposable HOME / XDG_CONFIG_HOME /
# XDG_CACHE_HOME and compares `qmd collection list` in that same disposable home before and after. The user's real
# index is never read or written. Needs a real `qmd` on PATH only for the listing; the suite itself runs against the
# fake qmd of packages/toolgate/test/support/hermetic.js, which fails any test that reaches it.
set -eu
C=$(mktemp -d)
trap 'rm -rf "$C"' EXIT
export HOME="$C/home" XDG_CONFIG_HOME="$C/config" XDG_CACHE_HOME="$C/cache" TG_TEST_SANDBOX_ROOT="$C"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
# The check lists the collections with the real qmd: without one it would compare two empty answers and always pass.
command -v qmd >/dev/null 2>&1 || {
  echo "check-qmd-index: qmd is not on PATH; this check needs a real qmd to list the collections" >&2
  exit 1
}
list() { qmd collection list 2>&1 || true; }
list > "$C/before.txt"
npm test
npm test
list > "$C/after.txt"
if ! diff "$C/before.txt" "$C/after.txt"; then
  echo "check-qmd-index: the collections changed during the suite" >&2
  exit 1
fi
echo "check-qmd-index: the collections are the same after two suite runs"
