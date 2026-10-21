// Finds the servers whose tools do what a task asks, from the catalog. The catalog text comes from the servers themselves, so
// a description that repeats every common word gains nothing: a prompt word counts once, tokens per field are capped, and the
// number of servers returned is capped by the caller.
export const DEFAULT_CATALOG_MAX_SERVERS = 3;
const MAX_TOKENS_PER_FIELD = 200;
const MAX_PROMPT_WORDS = 4;
const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "you", "your", "are", "was", "has", "have", "can", "will", "use", "using", "all", "any", "not", "but", "its", "our", "how", "what", "when", "then", "than", "please", "need", "want", "let", "get", "make", "new", "one"]);

export function words(text) {
  const split = String(text).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  return [...new Set(split.filter((word) => word.length >= 3 && !STOPWORDS.has(word)))];
}

/** The number of servers the catalog may add: `router.catalogMaxServers` if it is a non-negative integer, else the default. */
export const catalogMaxServers = (config) => {
  const value = config?.router?.catalogMaxServers;
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_CATALOG_MAX_SERVERS;
};

const fieldWords = (text) => new Set(words(text).slice(0, MAX_TOKENS_PER_FIELD));

/**
 * How well one tool answers the prompt, from 0 to 1. A word of the prompt counts once, for the best place it is found: a text a
 * person wrote for `whenToUse` (2), the name of the tool (1.5), its description (1). A generated `whenToUse` is a copy of the
 * description and adds nothing. The sum is divided by what a full match of at most four words would be.
 */
function toolScore(promptWords, tool) {
  const fields = [
    [tool.generated ? null : fieldWords(tool.whenToUse), 2],
    [fieldWords(tool.name), 1.5],
    [fieldWords(tool.description), 1],
  ];
  let total = 0;
  for (const word of promptWords) total += Math.max(0, ...fields.map(([set, weight]) => (set?.has(word) ? weight : 0)));
  return Math.min(1, total / (2 * Math.min(promptWords.length, MAX_PROMPT_WORDS)));
}

/**
 * @returns {{ server: string, score: number, tools: string[] }[]} best first, a server once, at most `maxServers`
 */
export function matchCatalog(prompt, catalog, { minScore = 0.5, maxServers = DEFAULT_CATALOG_MAX_SERVERS } = {}) {
  const promptWords = words(prompt);
  if (!promptWords.length || maxServers <= 0) return [];
  const hits = [];
  for (const [server, entry] of catalog.servers) {
    const scored = entry.tools.map((tool) => ({ name: tool.name, score: toolScore(promptWords, tool) })).filter((t) => t.score >= minScore);
    if (!scored.length) continue;
    scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
    hits.push({ server, score: scored[0].score, tools: scored.slice(0, 5).map((t) => t.name) });
  }
  hits.sort((a, b) => b.score - a.score || (a.server < b.server ? -1 : 1));
  return hits.slice(0, maxServers);
}
