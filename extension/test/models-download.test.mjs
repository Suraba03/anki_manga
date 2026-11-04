// Verified model download: fake Cache Storage + fake fetch (no network, no real models).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ensureFiles, clearModels, buildModelSets } from "../engine/models.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (s) => new TextEncoder().encode(s);
const entry = (name, content) => ({ name, url: `https://models.example/${name}`, sha256: sha(content), bytes: content.length });

function fakeCache() {
  const store = new Map();
  return {
    store,
    puts: 0,
    async match(url) {
      return store.has(url) ? new Response(store.get(url).slice(0)) : undefined;
    },
    async put(url, res) {
      this.puts++;
      store.set(url, await res.arrayBuffer());
    },
    async delete(url) {
      return store.delete(url);
    },
    async keys() {
      return [...store.keys()].map((url) => ({ url }));
    },
  };
}

// serve: url -> Uint8Array. Records every requested url.
function fakeFetch(serve) {
  const fetched = [];
  const fn = async (url) => {
    fetched.push(url);
    const body = serve[url];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(body, { headers: { "Content-Length": String(body.length) } });
  };
  fn.fetched = fetched;
  return fn;
}

const A = bytesOf("alpha-bytes-0123456789");
const B = bytesOf("beta-bytes-abcdefghijklmnopqrstuvwxyz");
const files = [entry("a.onnx", A), entry("b.onnx", B)];
const served = () => ({ [files[0].url]: A, [files[1].url]: B });

test("missing files are fetched, verified and stored; result maps name to bytes", async () => {
  const cache = fakeCache();
  const fetch = fakeFetch(served());
  const out = await ensureFiles(files, { cache, fetch, onProgress() {} });
  assert.deepEqual([...out.keys()], ["a.onnx", "b.onnx"]);
  assert.deepEqual(new Uint8Array(out.get("a.onnx")), A);
  assert.deepEqual(new Uint8Array(out.get("b.onnx")), B);
  assert.equal(cache.store.size, 2);
  assert.ok(cache.store.has(files[0].url));
});

test("a cached file with the right hash is not fetched again", async () => {
  const cache = fakeCache();
  await ensureFiles(files, { cache, fetch: fakeFetch(served()), onProgress() {} });
  const fetch = fakeFetch(served());
  const out = await ensureFiles(files, { cache, fetch, onProgress() {} });
  assert.deepEqual(fetch.fetched, []);
  assert.deepEqual(new Uint8Array(out.get("b.onnx")), B);
});

test("only the missing file is fetched when the other is cached", async () => {
  const cache = fakeCache();
  cache.store.set(files[0].url, A.slice().buffer);
  const fetch = fakeFetch(served());
  await ensureFiles(files, { cache, fetch, onProgress() {} });
  assert.deepEqual(fetch.fetched, [files[1].url]);
});

test("a cached file with the wrong hash is dropped and fetched again", async () => {
  const cache = fakeCache();
  cache.store.set(files[0].url, bytesOf("tampered").buffer);
  const fetch = fakeFetch(served());
  const out = await ensureFiles(files, { cache, fetch, onProgress() {} });
  assert.deepEqual(fetch.fetched, [files[0].url, files[1].url]);
  assert.deepEqual(new Uint8Array(out.get("a.onnx")), A);
  assert.deepEqual(new Uint8Array(cache.store.get(files[0].url)), A);
});

test("wrong bytes -> model_corrupt; earlier verified files stay cached, the bad one is not stored, the next call fetches only it", async () => {
  const cache = fakeCache();
  const bad = { ...served(), [files[1].url]: bytesOf("evil-bytes-same-hash-no") };
  await assert.rejects(ensureFiles(files, { cache, fetch: fakeFetch(bad), onProgress() {} }), { error: "model_corrupt" });
  assert.deepEqual([...cache.store.keys()], [files[0].url]);
  assert.equal(cache.puts, 1);

  const fetch = fakeFetch(served());
  const out = await ensureFiles(files, { cache, fetch, onProgress() {} });
  assert.deepEqual(fetch.fetched, [files[1].url]);
  assert.equal(out.size, 2);
  assert.equal(cache.store.size, 2);
});

