// Remote skill sources: a git repository fetched into a cache outside the project and pinned to the
// commit that was resolved. Nothing downloaded is ever executed; git is the only program run.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printable } from "../assets/common.js";
import { defaultExec } from "../daemon.js";
import { configLayerPaths, loadConfig } from "../config.js";

const GITHUB = /^github:([\w.-]+)\/([\w.-]+)$/;
const SHA = /^[0-9a-f]{40}$/;
const ABBREVIATED = /^[0-9a-f]{7,39}$/;
const abbreviatedMessage = (ref) => `"${ref}" looks like an abbreviated commit, which cannot be looked up upstream; use the full 40-character SHA`;
const REF = /^[\w][\w./-]*$/;

/**
 * Turns a source spec into a clone URL. Only `github:<owner>/<repo>`, `https://` and ssh URLs are
 * accepted: `file://`, `ext::` and the like can run commands or read local files, and a leading
 * dash would be read by git as an option.
 * @param {string} spec
 * @param {{ allowFile?: boolean }} [options] `allowFile` is for tests that clone a local repository.
 * @returns {string}
 */
/** A password or token written in a URL (`https://user:secret@host/...`) replaced, for anything that is printed. */
export const redactCredentials = (text) =>
  String(text)
    // Everything up to the LAST `@` of the authority is the user and password (`u:p@ss@host` has "p@ss" as password).
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, "$1***@")
    // A token in the query or the fragment is as secret as one in the userinfo.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, "$1?***");

