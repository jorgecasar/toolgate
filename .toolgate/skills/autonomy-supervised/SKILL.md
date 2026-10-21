---
name: autonomy-supervised
description: Use for a task on this project whose spec is decided and can be verified, when the human approves the plan once and the agent then builds without stopping between tasks, pausing on failures and risky steps
tags: [autonomy, workflow]
---

# Supervised: the human approves the plan once

The usual level for decided issues. The agent builds on its own after one approval and stops on failures and on risk.

## Flow

1. **Plan.** Write the plan as one comment on the issue: small ordered tasks, the check for each, the files touched, and anything that changes a flag, config key, output shape or visible behavior. Wait for approval once. A plan that adds none of those can be approved by the orchestrator; the rest by the user.
2. **Build.** Do all the tasks in order without stopping between them. Each one is a thin slice with its test, about 100 lines at most. Keep one commit per pull request.
3. **Verify.** For each box of the issue, run a real command in a disposable env (throwaway HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME; a fake qmd on PATH; never the real index or the daemon on 8181) and record the command and its output. Do not tick boxes: the orchestrator ticks and closes.
4. **Review.** A separate reviewer checks the exact head SHA. Blockers are only: fails in normal use, loses data, or is exploitable with untrusted input on the main path. Anything else goes to the collector issue.
5. **Ship.** Squash merge on the reviewer's LGTM for that exact SHA, CI green, one commit, no attribution lines.

## Pause and report when

- a test or check fails and a second attempt does not fix it (stop the line: find the cause, do not patch around it);
- the work reaches a risk zone (security, public contract, state outside the repo, process);
- the plan turns out to be wrong or incomplete;
- the diff grows far beyond the plan.

## Hand off

The diff, the real command output per box, what was not verified and why.
