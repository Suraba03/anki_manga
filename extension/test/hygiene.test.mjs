// The repo is public and read by Store reviewers: the manual checklist stays neutral.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const checklist = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "manual-checklist.md"), "utf8");

test("the manual checklist quotes no manga line and calls no site a 'raw' reader", () => {
  assert.ok(!/raw reader/i.test(checklist), "no 'raw reader'");
  assert.ok(!checklist.includes("これは坂"), "no verbatim manga line");
  assert.ok(!checklist.includes("正確"), "no verbatim manga line");
  assert.ok(!/https?:\/\/(?!suraba03\.github\.io)[^\s)]*\.(com|net|org|jp|io|to|me|cc)/i.test(checklist), "no site URL");
});