test("same-length wrong bytes -> model_corrupt and the bad file is never stored", async () => {
  const cache = fakeCache();
  const evil = new Uint8Array(B.length).fill(7);
  const bad = { ...served(), [files[1].url]: evil };
  await assert.rejects(ensureFiles(files, { cache, fetch: fakeFetch(bad), onProgress() {} }), { error: "model_corrupt" });
  assert.equal(cache.store.has(files[1].url), false);
});

test("an HTTP error -> model_download_failed, the failed file is not stored", async () => {
  const cache = fakeCache();
  const fetch = fakeFetch({ [files[0].url]: A }); // b.onnx -> 404
  await assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {} }), { error: "model_download_failed" });
  assert.equal(cache.store.has(files[1].url), false);
});

test("a fetch that rejects -> model_download_failed, the failed file is not stored", async () => {
  const cache = fakeCache();
  const fetch = async (url) => {
    if (url === files[1].url) throw new TypeError("network down");
    return new Response(A);
  };
  await assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {} }), { error: "model_download_failed" });
  assert.equal(cache.store.has(files[1].url), false);
});

test("three files, third stream dies mid-way -> first two stay cached, retry fetches only the third", async () => {
  const C = bytesOf("gamma-bytes-ZZZZZZZZZZZZZZZZZZZZZZZZ");
  const three = [...files, entry("c.onnx", C)];
  const cache = fakeCache();
  const dying = async (url) => {
    if (url === three[2].url) {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(C.slice(0, 5));
          },
          pull() {
            throw new Error("connection reset");
          },
        }),
      );
    }
    return new Response(url === three[0].url ? A : B);
  };
  await assert.rejects(ensureFiles(three, { cache, fetch: dying, onProgress() {} }), { error: "model_download_failed" });
  assert.deepEqual([...cache.store.keys()], [three[0].url, three[1].url]);

  const fetch = fakeFetch({ [three[2].url]: C });
  const out = await ensureFiles(three, { cache, fetch, onProgress() {} });
  assert.deepEqual(fetch.fetched, [three[2].url]);
  assert.equal(out.size, 3);
  assert.equal(cache.store.size, 3);
});

test("an oversized body -> model_corrupt, reader cancelled, file not stored", async () => {
  const cache = fakeCache();
  let cancelled = false;
  const fetch = async (url) => {
    if (url !== files[1].url) return new Response(A);
    return new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(16)); // never ends: must be cut off at files[1].bytes
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  };
  await assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {} }), { error: "model_corrupt" });
  assert.equal(cancelled, true);
  assert.equal(cache.store.has(files[1].url), false);
});

test("a non-OK response body is cancelled", async () => {
  const cache = fakeCache();
  let cancelled = false;
  const fetch = async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(4));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    );
  await assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {} }), { error: "model_download_failed" });
  assert.equal(cancelled, true);
});

test("a body stream that dies mid-way -> model_download_failed, nothing stored", async () => {
  const cache = fakeCache();
  const fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(A.slice(0, 5));
        },
        pull() {
          throw new Error("connection reset");
        },
      }),
    );
  await assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {} }), { error: "model_download_failed" });
  assert.equal(cache.store.size, 0);
});

test("onProgress is monotonic, streams in chunks and reaches 1", async () => {
  const cache = fakeCache();
  const chunked = (body) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < body.length; i += 4) c.enqueue(body.slice(i, i + 4));
          c.close();
        },
      }),
    );
  const fetch = async (url) => chunked(url === files[0].url ? A : B);
  const seen = [];
  await ensureFiles(files, { cache, fetch, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length > 3);
  assert.equal(seen.at(-1), 1);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1]);
  assert.ok(seen.slice(0, -1).every((f) => f >= 0 && f < 1));
});

test("onProgress(1) is reported when everything was cached", async () => {
  const cache = fakeCache();
  await ensureFiles(files, { cache, fetch: fakeFetch(served()), onProgress() {} });
  const seen = [];
  await ensureFiles(files, { cache, fetch: fakeFetch({}), onProgress: (f) => seen.push(f) });
  assert.deepEqual(seen, [0, 1], "the size announcement (nothing to download), then done");
});

