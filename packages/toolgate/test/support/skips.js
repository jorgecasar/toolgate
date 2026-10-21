// Tests that depend on what the machine is: a file mode means nothing to root (Docker), and a few tests need `pgrep`.
import { spawnSync } from "node:child_process";
export const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
export const SKIP_AS_ROOT = asRoot ? "root ignores file modes, so the failure this test makes cannot happen" : false;
export const SKIP_NO_PGREP = spawnSync("pgrep", ["-P", "1"]).error?.code === "ENOENT" ? "pgrep is not installed" : false;
