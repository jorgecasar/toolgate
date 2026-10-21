import { test } from "node:test";
import assert from "node:assert/strict";
import { collectInstalled } from "../src/installed.js";

const parse = (raw) => JSON.parse(raw);
const sources = [
  { path: "/a", parse },
  { path: "/b", parse },
];

test("collectInstalled merges readable sources and skips unreadable ones", () => {
  const readFileFn = (file) => {
    if (file === "/a") return '["x","y"]';
    throw new Error("ENOENT");
  };
  assert.deepEqual(collectInstalled(sources, { readFileFn }), { servers: ["x", "y"], source: "/a" });
});

test("collectInstalled is null when nothing is readable or a source is malformed", () => {
  assert.equal(collectInstalled(sources, { readFileFn: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(collectInstalled(sources, { readFileFn: (f) => (f === "/a" ? '["x"]' : "{") }), null);
});

test("collectInstalled reads each file once", () => {
  const seen = [];
  collectInstalled(sources, { readFileFn: (f) => (seen.push(f), "[]") });
  assert.deepEqual(seen, ["/a", "/b"]);
});
