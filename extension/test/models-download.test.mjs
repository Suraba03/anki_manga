// Verified model download: fake Cache Storage + fake fetch (no network, no real models).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ensureFiles, clearModels, buildModelSets, DOWNLOAD_STREAMS } from "../engine/models.js";

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
  await assert.rejects(ensureFiles(files, { cache, fetch: fakeFetch(bad), onProgress() {}, streams: 1 }), { error: "model_corrupt" });
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
  await assert.rejects(ensureFiles(three, { cache, fetch: dying, onProgress() {}, streams: 1 }), { error: "model_download_failed" });
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

// ---- parallel downloads -------------------------------------------------------------------------------------------

const C_BYTES = bytesOf("gamma-bytes-ZZZZZZZZZZZZZZZZZZZZZZZZ");
const D_BYTES = bytesOf("delta-bytes-0000000000000000000000000000");
const four = [...files, entry("c.onnx", C_BYTES), entry("d.onnx", D_BYTES)];
const servedFour = () => ({ ...served(), [four[2].url]: C_BYTES, [four[3].url]: D_BYTES });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, what = "condition") {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await sleep(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// Every body is held back until st.openAll(); st.max is the most files in flight (from the fetch call until the body ended).
function gatedFetch(serve) {
  const st = { calls: [], inflight: 0, max: 0, open: false, waiters: [] };
  st.openAll = () => {
    st.open = true;
    st.waiters.forEach((r) => r());
  };
  const gate = () => (st.open ? Promise.resolve() : new Promise((r) => st.waiters.push(r)));
  const fn = async (url) => {
    st.calls.push(url);
    st.max = Math.max(st.max, ++st.inflight);
    return new Response(
      new ReadableStream({
        async pull(c) {
          await gate();
          c.enqueue(serve[url]);
          c.close();
          st.inflight--;
        },
      }),
    );
  };
  fn.st = st;
  return fn;
}

test("at most `streams` files are in flight, and the default is DOWNLOAD_STREAMS", async () => {
  assert.equal(DOWNLOAD_STREAMS, 3);
  for (const [opts, expected] of [[{ streams: 2 }, 2], [{ streams: 3 }, 3], [{}, DOWNLOAD_STREAMS]]) {
    const cache = fakeCache();
    const fetch = gatedFetch(servedFour());
    const run = ensureFiles(four, { cache, fetch, onProgress() {}, ...opts });
    await until(() => fetch.st.calls.length === expected, `${expected} fetches`);
    await sleep(30);
    assert.equal(fetch.st.calls.length, expected, "no further file starts while the streams are busy");
    fetch.st.openAll();
    const out = await run;
    assert.equal(fetch.st.max, expected);
    assert.deepEqual([...out.keys()], four.map((f) => f.name));
    assert.equal(cache.store.size, 4);
  }
});

test("files are fetched in input order, the first one (the detector) first", async () => {
  const fetch = gatedFetch(servedFour());
  fetch.st.openAll();
  await ensureFiles(four, { cache: fakeCache(), fetch, onProgress() {}, streams: 3 });
  assert.deepEqual(fetch.st.calls, four.map((f) => f.url));
});

test("progress sums the bytes of all streams and stays monotonic", async () => {
  const cache = fakeCache();
  const ctl = {};
  const fetch = async (url) => new Response(new ReadableStream({ start: (c) => (ctl[url] = c) }));
  const seen = [];
  const run = ensureFiles(files, { cache, fetch, onProgress: (p, i) => seen.push([p, i.receivedBytes, i.totalBytes]), streams: 2 });
  const [a, b] = files;
  await until(() => ctl[a.url] && ctl[b.url], "both streams");
  const ha = Math.floor(A.length / 2);
  const hb = Math.floor(B.length / 2);
  ctl[a.url].enqueue(A.slice(0, 3));
  ctl[b.url].enqueue(B.slice(0, 3));
  ctl[a.url].enqueue(A.slice(3, ha));
  ctl[b.url].enqueue(B.slice(3, hb));
  await until(() => seen.at(-1)[1] === ha + hb, "bytes of both files");
  assert.equal(cache.store.size, 0, "neither file has finished yet");
  ctl[a.url].enqueue(A.slice(ha));
  ctl[a.url].close();
  ctl[b.url].enqueue(B.slice(hb));
  ctl[b.url].close();
  await run;
  const total = A.length + B.length;
  assert.deepEqual(seen[0], [0, 0, total]);
  assert.deepEqual(seen.at(-1), [1, total, total]);
  for (let i = 0; i < seen.length; i++) {
    assert.ok(seen[i][1] <= total);
    if (i > 0) assert.ok(seen[i][0] >= seen[i - 1][0] && seen[i][1] >= seen[i - 1][1]);
    if (i < seen.length - 1) assert.ok(seen[i][0] < 1);
  }
});

test("one failure cancels the other streams, keeps the verified file, and nothing is stored after the rejection", async () => {
  const three = [...files, four[2]];
  const cache = fakeCache();
  let release500;
  const gate500 = new Promise((r) => (release500 = r));
  let bSignal;
  let bCancelled = false;
  const fetch = async (url, opts) => {
    if (url === three[0].url) return new Response(A);
    if (url === three[1].url) {
      bSignal = opts?.signal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(B.slice(0, 5)); // then held open
          },
          cancel() {
            bCancelled = true;
          },
        }),
      );
    }
    await gate500;
    return new Response("boom", { status: 500 });
  };
  const outcome = assert.rejects(ensureFiles(three, { cache, fetch, onProgress() {}, streams: 3 }), { error: "model_download_failed" });
  await until(() => cache.store.has(three[0].url) && bSignal, "a stored and b streaming");
  release500();
  await outcome;
  assert.equal(bSignal.aborted, true);
  assert.equal(bCancelled, true);
  assert.deepEqual([...cache.store.keys()], [three[0].url]);
  const puts = cache.puts;
  await sleep(30);
  assert.equal(cache.puts, puts, "no cache.put after the rejection");

  const retry = fakeFetch({ [three[1].url]: B, [three[2].url]: C_BYTES });
  const out = await ensureFiles(three, { cache, fetch: retry, onProgress() {} });
  assert.deepEqual(retry.fetched, [three[1].url, three[2].url]);
  assert.equal(out.size, 3);
});

