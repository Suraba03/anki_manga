// Pinned model files: verified download into Cache Storage. Models are data, not code: every file is pinned by
// URL and SHA-256 (engine/models.manifest.json, written by tools/mirror-models.mjs) and checked before it is used.

// Rejection value of ensureFiles: error is "model_corrupt" or "model_download_failed".
export class ModelError extends Error {
  constructor(error, detail) {
    super(detail ? `${error}: ${detail}` : error);
    this.name = "ModelError";
    this.error = error;
  }
}

const SLOTS = ["det", "enc", "dec", "vocab"];

// Turns the parsed manifest into {webgpu:{det,enc,dec,vocab}, wasm:{...}, data:{}}. The caller supplies the
// manifest (the offscreen document fetches it via chrome.runtime.getURL) because JSON import attributes
// need Chrome 123 and the extension supports 116. `data` holds non-model files (the dictionary).
export function buildModelSets(manifest) {
  const sets = manifest?.sets;
  if (!sets) throw new Error("bad model manifest: no sets");
  const check = (f, where) => {
    if (!f || !f.name || !f.url || !/^[0-9a-f]{64}$/.test(f.sha256) || !(f.bytes > 0)) {
      throw new Error(`bad model manifest entry: ${where}`);
    }
    return { name: f.name, url: f.url, sha256: f.sha256, bytes: f.bytes };
  };
  const out = { data: {} };
  for (const set of ["webgpu", "wasm"]) {
    out[set] = {};
    for (const slot of SLOTS) out[set][slot] = check(sets[set]?.[slot], `${set}.${slot}`);
  }
  for (const [key, f] of Object.entries(sets.data || {})) out.data[key] = check(f, `data.${key}`);
  return out;
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Reads the body into a buffer preallocated from the manifest size, reporting each chunk through onBytes.
// A body longer than `size` is cut off (reader cancelled) and rejected as model_corrupt, so memory stays bounded.
async function readBody(res, size, onBytes) {
  const out = new Uint8Array(size);
  let at = 0;
  const take = (chunk) => {
    if (at + chunk.length > size) return false;
    out.set(chunk, at);
    at += chunk.length;
    onBytes(chunk.length);
    return true;
  };
  if (!res.body || !res.body.getReader) {
    if (!take(new Uint8Array(await res.arrayBuffer()))) throw new ModelError("model_corrupt", "longer than expected");
    return { out, length: at };
  }
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!take(value)) {
        await reader.cancel().catch(() => {});
        throw new ModelError("model_corrupt", "longer than expected");
      }
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return { out, length: at };
}

// files: [{name,url,sha256,bytes}]. cache: {match,put,delete} (Cache Storage subset). Resolves to
// Map<name, ArrayBuffer> of verified bytes. A cached file is re-hashed and dropped if it no longer matches.
// Each file is cached as soon as it verifies (a later failure keeps the earlier ones: resume per file);
// a file that fails verification is never stored.
export async function ensureFiles(files, { cache, fetch: fetchFn = globalThis.fetch, onProgress = () => {} }) {
  const result = new Map();
  const missing = [];
  for (const f of files) {
    const hit = await cache.match(f.url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      if ((await sha256Hex(buf)) === f.sha256) {
        result.set(f.name, buf);
        continue;
      }
      await cache.delete(f.url);
    }
    missing.push(f);
  }

  const totalBytes = missing.reduce((n, f) => n + f.bytes, 0);
  let received = 0;
  const report = () => onProgress(Math.min(received / totalBytes, 0.999));
  for (const f of missing) {
    let body;
    try {
      const res = await fetchFn(f.url);
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      body = await readBody(res, f.bytes, (n) => {
        received += n;
        report();
      });
    } catch (e) {
      if (e instanceof ModelError) throw e;
      throw new ModelError("model_download_failed", `${f.name}: ${e?.message || e}`);
    }
    if (body.length !== f.bytes || (await sha256Hex(body.out)) !== f.sha256) throw new ModelError("model_corrupt", f.name);
    try {
      await cache.put(f.url, new Response(body.out));
    } catch (e) {
      await cache.delete(f.url).catch(() => {});
      throw new ModelError("model_download_failed", `cache write failed: ${e?.message || e}`);
    }
    result.set(f.name, body.out.buffer);
  }
  onProgress(1);
  return new Map(files.map((f) => [f.name, result.get(f.name)]));
}

// Drops every cached model file (the models cache holds nothing else).
export async function clearModels(cache) {
  for (const req of await cache.keys()) await cache.delete(req.url);
}
