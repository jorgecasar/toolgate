import os from "node:os";

// `toolgate [toolgate flags] <agent> [agent args…]`: everything after the agent name belongs to the
// agent and is forwarded untouched. toolgate only reads it to decide what to activate.

// toolgate's own flags that take a value; the others are booleans.
const VALUE_FLAGS = new Set(["--adapter", "--prompt", "--backend", "--port", "--ref", "--path", "--exclude"]);

/**
 * Split argv at the agent name. Returns null when the first non-flag token is not an agent
 * (a toolgate command such as `init`, or a bare prompt).
 * @param {string[]} argv
 * @param {(name: string) => boolean} isAgent
 * @returns {{ before: string[], agent: string, after: string[] } | null}
 */
export function splitAgentArgs(argv, isAgent) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (VALUE_FLAGS.has(token)) {
      i++;
    } else if (!token.startsWith("-")) {
      return isAgent(token) ? { before: argv.slice(0, i), agent: token, after: argv.slice(i + 1) } : null;
    }
  }
  return null;
}

/**
 * Agent description an adapter exports as `agentCli`, used to read (never rewrite) its arguments:
 * `subcommands` run without opening a governed session, `valueFlags` take exactly one value,
 * `booleanFlags` take none, `optionalValueFlags` take the next word as their value unless it starts with `-` (as
 * Claude's `--resume [value]` does). Any other flag has an unknown arity.
 * @typedef {{ bin: string, subcommands: string[], valueFlags: string[], booleanFlags: string[], optionalValueFlags?: string[] }} AgentCli
 */

/** True when the arguments start with one of the agent's own subcommands. */
export function isSubcommand(args, spec) {
  return args.length > 0 && spec.subcommands.includes(args[0]);
}

/**
 * The prompt to route on, or undefined when it is not unambiguous: the trailing argument counts
 * only when every flag before it has a known arity, so a flag value is never taken for a prompt.
 * @param {string[]} args
 * @param {AgentCli} spec
 * @returns {string|undefined}
 */
export function extractPrompt(args, spec) {
  const values = new Set(spec.valueFlags);
  const optionals = new Set(spec.optionalValueFlags ?? []);
  const booleans = new Set(spec.booleanFlags);
  let prompt;
  let unsure = false; // after a flag of unknown arity, non-flag tokens may be its values
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      return i === args.length - 2 ? args[i + 1] : undefined;
    }
    if (token.startsWith("-")) {
      prompt = undefined;
      const name = token.split("=")[0];
      if (token.includes("=") || booleans.has(name)) {
        unsure = false;
      } else if (optionals.has(name)) {
        // The next word is its value, unless it is a flag: `--resume "task"` has no prompt, `--resume --model x "task"` has.
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) i++;
        unsure = false;
      } else if (values.has(name)) {
        i++;
        unsure = false;
      } else {
        unsure = true;
      }
    } else {
      prompt = unsure ? undefined : token;
    }
  }
  // Only the last argument can be the prompt.
  return prompt !== undefined && args[args.length - 1] === prompt ? prompt : undefined;
}

/**
 * Split what follows `toolgate` into the agent's own arguments and the task. A flag the agent declares as taking a
 * value keeps it (`--resume <id>`, `--model opus`), so the value is never read as the task; the first other word is
 * the task, and what follows `--` is forwarded as it is.
 * @param {string[]} args
 * @param {{ valueFlags?: readonly string[], optionalValueFlags?: readonly string[] }} spec
 * @returns {{ prompt: string|undefined, agentArgs: string[] }}
 */
export function splitLaunchArgs(args, spec) {
  const values = new Set(spec.valueFlags);
  const optionals = new Set(spec.optionalValueFlags ?? []);
  const agentArgs = [];
  let prompt;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      agentArgs.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith("-")) {
      prompt ??= token;
      continue;
    }
    agentArgs.push(token);
    if (token.includes("=")) continue;
    if (values.has(token) && i + 1 < args.length) agentArgs.push(args[++i]);
    // An optional value: the next word is it unless it starts with `-` (`--resume "task"` is a search term, not a task).
    else if (optionals.has(token) && i + 1 < args.length && !args[i + 1].startsWith("-")) agentArgs.push(args[++i]);
  }
  return { prompt, agentArgs };
}

/** Add the adapter's resume argument unless the user already passed it. */
export function withResume(args, resumeArg, resume) {
  return resume && resumeArg && !args.includes(resumeArg) ? [...args, resumeArg] : args;
}

/** Exit code of a child: its own, or 128 + signal number when a signal ended it. */
export function exitCode({ code, signal }) {
  if (typeof code === "number") return code;
  return signal ? 128 + (os.constants.signals[signal] ?? 0) : 0;
}

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Forward termination signals to the child while it runs. Returns the function that stops it. */
export function forwardSignals(child, source = process) {
  const handlers = FORWARDED.map((signal) => {
    const handler = () => child.kill(signal);
    source.on(signal, handler);
    return [signal, handler];
  });
  return () => {
    for (const [signal, handler] of handlers) source.off(signal, handler);
  };
}