test("a corrupt file is never stored when another file downloads fine at the same time", async () => {
  const cache = fakeCache();
  const evil = new Uint8Array(B.length).fill(7);
  const fetch = fakeFetch({ ...served(), [files[1].url]: evil });
  await assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {} }), { error: "model_corrupt" });
  assert.equal(cache.store.has(files[1].url), false);
});

test("the first error wins: an aborted stream's own error does not replace it", async () => {
  const three = [...files, four[2]];
  const cache = fakeCache();
  const fetch = async (url, opts) => {
    if (url === three[0].url) return new Response(A);
    if (url === three[1].url) {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(B.slice(0, 5)); // held open; errors out when aborted, like a real fetch
            opts.signal.addEventListener("abort", () => c.error(new Error("aborted by signal")));
          },
        }),
      );
    }
    return new Response(new Uint8Array(C_BYTES.length).fill(9)); // same length, wrong bytes
  };
  await assert.rejects(ensureFiles(three, { cache, fetch, onProgress() {}, streams: 3 }), { error: "model_corrupt" });
  assert.equal(cache.store.has(three[2].url), false);
  assert.equal(cache.store.has(three[1].url), false);
});

test("a file fully received before the abort is still verified and stored, and the call waits for it", async () => {
  const cache = fakeCache();
  const put = cache.put;
  let putEntered = false;
  let releasePut;
  const putGate = new Promise((r) => (releasePut = r));
  cache.put = async (url, res) => {
    putEntered = true;
    await putGate;
    return put.call(cache, url, res);
  };
  let aSignal;
  const fetch = async (url, opts) => {
    if (url === files[0].url) {
      aSignal = opts?.signal;
      return new Response(A);
    }
    while (!putEntered) await sleep(1);
    return new Response("boom", { status: 500 });
  };
  let settled = false;
  const outcome = assert.rejects(ensureFiles(files, { cache, fetch, onProgress() {}, streams: 2 }), { error: "model_download_failed" }).then(() => (settled = true));
  await until(() => aSignal?.aborted, "the abort");
  await sleep(30);
  assert.equal(settled, false, "ensureFiles waits for the file that is being stored");
  assert.equal(cache.store.has(files[0].url), false);
  releasePut();
  await outcome;
  assert.deepEqual([...cache.store.keys()], [files[0].url]);
});
