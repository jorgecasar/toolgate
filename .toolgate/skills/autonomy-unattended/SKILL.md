---
name: autonomy-unattended
description: Use only for narrow, low-risk, machine-checkable tasks on this project that an agent loop can repeat on its own, with a separate checker, a verifiable stop condition and a state file; never in a risk zone without the user's explicit OK
tags: [autonomy, workflow]
---

# Unattended: a bounded loop with a separate checker

Only when the task has a cheap, hard-to-fake oracle and sits outside every risk zone (security, public contract, state outside the repo, process). If in doubt, use `autonomy-supervised`.

## Set up before the first run

- **Oracle:** the check that decides pass or fail (for example `npm test` and `npm run lint` green).
- **Scope:** one narrow, repeatable change, such as one lint violation or one missing test. One fix per run.
- **Maker:** an instruction that finds one instance, fixes it, runs the oracle, and commits only if it passes.
- **Checker:** a different agent with its own rubric that rejects any diff outside the target pattern or larger than a few lines. The maker never grades its own work.
- **State file:** on disk, read at the start of each run and updated at the end (what changed, what remains), because the agent forgets between runs.
- **Stop condition:** verifiable by the checker, not claimed by the maker. Also stop when the oracle fails twice in a row, or the loop has done a fixed number of runs (decide it up front).

## Each run

1. Read the state file. 2. Do one fix. 3. Run the oracle. 4. Hand the diff to the checker. 5. Open a small pull request: the diff, the oracle output and a one-line reason. 6. Update the state file.

## Rules

- Never merge unverifiable changes. A human owns the merge decision.
- Escalate uncertainty instead of shipping it.
- Keep the number of open pull requests within what a person can review.
- Stop the loop and report if the checker rejects twice or a risk zone appears.
