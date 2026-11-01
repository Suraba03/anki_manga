// tools/package.mjs builds the Chrome Web Store zip: the extension without tests, node_modules and package*.json.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8")).version;

test("package.mjs writes dist/manga-mining-<version>.zip without tests, node_modules and package*.json", () => {
  const out = mkdtempSync(join(tmpdir(), "anki-manga-pkg-"));
  try {
    execFileSync("node", [join(root, "tools", "package.mjs"), "--out", out], { stdio: "pipe" });
    const zip = join(out, `manga-mining-${version}.zip`);
    assert.ok(existsSync(zip), "zip exists");
    const names = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
    for (const want of ["manifest.json", "vendor/ort/ort.webgpu.min.mjs", "offscreen/offscreen.html"]) {
      assert.ok(names.includes(want), `${want} is in the zip`);
    }
    assert.ok(!names.some((n) => n.startsWith("extension/")), "files sit at the zip root, not under extension/");
    assert.ok(!names.some((n) => /(^|\/)test(\/|$)/.test(n)), "no test/ entry");
    assert.ok(!names.some((n) => /(^|\/)node_modules(\/|$)/.test(n)), "no node_modules/ entry");
    assert.ok(!names.some((n) => /(^|\/)package[^/]*\.json$/.test(n)), "no package*.json entry");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
