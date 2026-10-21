// Git for tests that need a repository, without depending on the machine's own git configuration (a signing key, a default
// branch name, a global ignore file, a hook directory...): the global and system config files are replaced by an empty one.
import { execFileSync } from "node:child_process";
import os from "node:os";

// The ceiling keeps git from finding a repository above the temporary directory (a TMPDIR under a checkout) (#168).
const isolated = () => ({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: os.tmpdir() });
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

/** The environment for a git command: no inherited `GIT_*` variable, no global or system config, a fixed identity. */
export const gitEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), ...isolated(), ...IDENTITY, ...extra });

/** Runs `git <args>` in `cwd` and returns its output. */
export const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });

/**
 * Makes the git commands the code under test runs hermetic too (they inherit this process's environment). Call it once at the
 * top of a test file that asks git about files of a temporary repository.
 */
export function isolateGitConfig() {
  Object.assign(process.env, isolated());
}
