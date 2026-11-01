#!/usr/bin/env node
// Mirrors the model files from Hugging Face (at pinned commit SHAs) into tools/.cache/mirror/, hashes them and
// writes extension/engine/models.manifest.json (URLs on this repo's GitHub Release `models-1`).
//   node tools/mirror-models.mjs            download + hash + write the manifest (publishes nothing)
//   node tools/mirror-models.mjs --upload   also `gh release create models-1 ...`  (PUBLISHES: owner approval first)
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, readFileSync, createWriteStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = join(ROOT, "tools", ".cache", "mirror");
const LOCAL = join(ROOT, "tools", ".cache", "models"); // earlier downloads, reused only when the hash matches
const MANIFEST = join(ROOT, "extension", "engine", "models.manifest.json");
const TAG = "models-1";
const RELEASE_URL = `https://github.com/Suraba03/anki_manga/releases/download/${TAG}`;

const DET = "LunarOilRig/comic-text-onnx-fp16";
const DET_WASM = "mayocream/comic-text-detector-onnx";
const OCR = "onnx-community/manga-ocr-base-ONNX";
const VOCAB = "kha-white/manga-ocr-base";

// slot -> {repo, path (inside the repo), name (file name on the release), license}
const GPL = "GPL-3.0 (comic-text-detector, dmMaze)";
const APACHE = "Apache-2.0 (manga-ocr)";
const PLAN = {
  webgpu: {
    det: { repo: DET, path: "comic-text-detector-fp16.onnx", license: GPL },
    enc: { repo: OCR, path: "onnx/encoder_model_fp16.onnx", license: APACHE },
    dec: { repo: OCR, path: "onnx/decoder_model.onnx", license: APACHE },
    vocab: { repo: VOCAB, path: "vocab.txt", license: APACHE },
  },
  wasm: {
    det: { repo: DET_WASM, path: "comic-text-detector.onnx", license: GPL },
    enc: { repo: OCR, path: "onnx/encoder_model_q4.onnx", license: APACHE },
    dec: { repo: OCR, path: "onnx/decoder_model_q4.onnx", license: APACHE },
    vocab: { repo: VOCAB, path: "vocab.txt", license: APACHE },
  },
};

const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });

async function repoInfo(repo) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
  if (!res.ok) throw new Error(`HF API ${repo}: HTTP ${res.status}`);
  const j = await res.json();
  return { sha: j.sha, files: new Map(j.siblings.map((s) => [s.rfilename, s])) };
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest);
}

async function main() {
  const upload = process.argv.includes("--upload");
  mkdirSync(MIRROR, { recursive: true });

  const repos = new Map();
  for (const repo of new Set(Object.values(PLAN).flatMap((s) => Object.values(s).map((f) => f.repo)))) {
    repos.set(repo, await repoInfo(repo));
    console.log(`revision ${repo} @ ${repos.get(repo).sha}`);
  }

  const done = new Map(); // name -> manifest entry (vocab.txt is shared by both sets)
  // sets.data (the dictionary) is written by tools/build-dict.mjs: keep what is there.
  const sets = { webgpu: {}, wasm: {}, data: existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")).sets?.data || {} : {} };
  for (const [setName, slots] of Object.entries(PLAN)) {
    for (const [slot, spec] of Object.entries(slots)) {
      const name = spec.path.split("/").pop();
      const info = repos.get(spec.repo);
      const remote = info.files.get(spec.path);
      if (!remote) throw new Error(`${spec.repo} has no ${spec.path}`);
      const source = { repo: spec.repo, revision: info.sha, path: spec.path, license: spec.license };
      if (done.has(name)) {
        const prev = done.get(name);
        if (prev.source.repo !== spec.repo || prev.source.path !== spec.path) throw new Error(`file name clash: ${name}`);
        sets[setName][slot] = prev;
        continue;
      }
      const dest = join(MIRROR, name);
      const expected = remote.lfs?.sha256; // plain git files (vocab.txt) carry no LFS hash
      const have = existsSync(dest) && (!expected || (await sha256File(dest)) === expected);
      if (!have) {
        const local = join(LOCAL, name);
        if (expected && existsSync(local) && (await sha256File(local)) === expected) {
          console.log(`reuse   ${name} (tools/.cache/models matches the remote sha256)`);
          copyFileSync(local, dest);
        } else {
          const url = `https://huggingface.co/${spec.repo}/resolve/${info.sha}/${spec.path}`;
          console.log(`fetch   ${name}  <- ${url}`);
          await download(url, dest);
        }
      }
      const sha256 = await sha256File(dest);
      const bytes = statSync(dest).size;
      if (expected && sha256 !== expected) throw new Error(`${name}: sha256 ${sha256} != remote ${expected}`);
      if (bytes !== remote.size) throw new Error(`${name}: ${bytes} bytes != remote ${remote.size}`);
      const entry = { name, url: `${RELEASE_URL}/${name}`, sha256, bytes, source };
      done.set(name, entry);
      sets[setName][slot] = entry;
      console.log(`ok      ${name}  ${bytes} bytes  ${sha256}`);
    }
  }

  const manifest = { release: TAG, sets };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${MANIFEST}`);
  for (const [setName, slots] of Object.entries(sets)) {
    if (!Object.keys(slots).length) continue;
    const total = Object.values(slots).reduce((n, f) => n + f.bytes, 0);
    console.log(`set ${setName}: ${total} bytes`);
  }

  if (upload) {
    const notes =
      "Model files mirrored unchanged from Hugging Face for the anki_manga extension (SHA-256 pinned in " +
      "extension/engine/models.manifest.json). Licences: comic-text-detector*.onnx GPL-3.0 (dmMaze/comic-text-detector); " +
      "encoder_model_*.onnx, decoder_model*.onnx, vocab.txt Apache-2.0 (kha-white/manga-ocr); jmdict-eng.min.json.gz CC BY-SA 4.0 " +
      "(JMdict, EDRDG; compacted from scriptin/jmdict-simplified by tools/build-dict.mjs). Sources and revisions: " +
      [...done.values()].map((f) => `${f.name} = ${f.source.repo}@${f.source.revision.slice(0, 12)}/${f.source.path}`).join("; ");
    // Every manifest file that is in the mirror folder: the models and, once build-dict.mjs has run, the dictionary.
    const names = new Set([...done.keys(), ...Object.values(sets.data).map((f) => f.name)]);
    const files = [...names].filter((n) => existsSync(join(MIRROR, n))).map((n) => join(MIRROR, n));
    const args = ["release", "create", TAG, "--notes", notes, ...files];
    const r = spawnSync("gh", args, { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } else {
    console.log("(no --upload: nothing was published)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
