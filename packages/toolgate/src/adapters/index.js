import { validateCapability } from "../capability.js";

// Adapter registry. An adapter module is validated against the contract (docs/ADAPTERS.md) when it
// is registered; modules are loaded lazily so listing adapters does not import every agent.

const FUNCTION_EXPORTS = ["readServers", "applyServers", "installDiscovery", "buildToolEnv", "launch"];

/**
 * Problems found in an adapter module (empty when it honors the contract).
 * @param {object} mod
 * @returns {string[]}
 */
export function adapterProblems(mod) {
  if (!mod || typeof mod !== "object") return ["adapter must be a module object"];
  const problems = FUNCTION_EXPORTS.filter((name) => typeof mod[name] !== "function").map(
    (name) => `missing function export "${name}"`,
  );
  if (typeof mod.supportsResume !== "boolean") problems.push('"supportsResume" must be a boolean');
  const capabilityProblems = validateCapability(mod.capability);
  problems.push(...capabilityProblems);
  if (!capabilityProblems.length && mod.supportsResume !== (mod.capability.resume.supported === true)) {
    problems.push('"supportsResume" must match capability.resume.supported');
  }
  return problems;
}

/** Throws a readable error naming the adapter and every field that breaks the contract. */
export function validateAdapter(name, mod) {
  const problems = adapterProblems(mod);
  if (problems.length) throw new Error(`Invalid adapter "${name}": ${problems.join("; ")}`);
  return mod;
}

export function createRegistry(entries = {}, { validate = true, aliases = {} } = {}) {
  const loaders = new Map();
  const canonical = (name) => aliases[name] ?? name;
  const loaded = new Map();

  const registry = {
    /** Register a lazy loader (`() => import(...)`) or an already loaded module. */
    register(name, source) {
      if (typeof name !== "string" || !name) throw new Error("Adapter name must be a non-empty string");
      if (loaders.has(name)) throw new Error(`Adapter "${name}" is already registered`);
      if (typeof source === "function") {
        loaders.set(name, source);
      } else {
        if (validate) validateAdapter(name, source);
        loaders.set(name, () => Promise.resolve(source));
      }
      return registry;
    },
    names: () => [...loaders.keys()],
    has: (name) => loaders.has(canonical(name)),
    /** The registered name behind an alias (`claude` is `claude-code`). */
    canonical,
    /** Load and validate an adapter; the result is cached. */
    async get(requested) {
      const name = canonical(requested);
      if (!loaders.has(name)) {
        throw new Error(`Unknown adapter "${requested}". Available: ${registry.names().join(", ")}`);
      }
      if (!loaded.has(name)) {
        const mod = await loaders.get(name)();
        loaded.set(name, validate ? validateAdapter(name, mod) : mod);
      }
      return loaded.get(name);
    },
  };
  for (const [name, source] of Object.entries(entries)) registry.register(name, source);
  return registry;
}

export const defaultRegistry = createRegistry({
  "claude-code": () => import("./claude-code.js"),
  codex: () => import("./codex.js"),
  antigravity: () => import("./antigravity.js"),
  karajan: () => import("./karajan.js"),
  opencode: () => import("./opencode.js"),
}, { aliases: { claude: "claude-code" } });
