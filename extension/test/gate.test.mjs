import test from "node:test";
import assert from "node:assert/strict";
import { ocrScopeFor, resolveScope, pageGate, retireEngine, waitPrepared } from "../engine/gate.js";

test("ocrScopeFor: an explicit perfMode decides by itself", () => {
  for (const mode of [undefined, "prefetch", "on-demand"]) {
    assert.equal(ocrScopeFor("prefetch", mode), "all");
    assert.equal(ocrScopeFor("on-demand", mode), "none");
  }
});

test("ocrScopeFor: auto follows the measured mode, and says 'auto' while it is not known yet", () => {
  assert.equal(ocrScopeFor("auto", "prefetch"), "all");
  assert.equal(ocrScopeFor("auto", "on-demand"), "none");
  assert.equal(ocrScopeFor("auto", undefined), "auto");
  assert.equal(ocrScopeFor("auto", null), "auto");
});

test("resolveScope: 'auto' becomes all or none by the measured mode; the other scopes pass through", () => {
  assert.equal(resolveScope("auto", "prefetch"), "all");
  assert.equal(resolveScope("auto", "on-demand"), "none");
  assert.equal(resolveScope("all", "on-demand"), "all");
  assert.equal(resolveScope("none", "prefetch"), "none");
});

test("pageGate: busy replies before ready, models_loading until the engine is prepared, then open", () => {
  const down = pageGate({ state: "downloading", progress: 0.5, receivedBytes: 5, totalBytes: 10 }, null);
  assert.equal(down.error, "models_downloading");
  assert.equal(pageGate({ state: "loading", firstRun: true }, null).error, "models_loading");
  const waiting = pageGate({ state: "ready", ep: "wasm", firstRun: true }, null);
  assert.deepEqual(waiting, { ok: false, error: "models_loading", models: { receivedBytes: 0, totalBytes: 0, firstRun: true } });
  assert.equal(pageGate({ state: "ready", ep: "wasm", mode: "prefetch" }, null).error, "models_loading", "a saved mode does not mean the warm-up is done");
  assert.equal(pageGate({ state: "ready", ep: "wasm" }, { mode: "prefetch" }), null);
});

test("retireEngine: disposes the old engine and returns null; a failing dispose is swallowed", async () => {
  const disposed = [];
  assert.equal(await retireEngine({ dispose: async () => void disposed.push(1) }), null);
  assert.deepEqual(disposed, [1]);
  assert.equal(await retireEngine(null), null);
  const errors = [];
  assert.equal(
    await retireEngine({ dispose: async () => Promise.reject(new Error("boom")) }, (e) => errors.push(e.message)),
    null,
  );
  assert.deepEqual(errors, ["boom"]);
});

test("waitPrepared: resolves with the benchmark when it arrives in time", async () => {
  const bench = { mode: "prefetch" };
  assert.equal(await waitPrepared(new Promise((r) => setTimeout(() => r(bench), 5)), 500), bench);
});

test("waitPrepared: null after the timeout, without waiting for the promise", async () => {
  const t0 = Date.now();
  assert.equal(await waitPrepared(new Promise(() => {}), 20), null);
  assert.ok(Date.now() - t0 < 400);
});

test("waitPrepared: a rejected promise gives null, not a throw", async () => {
  assert.equal(await waitPrepared(Promise.reject(new Error("boom")), 500), null);
});
