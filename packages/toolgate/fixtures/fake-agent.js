#!/usr/bin/env node
// Fake agent binary: records its arguments and settings file, exits with FAKE_EXIT.
import fs from "node:fs";

const settingsAt = process.argv.indexOf("--settings");
fs.writeFileSync(
  process.env.FAKE_OUT,
  JSON.stringify({
    argv: process.argv.slice(2),
    settings: settingsAt >= 0 ? JSON.parse(fs.readFileSync(process.argv[settingsAt + 1], "utf8")) : null,
    env: process.env.TOOLGATE_REPO_TOOLS ?? null,
  }),
);
if (process.env.FAKE_WAIT) {
  process.on("SIGTERM", () => process.exit(42));
  fs.writeFileSync(process.env.FAKE_WAIT, "ready");
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
}
