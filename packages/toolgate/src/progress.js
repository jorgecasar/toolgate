import { spawn } from "node:child_process";
import path from "node:path";

// Says what a long step is doing, before it starts and while it runs. The steps run through execFileSync, which blocks
// this process, so the sign of life comes from a small helper process that prints on its own and is killed when the step ends.
// Everything goes to the stream given to `setProgress` (stderr): stdout, the results and `--json` are untouched.
let sink = null;

/**
 * @param {{ stream: { write: Function }, animated?: boolean, intervalMs?: number } | null} next `animated` redraws one line
 * (a terminal); otherwise the helper prints a plain line now and then.
 */
export function setProgress(next) {
  sink = next;
}

// What a command is, when it can take a while.
export function describeLongStep(bin, args = []) {
  const name = path.basename(String(bin));
  if (name.startsWith("qmd")) {
    if (args[0] === "update") return "updating the qmd index";
    if (args[0] === "embed") return "embedding the documents with qmd (the first run is the slowest)";
    if (args[0] === "collection" && args[1] === "add") return "registering the collection with qmd";
  }
  if (name === "git" && (args.includes("clone") || args.includes("fetch"))) return "downloading a repository";
  return null;
}

const TICKER = `
const [, parent, interval, animated, label] = process.argv;
const start = Date.now();
const elapsed = () => { const s = Math.round((Date.now() - start) / 1000); return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s"; };
setInterval(() => {
  try { process.kill(Number(parent), 0); } catch { process.exit(0); }
  process.stderr.write(animated === "1" ? "\\r\\x1b[K  " + label + "... " + elapsed() : "  still " + label + " (" + elapsed() + ")\\n");
}, Number(interval));
`;

/** Runs `fn`, announcing it first when it is a long step and a progress sink is set. */
export function withProgress(bin, args, fn) {
  const label = sink ? describeLongStep(bin, args) : null;
  if (!label) return fn();
  const { stream, animated = false, intervalMs = animated ? 5000 : 30000 } = sink;
  stream.write(`toolgate: ${label}; this can take a while\n`);
  // The helper writes to this process's own stderr; a stream that is not it (a test, a redirect) gets only the line above.
  const ticker = stream === process.stderr ? startTicker(label, animated, intervalMs) : undefined;
  try {
    return fn();
  } finally {
    ticker?.kill();
    if (ticker && animated) stream.write("\r\x1b[K");
  }
}

function startTicker(label, animated, intervalMs) {
  try {
    const child = spawn(process.execPath, ["-e", TICKER, String(process.pid), String(intervalMs), animated ? "1" : "0", label.split(" (")[0]], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", () => {});
    return child;
  } catch {
    // no sign of life is better than a failed step
    return undefined;
  }
}
