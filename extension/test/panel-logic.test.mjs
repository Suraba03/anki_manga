import test from "node:test";
import assert from "node:assert/strict";
import { explainErrorMessage, modelStatusLine, freeLeftText, ankiErrorMessage, pictureFilename } from "../panel/logic.js";

test("free-tier and no_text copy is exact", () => {
  assert.deepEqual(explainErrorMessage("free_daily_limit"), {
    text: "Today's free explanations are used up — they reset tomorrow. Add your own API key to keep going.",
    action: "own_key",
  });
  assert.deepEqual(explainErrorMessage("free_monthly_cap"), {
    text: "Free explanations are used up for this month. Add your own API key to keep going.",
    action: "own_key",
  });
  assert.deepEqual(explainErrorMessage("free_unavailable"), {
    text: "The free explanation service is unavailable right now. Try again later or add your own API key.",
    action: "own_key",
  });
  assert.deepEqual(explainErrorMessage("no_text"), { text: "No text was recognized in this bubble.", action: null });
});

test("v1 error copy is unchanged", () => {
  const v1 = {
    no_api_key: "Add your DeepSeek API key in Settings to get explanations.",
    auth: "DeepSeek rejected the API key — check it in Settings.",
    bad_response: "Explanation failed — click the bubble again to retry.",
    no_balance: "Your DeepSeek account has no balance — top it up on platform.deepseek.com.",
    rate_limited: "DeepSeek is rate-limiting requests — wait a moment and click the bubble again.",
    page_expired: "This page is no longer cached — scroll back to it and try again.",
  };
  for (const [code, text] of Object.entries(v1)) assert.deepEqual(explainErrorMessage(code), { text, action: null }, code);
  // v1 showed the generic message for a dropped connection, too
  assert.deepEqual(explainErrorMessage("network"), { text: v1.bad_response, action: null });
});

test("unknown codes name the code", () => {
  assert.deepEqual(explainErrorMessage("zzz"), { text: "Something went wrong (zzz).", action: null });
});

test("model status line", () => {
  assert.deepEqual(modelStatusLine({ state: "downloading", progress: 0.4237 }), { kind: "warming", text: "Downloading models… 42%", retry: null });
  assert.deepEqual(modelStatusLine({ state: "downloading", progress: 0 }), { kind: "warming", text: "Downloading models… 0%", retry: null });
  assert.deepEqual(modelStatusLine({ state: "loading", progress: 1, ep: "webgpu" }), { kind: "warming", text: "Loading models…", retry: null });
  assert.deepEqual(modelStatusLine({ state: "ready", ep: "webgpu" }), { kind: "ready", text: "Ready (WebGPU)", retry: null });
  assert.deepEqual(modelStatusLine({ state: "ready", ep: "wasm" }), { kind: "ready", text: "Ready (CPU)", retry: null });
  assert.deepEqual(modelStatusLine({ state: "error", error: "model_download_failed" }), {
    kind: "down",
    text: "Model download failed — check your connection.",
    retry: "Retry",
  });
  assert.deepEqual(modelStatusLine({ state: "error", error: "model_corrupt" }).text, "A downloaded model file failed its check.");
  assert.deepEqual(modelStatusLine({ state: "error", error: "models_cleared" }), {
    kind: "down",
    text: "Models deleted.",
    retry: "Download again",
  });
  assert.deepEqual(modelStatusLine({ state: "error", error: "engine_error" }).text, "The OCR engine failed to start.");
  assert.deepEqual(modelStatusLine(undefined), { kind: "warming", text: "Starting…", retry: null });
});

test("free remaining text", () => {
  assert.equal(freeLeftText(7), "7 left today");
  assert.equal(freeLeftText(0), "0 left today");
  assert.equal(freeLeftText(null), "");
  assert.equal(freeLeftText(undefined), "");
});

test("anki errors", () => {
  assert.equal(ankiErrorMessage("anki_unreachable"), "Anki isn't running — open Anki with AnkiConnect to add cards.");
  assert.match(ankiErrorMessage("anki_origin_blocked"), /accept the AnkiConnect permission prompt in Anki/);
  assert.match(ankiErrorMessage("anki_origin_blocked"), /webCorsOriginList/);
  assert.match(ankiErrorMessage("anki_error", "boom"), /boom/);
});

test("card picture file name keeps the v1 scheme", () => {
  assert.equal(pictureFilename("0123456789abcdef0123", 7), "anki_manga_0123456789ab_7.jpg");
});