test("clearModels empties the cache so the next call downloads again", async () => {
  const cache = fakeCache();
  await ensureFiles(files, { cache, fetch: fakeFetch(served()), onProgress() {} });
  await clearModels(cache);
  assert.equal(cache.store.size, 0);
  const fetch = fakeFetch(served());
  await ensureFiles(files, { cache, fetch, onProgress() {} });
  assert.equal(fetch.fetched.length, 2);
});

test("buildModelSets exposes webgpu, wasm and an empty data slot from the manifest", () => {
  const f = (n) => ({ name: n, url: `u/${n}`, sha256: "0".repeat(64), bytes: 1 });
  const manifest = {
    sets: {
      webgpu: { det: f("d1"), enc: f("e1"), dec: f("c1"), vocab: f("vocab.txt") },
      wasm: { det: f("d2"), enc: f("e2"), dec: f("c2"), vocab: f("vocab.txt") },
      data: {},
    },
  };
  const sets = buildModelSets(manifest);
  assert.equal(sets.webgpu.det.name, "d1");
  assert.equal(sets.wasm.dec.name, "c2");
  assert.deepEqual(sets.data, {});
});

test("buildModelSets rejects a malformed manifest", () => {
  assert.throws(() => buildModelSets({ sets: { webgpu: {}, wasm: {}, data: {} } }));
  assert.throws(() => buildModelSets({}));
});

test("the committed manifest is well formed: pinned release URLs, sha256, unique names per hash", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../engine/models.manifest.json", import.meta.url), "utf8"));
  const sets = buildModelSets(manifest);
  const byName = new Map();
  for (const set of [sets.webgpu, sets.wasm]) {
    for (const f of Object.values(set)) {
      assert.ok(f.url.startsWith("https://github.com/Suraba03/anki_manga/releases/download/models-1/"), f.url);
      assert.ok(f.url.endsWith(`/${f.name}`));
      assert.equal(byName.get(f.name) ?? f.sha256, f.sha256, `${f.name} has two different hashes`);
      byName.set(f.name, f.sha256);
    }
  }
  assert.equal(sets.webgpu.vocab.sha256, sets.wasm.vocab.sha256);
});

// A clock that moves 5 ms on every read, so every measured span is positive and deterministic in order.
function tickingClock() {
  let t = 0;
  return () => (t += 5);
}

test("progress carries received and total bytes of the files that need downloading", async () => {
  const cache = fakeCache();
  cache.store.set(files[0].url, A.slice().buffer); // a.onnx cached: only b.onnx counts
  const seen = [];
  await ensureFiles(files, { cache, fetch: fakeFetch(served()), onProgress: (p, info) => seen.push([p, info.receivedBytes, info.totalBytes]) });
  assert.deepEqual(seen[0], [0, 0, B.length], "the size is announced before the first byte");
  assert.deepEqual(seen.at(-1), [1, B.length, B.length]);
  for (const [, got, total] of seen) assert.ok(got <= total);
});

test("a warm start (everything cached) reports totalBytes 0", async () => {
  const cache = fakeCache();
  await ensureFiles(files, { cache, fetch: fakeFetch(served()), onProgress() {} });
  const seen = [];
  await ensureFiles(files, { cache, fetch: fakeFetch({}), onProgress: (p, info) => seen.push([p, info.totalBytes]) });
  assert.deepEqual(seen, [[0, 0], [1, 0]]);
});

test("per-file timings: cache read + hash for a hit, download + hash + cache write for a miss", async () => {
  const cache = fakeCache();
  cache.store.set(files[0].url, A.slice().buffer);
  let last;
  await ensureFiles(files, { cache, fetch: fakeFetch(served()), onProgress: (p, info) => (last = info), now: tickingClock() });
  const [a, b] = last.files;
  assert.equal(a.name, "a.onnx");
  assert.equal(a.source, "cache");
  assert.equal(a.bytes, A.length);
  assert.ok(a.readMs > 0 && a.hashMs > 0);
  assert.equal(b.name, "b.onnx");
  assert.equal(b.source, "network");
  assert.equal(b.bytes, B.length);
  assert.ok(b.downloadMs > 0 && b.hashMs > 0 && b.putMs > 0);
});
