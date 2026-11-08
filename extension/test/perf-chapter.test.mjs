// tools/perf/chapter.mjs: the long-chapter fixture gives every page its own bytes and its own data URL length.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { distinctPng, chapterHtml } from "../../tools/perf/chapter.mjs";

const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "demo", "page.png"));

test("distinctPng: 200 pages, all different hashes and all different base64 lengths", () => {
  const pages = Array.from({ length: 200 }, (_, i) => distinctPng(base, i));
  assert.equal(new Set(pages.map((p) => createHash("sha256").update(p).digest("hex"))).size, 200);
  assert.equal(new Set(pages.map((p) => p.toString("base64").length)).size, 200);
});

test("distinctPng: still a PNG (signature, IHDR first, tEXt chunk with a valid CRC, the original chunks after it)", () => {
  const p = distinctPng(base, 7);
  assert.deepEqual([...p.subarray(0, 8)], [...base.subarray(0, 8)]);
  assert.equal(p.subarray(12, 16).toString("latin1"), "IHDR");
  const len = p.readUInt32BE(33);
  assert.equal(p.subarray(37, 41).toString("latin1"), "tEXt");
  assert.equal(p.readUInt32BE(41 + len), crc32(p.subarray(37, 41 + len)));
  assert.deepEqual([...p.subarray(33 + 12 + len)], [...base.subarray(33)]);
});

test("chapterHtml: one sized <img> per page, loading=lazy only when asked", () => {
  const lazy = chapterHtml({ pages: 3, lazy: true });
  assert.equal(lazy.match(/<img /g).length, 3);
  assert.equal(lazy.match(/loading="lazy"/g).length, 3);
  assert.ok(lazy.includes('id="p2" src="/p/2.png"'));
  assert.ok(!chapterHtml({ pages: 3, lazy: false }).includes("loading="));
});
