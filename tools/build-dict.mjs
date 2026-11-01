#!/usr/bin/env node
// Builds the dictionary file of the extension from JMdict (jmdict-simplified, English): a compact, gzipped JSON
// in tools/.cache/mirror/ (the folder mirror-models.mjs uploads and the e2e serves), and records it in
// extension/engine/models.manifest.json under sets.data.dict.
//   node tools/build-dict.mjs [path/to/jmdict-eng-*.json]   (no argument: download the latest release asset)
// Publishes nothing. Compact format (lib/dictionary.js reads it):
//   {version, tags: {pos code: description}, entries: [[kanji[], kana[], [[pos[], glosses[]] x<=3]]], index: {form: [entryIdx]}}
// Entries are ordered most common first; every kanji and kana form is in the index.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, createWriteStream, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "tools", ".cache");
const MIRROR = join(CACHE, "mirror");
const MANIFEST = join(ROOT, "extension", "engine", "models.manifest.json");
const NAME = "jmdict-eng.min.json.gz";
const REPO = "scriptin/jmdict-simplified";
const MAX_SENSES = 3;
const MAX_GLOSSES = 4;

// raw: parsed jmdict-eng-*.json ({version, tags, words}) -> compact object.
export function compactJmdict(raw) {
  const words = raw.words.map((w, i) => ({ w, i, common: [...(w.kanji || []), ...(w.kana || [])].some((f) => f.common) }));
  words.sort((a, b) => Number(b.common) - Number(a.common) || a.i - b.i);
  const entries = [];
  const index = Object.create(null);
  const used = new Set();
  for (const { w } of words) {
    const senses = [];
    for (const s of w.sense || []) {
      const glosses = (s.gloss || []).filter((g) => g.lang === "eng").map((g) => g.text).slice(0, MAX_GLOSSES);
      if (!glosses.length) continue;
      senses.push([s.partOfSpeech || [], glosses]);
      if (senses.length === MAX_SENSES) break;
    }
    if (!senses.length) continue;
    const kanji = (w.kanji || []).map((k) => k.text);
    const kana = (w.kana || []).map((k) => k.text);
    const at = entries.length;
    entries.push([kanji, kana, senses]);
    for (const [pos] of senses) for (const p of pos) used.add(p);
    for (const form of new Set([...kanji, ...kana])) (index[form] ||= []).push(at);
  }
  const tags = {};
  for (const p of [...used].sort()) if (raw.tags?.[p]) tags[p] = raw.tags[p];
  return { version: String(raw.version ?? ""), tags, entries, index: { ...index } };
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest);
}

// Latest jmdict-eng release asset of jmdict-simplified, unzipped into tools/.cache/jmdict/<tag>/.
async function fetchLatest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const rel = await res.json();
  const asset = rel.assets.find((a) => /^jmdict-eng-[^-]+\.json\.zip$/.test(a.name));
  if (!asset) throw new Error(`no jmdict-eng asset in release ${rel.tag_name}`);
  const dir = join(CACHE, "jmdict", asset.name.replace(/\.json\.zip$/, ""));
  mkdirSync(dir, { recursive: true });
  let json = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith(".json"));
  if (!json) {
    const zip = join(dir, asset.name);
    console.log(`fetch   ${asset.name}  <- ${asset.browser_download_url}`);
    await download(asset.browser_download_url, zip);
    const r = spawnSync("unzip", ["-o", "-q", zip, "-d", dir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("unzip failed");
    json = readdirSync(dir).find((f) => f.endsWith(".json"));
  }
  return { path: join(dir, json), tag: rel.tag_name, asset: asset.name };
}

async function main() {
  const arg = process.argv[2];
  const src = arg ? { path: arg, tag: null, asset: null } : await fetchLatest();
  const raw = JSON.parse(readFileSync(src.path, "utf8"));
  const compact = compactJmdict(raw);
  const gz = gzipSync(Buffer.from(JSON.stringify(compact)), { level: 9 });
  mkdirSync(MIRROR, { recursive: true });
  const dest = join(MIRROR, NAME);
  writeFileSync(dest, gz);
  const sha256 = createHash("sha256").update(gz).digest("hex");
  console.log(`dictionary ${compact.version}: ${compact.entries.length} entries, ${Object.keys(compact.index).length} forms`);
  console.log(`wrote ${dest}\n  bytes  ${gz.length}\n  sha256 ${sha256}`);

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  manifest.sets.data ||= {};
  manifest.sets.data.dict = {
    name: NAME,
    url: `https://github.com/Suraba03/anki_manga/releases/download/${manifest.release}/${NAME}`,
    sha256,
    bytes: gz.length,
    source: {
      repo: REPO,
      release: src.tag,
      asset: src.asset,
      version: compact.version,
      license: "CC BY-SA 4.0 (JMdict, EDRDG)",
    },
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`updated ${MANIFEST} (sets.data.dict)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