export function sourceUrl(spec, { allowFile = false } = {}) {
  // Control characters (a NUL would crash the call to git, an ESC would reach the terminal) are never part of a source.
  if (typeof spec !== "string" || spec === "" || spec.startsWith("-") || /[\u0000-\u001f\u007f-\u009f]/.test(spec)) {
    throw new Error(`"${printable(redactCredentials(spec))}" is not a skills source`);
  }
  const github = GITHUB.exec(spec);
  if (github && !/^\.+$/.test(github[1]) && !/^\.+(\.git)?$/.test(github[2])) return `https://github.com/${github[1]}/${github[2].replace(/\.git$/, "")}.git`;
  // No userinfo in https URLs, no password in ssh ones, no query or fragment (a token there would be
  // written to the lock file and into messages), and no host or user that starts with a dash: ssh
  // would read it as an option.
  if (/^https:\/\/(?!-)[^\s/@?#]+\/[^\s?#]+$/.test(spec)) return spec;
  if (/^ssh:\/\/((?!-)[^\s/@:]+@)?(?!-)[^\s/@?#]+\/[^\s?#]*$/.test(spec) || /^git@(?!-)[^\s?#]+$/.test(spec)) return spec;
  if (allowFile && spec.startsWith("file://")) return spec;
  throw new Error(`"${printable(redactCredentials(spec))}" is not a supported skills source; use github:<owner>/<repo> or an https:// or ssh git URL`);
}

// --- Sources that come from a lock ---
// A lock is a file in the repository, so a cloned repository decides which hosts `update` and `status --remote` contact.
// Those are refused when they are a loopback, private or link-local address or `localhost`; a source the user typed is not
// checked (it is the user's own input). A hostname that resolves to a private address is NOT detected (it would need a DNS
// lookup in a synchronous path); the user lists a host they trust in `skills.allowedHosts` of their user or local config.

// --- What host a lock may name ---
// Resolvers, URL parsers, ssh and curl read many spellings of one address differently (octal or decimal leading zeros, hex,
// a single number, percent escapes, IPv6 with a dotted tail), so reading them all is a race that is never won. A lock may
// name only a host in a form nobody reads two ways; everything else is refused as ambiguous.
//   (a) a DNS name whose last label has a letter (not `localhost`),
//   (b) an IPv4 address of four plain decimal numbers without leading zeros that is not private, loopback or link-local,
//   (c) an IPv6 address in its canonical form (RFC 5952) that is not private, loopback, link-local or tied to a private IPv4.
const AMBIGUOUS = "a host that resolvers read differently (write a DNS name or a canonical IP address)";

function privateV4(value) {
  const [a, b] = [Math.floor(value / 2 ** 24) % 256, Math.floor(value / 2 ** 16) % 256];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

// The eight 16-bit groups of an IPv6 address written in canonical form, or null for any other spelling.
function canonicalV6(text) {
  if (!/^[0-9a-f:]+$/.test(text)) return null;
  const [left, right] = text.includes("::") ? text.split("::") : [text, null];
  const part = (t) => (t === "" ? [] : t.split(":"));
  const l = part(left);
  const r = right === null ? [] : part(right);
  if (right === null ? l.length !== 8 : l.length + r.length > 7) return null;
  const groups = [...l, ...Array(right === null ? 0 : 8 - l.length - r.length).fill("0"), ...r];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const numbers = groups.map((g) => parseInt(g, 16));
  return canonicalText(numbers) === text ? numbers : null;
}

// RFC 5952: lowercase hex without leading zeros, the longest run of two or more zero groups (the first, if tied) as `::`.
function canonicalText(g) {
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const hex = (list) => list.map((n) => n.toString(16)).join(":");
  if (best.len < 2) return hex(g);
  return `${hex(g.slice(0, best.at))}::${hex(g.slice(best.at + best.len))}`;
}

const v4In = (g) => g[6] * 65536 + g[7];

function privateV6(g) {
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return privateV4(v4In(g)); // ::ffff:a.b.c.d (mapped), ::a.b.c.d, :: and ::1
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return privateV4(v4In(g)); // ::ffff:0:a.b.c.d (SIIT)
  if (g[0] === 0x64 && g[1] === 0xff9b && (g[2] === 0 ? zero(2, 6) : g[2] === 1)) return g[2] === 1 || privateV4(v4In(g)); // NAT64
  if (g[0] === 0x2002) return privateV4(g[1] * 65536 + g[2]); // 6to4 carries the IPv4 address in bits 16 to 48
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo hides an IPv4 address
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

/**
 * The host of an https or ssh source URL (also `git@host:path` and `git@[v6]:path`), as written: lowercase, one trailing dot
 * dropped, brackets removed. `null` for a scheme without a host; `undefined` when the host cannot be read at all, which
 * is refused too. A percent escape in a host is never decoded: it is refused.
 */
export function hostOfSource(url) {
  let raw;
  const scp = /^git@(\[[^\]\s]*\]|[^\s:/?#\[\]]+)(?::|$)/.exec(url);
  if (scp) raw = scp[1];
  else if (url.startsWith("git@")) return undefined; // scp-like, but not a host git can be trusted to read the same way
  else if (/^(?:https|ssh):\/\//i.test(url)) {
    const match = /^(?:https|ssh):\/\/(?:[^\s/@]*@)?(\[[^\]\s]*\]|[^\s/@:?#]*)/i.exec(url);
    if (!match) return undefined;
    raw = match[1];
  } else return null;
  const host = raw.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  return host === "" ? undefined : host;
}

/** Why a host must not be contacted on the word of a lock, or null when it is in one of the three accepted forms. */
export function privateHostReason(host) {
  if (host === undefined) return AMBIGUOUS;
  if (host === null || host === "") return null;
  if (host.includes(":")) {
    const groups = canonicalV6(host);
    if (groups === null) return AMBIGUOUS;
    return privateV6(groups) ? "a loopback, private or link-local address" : null;
  }
  const dotted = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(host);
  if (dotted) {
    const parts = dotted.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return AMBIGUOUS;
    return privateV4(parts.reduce((sum, n) => sum * 256 + n, 0)) ? "a loopback, private or link-local address" : null;
  }
  const labels = host.split(".");
  if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/[a-z]/.test(labels.at(-1)) || /^0x[0-9a-f]*$/.test(labels.at(-1))) return AMBIGUOUS; // a hex number is read as an address, not as a name
  return host === "localhost" || host.endsWith(".localhost") ? "localhost" : null;
}

/**
 * `skills.allowedHosts` as the config merge keeps it: the user's, and the local one only when git does not version it. The
 * committed project file (or a versioned local one) is ignored, and `doctor` and `route` say so.
 */
export function allowedHosts({ projectDir, env = process.env, homedir = os.homedir() } = {}) {
  const list = loadConfig(configLayerPaths({ cwd: projectDir ?? process.cwd(), env, homedir })).skills?.allowedHosts;
  return new Set(Array.isArray(list) ? list.filter((host) => typeof host === "string").map((host) => host.toLowerCase()) : []);
}

/**
 * The URL a lock names, checked like a typed one and, besides, not an address on this machine or its network.
 * @throws {Error} naming the source and how to allow it
 */
export function lockSourceUrl(spec, info, { allowFile = false, projectDir, env, homedir } = {}) {
  const url = sourceUrl(info?.url ?? spec, { allowFile });
  const host = hostOfSource(url);
  const reason = privateHostReason(host);
  if (reason && !allowedHosts({ projectDir, env, homedir }).has(host)) {
    throw Object.assign(new Error(`${printable(redactCredentials(url))} is ${reason}: a lock file is not trusted to name it; to allow it, add the host to "skills.allowedHosts" in your user or local config`), { privateHost: String(host) });
  }
  return url;
}

export function checkRef(ref) {
  if (ref === undefined) return undefined;
  if (!REF.test(ref) || ref.includes("..")) throw new Error(`"${ref}" is not a valid branch or tag name`);
  return ref;
}

/** Where fetched sources are kept: outside the project, shared by every project of the user. */
export function cacheRoot(env = process.env, homedir = os.homedir()) {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir, ".cache"), "toolgate", "sources");
}

// A helper that asks for a password (VS Code sets one) would wait for an answer nobody gives: git and ssh never get one.
const withoutAskpass = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => name !== "GIT_ASKPASS" && name !== "SSH_ASKPASS"));
/**
 * The environment git runs in. It never prompts (a missing credential is an error, not a question nobody can
 * answer), does not honour a repository's LFS settings (its own server URL: nothing from it is fetched but the
 * files), and always speaks English, so that what is read from its error messages does not depend on the
 * language of the machine.
 */
export const gitEnv = (env = process.env, { strictHostKeys = false } = {}) => ({ ...withoutAskpass(env), GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_SSH_COMMAND: `${env.GIT_SSH_COMMAND || "ssh"} -o BatchMode=yes${strictHostKeys ? " -o StrictHostKeyChecking=yes" : ""}`, LC_ALL: "C", LANGUAGE: "C" });

const GIT_SAFE = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "core.hooksPath=/dev/null",
];

// Why a fetch by commit failed: the commit is gone, or the server does not serve commits by SHA.
function explainShaFetch(err, url, ref) {
  const text = `${err.stderr ?? ""}\n${err.message}`;
  const cause = text.split("\n").map((line) => line.trim()).find((line) => /^(fatal|error|remote):/.test(line)) ?? err.message.split("\n")[0];
  if (/does not allow request for unadvertised object|allowAnySHA1InWant|allowReachableSHA1InWant/i.test(text)) {
    return `${url} does not serve commits by SHA, so the pinned commit ${ref} cannot be fetched from it (${cause})`;
  }
  if (/not our ref|couldn't find remote ref|bad object|did not match any/i.test(text)) return `the pinned commit ${ref} no longer exists in ${url} (${cause})`;
  return `could not fetch the pinned commit ${ref} from ${url}: ${cause}`;
}

/**
 * Fetches `url` at `ref` (default branch when omitted) into the cache and returns the checkout and
 * the commit it is at. A cached checkout is refreshed in place.
 * @returns {{ dir: string, commit: string, url: string }}
 */
export function fetchSource(options) {
  const fetched = fetchOnce(options);
  assertCheckoutSize(fetched.dir, options.url, options.maxBytes);
  return fetched;
}

/** The most a fetched repository may take in the cache. A skill is capped at 10 MB, so this is generous. */
export const MAX_CHECKOUT_BYTES = 200 * 1024 * 1024;

// Adds up the files of a folder without following links and stops as soon as the limit is passed.
function sizeOf(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    for (const entry of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) total += fs.lstatSync(file).size;
      if (total > limit) return total;
    }
  }
  return total;
}

/** A repository that is bigger than the limit is removed from the cache and refused: the caps on a skill come after the clone. */
export function assertCheckoutSize(dir, url, limit = MAX_CHECKOUT_BYTES) {
  if (sizeOf(dir, limit) <= limit) return;
  fs.rmSync(dir, { recursive: true, force: true });
  throw new Error(`${printable(redactCredentials(url))} is larger than ${Math.round(limit / 1024 / 1024)} MB once fetched, so it was removed from the cache and is not used`);
}

function fetchOnce({ url, ref, cache, execFn = defaultExec, allowFile = false, strictHostKeys = false }) {
  const key = crypto.createHash("sha256").update(`${url}\n${ref ?? ""}`).digest("hex").slice(0, 16);
  const dir = path.join(cache, key);
  const options = { timeout: 120000, env: gitEnv(process.env, { strictHostKeys }) };
  const git = (args, extra = {}) =>
    execFn("git", [...(allowFile ? [] : GIT_SAFE), ...args], { ...options, ...extra });

  // A full SHA is fetched as it is (a branch clone cannot name a commit) and must be what arrives.
  if (ref && SHA.test(ref)) {
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      git(["init", "-q", dir]);
    }
    try {
      git(["-C", dir, "fetch", "--depth", "1", "--", url, ref]);
    } catch (err) {
      throw new Error(explainShaFetch(err, url, ref));
    }
    git(["-C", dir, "checkout", "-q", "--force", "FETCH_HEAD"]);
    const head = git(["-C", dir, "rev-parse", "HEAD"]).trim();
    if (head !== ref) throw new Error(`${url} returned ${head} for the pinned commit ${ref}`);
    return { dir, commit: head, url };
  }
  try {
    if (fs.existsSync(path.join(dir, ".git"))) {
      git(["-C", dir, "fetch", "--depth", "1", "origin", ref ?? "HEAD"]);
      git(["-C", dir, "reset", "--hard", "FETCH_HEAD"]);
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(cache, { recursive: true });
      git(["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", url, dir]);
    }
  } catch (err) {
    // A short hex "branch" that does not exist is a commit that was abbreviated: say so. Any other failure (the network, a
    // login, a full disk) keeps git's own words.
    if (ref && ABBREVIATED.test(ref) && /remote branch .* not found|couldn't find remote ref/i.test(`${err.stderr ?? ""}\n${err.message}`)) throw new Error(abbreviatedMessage(ref));
    throw err;
  }
  return { dir, commit: git(["-C", dir, "rev-parse", "HEAD"]).trim(), url };
}

/**
 * The commit `ref` (a branch or tag; the default branch when omitted) points at upstream, without
 * cloning anything. An annotated tag resolves to the commit it tags; a full SHA is already pinned.
 * @returns {string | null} null when the ref does not exist
 */
export function remoteHead({ url, ref, execFn = defaultExec, allowFile = false, strictHostKeys = false }) {
  if (ref && SHA.test(ref)) return ref;
  // `refs/heads/x` and `refs/tags/x` name the same thing as `x`, only more exactly.
  const short = ref?.replace(/^refs\/(heads|tags)\//, "");
  const patterns = ref ? [`refs/heads/${short}`, `refs/tags/${short}`, `refs/tags/${short}^{}`] : ["HEAD"];
  const out = execFn("git", [...(allowFile ? [] : GIT_SAFE), "ls-remote", "--", url, ...patterns], { timeout: 60000, env: gitEnv(process.env, { strictHostKeys }) });
  const found = new Map(
    String(out)
      .split("\n")
      .map((line) => line.split(/\s+/))
      .filter(([sha]) => /^[0-9a-f]{40}$/.test(sha))
      .map(([sha, name]) => [name, sha]),
  );
  // A branch wins over a tag of the same name, as it does for `git clone --branch`; a ref written
  // with its full name picks that kind only.
  const kinds = ref?.startsWith("refs/tags/") ? ["tag"] : ref?.startsWith("refs/heads/") ? ["head"] : ["head", "tag"];
  const byKind = { head: found.get(`refs/heads/${short}`), tag: found.get(`refs/tags/${short}^{}`) ?? found.get(`refs/tags/${short}`) };
  const head = (ref ? kinds.map((kind) => byKind[kind]).find(Boolean) : found.get("HEAD")) ?? null;
  if (head === null && ref && ABBREVIATED.test(ref)) {
    throw new Error(abbreviatedMessage(ref));
  }
  return head;
}
