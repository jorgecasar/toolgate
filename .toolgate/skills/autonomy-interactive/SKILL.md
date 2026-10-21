---
name: autonomy-interactive
description: Use when the developer drives every step of a task on this project (open design question, new idea, risk zone, unclear spec) and approves each phase before the agent goes on
tags: [autonomy, workflow]
---

# Interactive: the human approves every step

Use for new ideas, open design questions, unclear specs and anything the user has not decided yet.

## Flow

1. **Define.** Restate the goal. Ask the questions that change what you build, one at a time, each with context and a recommendation. Do not build while a decision is open.
2. **Plan.** Write the plan (small ordered tasks, each checkable). Wait for approval of the plan.
3. **Build.** One task at a time, a thin slice with its test. After each task show what changed and wait for the go-ahead.
4. **Verify.** Run it for real in a disposable env (throwaway HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME; never the real qmd index). Show the command and its output.
5. **Review.** Hand the diff and the evidence to a separate reviewer. Do not grade your own work.
6. **Ship.** Only when the developer says so, with one commit and no attribution lines.

## Stop and ask when

- a requirement is ambiguous or two readings give different behavior;
- the change needs a new flag, config key or output field;
- a check fails and the cause is not clear after one honest attempt.

## Hand off

Evidence, not claims: the diff, the real command output, what you did not verify.
