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

// How many files download at once. Chrome multiplexes parallel fetches to the same host over one HTTP/2 connection,
// which measured no faster than one stream from GitHub (E1-6, 2026-11-08); the pool stays for a host where more
// connections help.
export const DOWNLOAD_STREAMS = 1;

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
// If `signal` aborts before the whole body is in, the reader is cancelled and the read throws (an explicit check:
// a real fetch rejects the pending read on abort, but a stream that merely stalls would not).
async function readBody(res, size, onBytes, signal) {
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
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      if (signal?.aborted && at < size) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) {
        if (signal?.aborted && at < size) throw new Error("aborted");
        break;
      }
      if (!take(value)) {
        await reader.cancel().catch(() => {});
        throw new ModelError("model_corrupt", "longer than expected");
      }
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return { out, length: at };
}

// files: [{name,url,sha256,bytes}]. cache: {match,put,delete} (Cache Storage subset). Resolves to
// Map<name, ArrayBuffer> of verified bytes, in input order. A cached file is re-hashed and dropped if it no longer
// matches. The cache check is sequential; then the missing files download through `streams` concurrent streams
// (default DOWNLOAD_STREAMS), taken from the list in input order, so the first file (the detector) starts first.
// The cap counts downloads only: once a file's body is in, its stream takes the next file at once while the
// verification (length + SHA-256) and the cache write of the finished file run concurrently.
// Each file is cached as soon as it verifies (a later failure keeps the earlier ones: resume per file);
// a file that fails verification is never stored.
// The first failure wins: it is the rejection value, the shared AbortController aborts the other streams (their
// own errors are ignored) and no new file starts. A file whose bytes were all received before the abort is still
// verified and stored. A verify or cache failure is a failure like any other. ensureFiles settles only after every
// download and every pending verify/put has settled, so nothing is written to the cache once the returned promise
// has settled.
// onProgress(fraction, {receivedBytes, totalBytes, files}): totalBytes counts only the files that need downloading
// (0 on a warm start) and is announced once the cache is checked, before the first byte; receivedBytes is summed
// over all streams. `files` holds a timing record per finished file, in completion order: {name, source: "cache",
// bytes, readMs, hashMs} or {name, source: "network", bytes, downloadMs, hashMs, putMs}.
// Downloads overlap (with each other when streams > 1, and with the previous file's hash and put), so the spans of
// different files overlap too.
export async function ensureFiles(
  files,
  { cache, fetch: fetchFn = globalThis.fetch, onProgress = () => {}, now = () => performance.now(), streams = DOWNLOAD_STREAMS },
) {
  const result = new Map();
  const missing = [];
  const timings = [];
  for (const f of files) {
    const t0 = now();
    const hit = await cache.match(f.url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      const t1 = now();
      const ok = (await sha256Hex(buf)) === f.sha256;
      if (ok) {
        timings.push({ name: f.name, source: "cache", bytes: buf.byteLength, readMs: t1 - t0, hashMs: now() - t1 });
        result.set(f.name, buf);
        continue;
      }
      await cache.delete(f.url);
    }
    missing.push(f);
  }

  const totalBytes = missing.reduce((n, f) => n + f.bytes, 0);
  let received = 0;
  const info = () => ({ receivedBytes: received, totalBytes, files: timings.slice() });
  const report = () => onProgress(totalBytes ? Math.min(received / totalBytes, 0.999) : 0, info());
  report();

  const controller = new AbortController();
  const { signal } = controller;
  let firstError = null;
  const fail = (e) => {
    if (firstError) return; // an error caused by the abort (or a later one) never replaces the first
    firstError = e;
    controller.abort();
  };

  // Fetches and reads the whole body; the download slot is free as soon as this returns.
  const download = async (f) => {
    const t0 = now();
    try {
      const res = await fetchFn(f.url, { signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await readBody(
        res,
        f.bytes,
        (n) => {
          received += n;
          if (!firstError) report();
        },
        signal,
      );
      return { body, downloadMs: now() - t0 };
    } catch (e) {
      if (e instanceof ModelError) throw e;
      throw new ModelError("model_download_failed", `${f.name}: ${e?.message || e}`);
    }
  };

  // Checks length + SHA-256 and stores the file; runs concurrently with the next download.
  const verifyAndStore = async (f, { body, downloadMs }) => {
    const t1 = now();
    if (body.length !== f.bytes || (await sha256Hex(body.out)) !== f.sha256) throw new ModelError("model_corrupt", f.name);
    const t2 = now();
    try {
      await cache.put(f.url, new Response(body.out));
    } catch (e) {
      await cache.delete(f.url).catch(() => {});
      throw new ModelError("model_download_failed", `cache write failed: ${e?.message || e}`);
    }
    timings.push({ name: f.name, source: "network", bytes: body.length, downloadMs, hashMs: t2 - t1, putMs: now() - t2 });
    result.set(f.name, body.out.buffer);
  };

  let next = 0;
  const pending = [];
  const worker = async () => {
    while (!firstError && next < missing.length) {
      const f = missing[next++];
      try {
        const got = await download(f);
        pending.push(verifyAndStore(f, got).catch(fail));
      } catch (e) {
        fail(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, streams), missing.length) }, worker));
  await Promise.all(pending);
  if (firstError) throw firstError;
  onProgress(1, info());
  return new Map(files.map((f) => [f.name, result.get(f.name)]));
}

// Drops every cached model file (the models cache holds nothing else).
export async function clearModels(cache) {
  for (const req of await cache.keys()) await cache.delete(req.url);
}
