#!/usr/bin/env node
// Builds the Chrome Web Store upload: extension/ without test/, node_modules/, package*.json and dotfiles,
// as <out>/manga-mining-<manifest version>.zip with manifest.json at the zip root. Uses the system `zip`.
//   node tools/package.mjs [--out <dir>]   (default: dist/ in the repo; ANKI_MANGA_DIST also sets it)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = join(ROOT, "extension");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const out = resolve(arg("--out") || process.env.ANKI_MANGA_DIST || join(ROOT, "dist"));

const skipDir = (rel, name) => name === "node_modules" || (rel === "" && name === "test");
const skipFile = (name) => /^package.*\.json$/.test(name) || name.startsWith(".");

// Relative paths (forward slashes) of everything that ships.
function listFiles(dir = EXTENSION, rel = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDir(rel, entry.name)) files.push(...listFiles(join(dir, entry.name), `${rel}${entry.name}/`));
    } else if (entry.isFile() && !skipFile(entry.name)) {
      files.push(rel + entry.name);
    }
  }
  return files.sort();
}

const version = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).version;
const zip = join(out, `manga-mining-${version}.zip`);
mkdirSync(out, { recursive: true });
rmSync(zip, { force: true });
const files = listFiles();
execFileSync("zip", ["-X", "-q", zip, "-@"], { cwd: EXTENSION, input: files.join("\n") + "\n" });
console.log(`${zip}: ${files.length} files`);
