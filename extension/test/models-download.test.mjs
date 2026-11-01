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

test("wrong bytes -> model_corrupt, nothing stored, the next call fetches again", async () => {
  const cache = fakeCache();
  const bad = { ...served(), [files[1].url]: bytesOf("evil-bytes-same-hash-no") };
  await assert.rejects(ensureFiles(files, { cache, fetch: fakeFetch(bad), onProgress() {} }), { error: "model_corrupt" });
  assert.equal(cache.store.size, 0);
  assert.equal(cache.puts, 0);

  const fetch = fakeFetch(served());
  const out = await ensureFiles(files, { cache, fetch, onProgress() {} });
  assert.deepEqual(fetch.fetched, [files[0].url, files[1].url]);
  assert.equal(out.size, 2);
  assert.equal(cache.store.size, 2);
});

test("an HTTP error -> model_download_failed, nothing stored", async () => {
  const cache = fakeCache();
  const fetch = fakeFetch({ [files[0].url]: A }); // b.onnx -> 404
  await assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {} }), { error: "model_download_failed" });
  assert.equal(cache.store.size, 0);
});

test("a fetch that rejects -> model_download_failed, nothing stored", async () => {
  const cache = fakeCache();
  const fetch = async (url) => {
    if (url === files[1].url) throw new TypeError("network down");
    return new Response(A);
  };
  await assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {} }), { error: "model_download_failed" });
  assert.equal(cache.store.size, 0);
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
  assert.deepEqual(seen, [1]);
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
