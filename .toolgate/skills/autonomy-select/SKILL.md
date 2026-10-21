---
name: autonomy-select
description: Use before starting a task on this project to choose how much autonomy the agent gets (interactive, supervised or unattended), with the recommended level and the reason; the developer can pick another level
tags: [autonomy, workflow]
---

# Choose the autonomy level

Grant only as much autonomy as can be verified cheaply. Pick the level from the task, say why, and let the developer confirm or change it.

## 1. Score the task

| Question | If yes | If no |
| --- | --- | --- |
| Is there a cheap pass/fail check (tests, lint, a real run in a disposable env) that covers the whole task? | up | down |
| Is every change easy to revert (one commit, no data outside the repo)? | up | down |
| Is the change small (about 100 lines, one concern)? | up | down |
| Is the spec already decided (issue with checkable boxes, no open design question)? | up | down |

Zones where the cost of a wrong answer is high. If the task touches one, the level is at most **supervised**, and **unattended is refused unless the user says so**:

- security: approvals, symlinks and temp files, SSRF, anything that runs or sends data out;
- public contract: CLI flags, config keys, shape of JSON or text output, file formats;
- state outside the repo: the qmd index, the user's HOME, processes of other sessions;
- process: merge method, branch protection, review flow;
- anything irreversible or ambiguous: stop and ask.

## 2. Recommend

- Mostly "no", or an open design question, or a new idea → **interactive** (`autonomy-interactive`).
- Mostly "yes" but a contract or a risk zone is touched, or the plan needs an approval → **supervised** (`autonomy-supervised`).
- All "yes", no risk zone, a check that cannot be faked, and a separate checker available → **unattended** (`autonomy-unattended`).

## 3. Say it and let the developer override

Reply with: the recommended level, the two or three answers that decided it, and the risk zone if any. Ask: "Use this level, or another?" The developer may go up or down. Going up into a risk zone needs the user's explicit OK. Then follow the skill of the chosen level.

Never skip the checker: the agent that makes a change does not grade it.
