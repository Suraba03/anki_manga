import test from "node:test";
import assert from "node:assert/strict";
import { busyReply } from "../engine/busy.js";

test("a ready engine takes work", () => {
  assert.equal(busyReply({ state: "ready", ep: "webgpu" }), null);
});

test("downloading: the reply carries the bytes so the page badge can show them", () => {
  const status = { state: "downloading", progress: 0.36, receivedBytes: 120, totalBytes: 337, etaSec: 50, firstRun: undefined };
  assert.deepEqual(busyReply(status), { ok: false, error: "models_downloading", models: { receivedBytes: 120, totalBytes: 337, firstRun: false } });
});

test("loading: the reply says whether this is the first run", () => {
  assert.deepEqual(busyReply({ state: "loading", firstRun: true, receivedBytes: 337, totalBytes: 337 }), {
    ok: false,
    error: "models_loading",
    models: { receivedBytes: 337, totalBytes: 337, firstRun: true },
  });
});

test("before any size is known the counts are 0", () => {
  assert.deepEqual(busyReply({ state: "downloading", progress: 0 }).models, { receivedBytes: 0, totalBytes: 0, firstRun: false });
});
