// Which agent CLIs are installed and the support tier each reaches (docs/ADAPTERS.md). Shared by
// `toolgate init` and, later, `toolgate doctor`.
import { computeTier, whatWouldRaise } from "./capability.js";
import { defaultRegistry } from "./adapters/index.js";

// The binary each adapter launches (karajan's is `kj`, the adapter's default `kjBin`); `generic` has no single binary to look for.
export const AGENT_BINS = Object.freeze({
  "claude-code": "claude",
  codex: "codex",
  antigravity: "agy",
  opencode: "opencode",
  karajan: "kj",
});

// The one place that orders the agents `toolgate init` lists, by how widely each is used. The first one that is
// installed is the default `init` proposes, and with --yes sets. Edit this list to change that order; a registered
// agent missing from it is listed after these, in registry order.
export const AGENT_ORDER = Object.freeze(["claude-code", "codex", "opencode", "antigravity", "karajan"]);

const TIER_NAMES = ["no support yet", "skills on demand", "servers on demand at launch", "automatic restart", "mid-session reveal"];

function installed(bin, execFn) {
  try {
    execFn(bin, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The detected agents with their adapter, tier and what would raise it.
 * @returns {Promise<{ name: string, adapter: object, tier: number, raise: string|null }[]>}
 */
export async function detectAgents({ execFn, registry = defaultRegistry }) {
  const found = [];
  for (const [name, bin] of Object.entries(AGENT_BINS)) {
    if (!registry.has(name) || !installed(bin, execFn)) continue;
    const adapter = await registry.get(name);
    found.push({ name, adapter, tier: computeTier(adapter.capability), raise: whatWouldRaise(adapter.capability) });
  }
  return found;
}

/** One line per agent: `claude-code: tier 4 (mid-session reveal)` or `codex: tier 0 ...; to raise it: ...`. */
export function formatAgentLine({ name, tier, raise }) {
  return `${name}: tier ${tier} (${TIER_NAMES[tier]})${raise ? `; to raise it: ${raise}` : ""}`;
}

/**
 * Every registered agent in AGENT_ORDER, each marked installed, not installed, or not detectable (no binary to look for).
 * @param {string[]} names the registry's agent names
 * @param {{ name: string, tier: number }[]} detected what detectAgents found
 * @returns {{ name: string, status: "installed"|"not installed"|"not detectable", tier?: number }[]}
 */
export function listAgents(names, detected) {
  const rank = (name) => (AGENT_ORDER.includes(name) ? AGENT_ORDER.indexOf(name) : AGENT_ORDER.length);
  return names
    .map((name, i) => ({ name, i }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i)
    .map(({ name }) => {
      const found = detected.find((entry) => entry.name === name);
      if (found) return { name, status: "installed", tier: found.tier };
      return { name, status: name in AGENT_BINS ? "not installed" : "not detectable" };
    });
}
