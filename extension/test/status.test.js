const test = require("node:test");
const assert = require("node:assert/strict");
const Status = require("../content/status.js");

test("badge while the helper looks for bubbles", () => {
  assert.deepEqual(Status.badge({ phase: "detecting" }), { text: "⏳ finding bubbles…", kind: "busy" });
});

test("badge counts recognized bubbles, then turns into a fading check", () => {
  assert.deepEqual(Status.badge({ phase: "ocr", done: 4, total: 11 }), { text: "⏳ 4/11", kind: "busy" });
  assert.deepEqual(Status.badge({ phase: "ocr", done: 11, total: 11 }), { text: "✓ 11", kind: "done" });
  assert.deepEqual(Status.badge({ phase: "ocr", done: 0, total: 0 }), { text: "✓ no text", kind: "done" });
});

test("badge explains errors and stays", () => {
  assert.deepEqual(Status.badge({ phase: "error", error: "engine_error" }), {
    text: "⚠ recognition failed — see the side panel",
    kind: "error",
  });
  assert.deepEqual(Status.badge({ phase: "error", error: "extension_reloaded" }), {
    text: "⚠ extension reloaded — refresh the page",
    kind: "error",
  });
  assert.equal(Status.badge({ phase: "error", error: "weird" }).text, "⚠ weird");
});

test("engine still preparing models is shown as busy, not as an error", () => {
  assert.deepEqual(Status.badge({ phase: "error", error: "models_downloading" }), {
    text: "⏳ downloading models…",
    kind: "busy",
  });
  assert.deepEqual(Status.badge({ phase: "error", error: "models_loading" }), {
    text: "⏳ loading models…",
    kind: "busy",
  });
});

test("v1 helper codes are gone and fall back to the raw code", () => {
  for (const code of ["helper_unreachable", "bad_token", "warming"]) {
    assert.deepEqual(Status.badge({ phase: "error", error: code }), { text: `⚠ ${code}`, kind: "error" });
  }
});

test("no badge for images that aren't manga pages", () => {
  assert.equal(Status.badge(null), null);
  assert.equal(Status.badge({ phase: "error", error: "not_manga" }), null);
});

test("summary for the panel", () => {
  const s = Status.summary([
    { phase: "ocr", done: 3, total: 3 },
    { phase: "ocr", done: 0, total: 0 },
    { phase: "ocr", done: 1, total: 5 },
    { phase: "detecting" },
    { phase: "error", error: "fetch_failed" },
    { phase: "error", error: "not_manga" },
    { phase: "error", error: "models_loading" },
  ]);
  assert.deepEqual(s, { ready: 2, working: 3, failed: 1 });
  assert.equal(Status.summaryText(s), "Pages: 2 ready · 3 recognizing · 1 failed");
  assert.equal(Status.summaryText({ ready: 6, working: 0, failed: 0 }), "Pages: 6 ready");
  assert.equal(Status.summaryText({ ready: 0, working: 0, failed: 0 }), "No manga pages found yet");
});

test("engine busy with a download: the badge shows the size, then that the models are being prepared", () => {
  const down = (receivedBytes, totalBytes) => ({ phase: "error", error: "models_downloading", models: { receivedBytes, totalBytes } });
  assert.deepEqual(Status.badge(down(120e6, 336.7e6)), { text: "⏳ models 120/337 MB", kind: "busy" });
  assert.equal(Status.badge(down(0, 336.7e6)).text, "⏳ models 0/337 MB");
  assert.equal(Status.badge({ phase: "error", error: "models_loading", models: { firstRun: true } }).text, "⏳ preparing models…");
  // No size (not known yet, or nothing to download) and a warm load: the engine is starting.
  assert.equal(Status.badge(down(0, 0)).text, "⏳ starting OCR…");
  assert.equal(Status.badge({ phase: "error", error: "models_loading", models: { firstRun: false } }).text, "⏳ starting OCR…");
  assert.equal(Status.badge({ phase: "error", error: "models_loading" }).text, "⏳ loading models…", "an engine without the field");
});
