#!/bin/sh
# postToolUse hook (Write|Edit): runs `eslint --fix` on the file the agent just wrote, when it is one eslint.config.js
# lints. The agent sends the tool call as JSON on stdin; the path is in tool_input.file_path. It never blocks the
# agent: a file eslint cannot fix is left for `npm run lint`.
set -eu
cd "$(dirname "$0")/../.."
file=$(node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path??"")}catch{}})')
case "$file" in
  *.js|*.mjs|*.cjs|*.ts|*.mts|*.cts|*.jsx|*.tsx) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0
[ -x node_modules/.bin/eslint ] || exit 0
node_modules/.bin/eslint --fix --no-warn-ignored "$file" >/dev/null 2>&1 || true
