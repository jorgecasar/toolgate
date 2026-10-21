#!/bin/sh
# Last step of `npm run setup`: the Step 0 rule and /toolgate make the agent run `toolgate need ...` in its own shell.
# npm puts node_modules/.bin on the PATH of its scripts, so that copy does not count: the agent's shell does not have it.
# Installing a program globally is the user's call, so this only says so.
outside=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'node_modules/\.bin$' | paste -sd: -)
found=$(PATH="$outside"; command -v toolgate)
if [ -n "$found" ]; then
  echo "setup: toolgate is on your PATH ($found)"
else
  echo "setup: toolgate is not on your PATH (only npm scripts see node_modules/.bin), so the agent cannot run it. Install it with:" >&2
  echo "         npm install -g ./packages/toolgate" >&2
fi
