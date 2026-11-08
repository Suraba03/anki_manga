import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// explain() sends bubble text out and holds the Explanations-Off guard: a new caller would bypass the panel's
// handling of Off unnoticed, so the set of importers is pinned.
const root = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["test", "node_modules", "vendor"]);

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (SKIP.has(e.name) ? [] : sources(join(dir, e.name))) : /\.(m?js)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

test("only panel/entries.js imports explain / FREE_URL from lib/llm.js", () => {
  const importers = sources(root)
    .filter((f) => /lib\/llm\.js["']/.test(readFileSync(f, "utf8")))
    .map((f) => relative(root, f))
    .sort();
  assert.deepEqual(importers, ["panel/entries.js"]);
});
