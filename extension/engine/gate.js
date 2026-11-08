// Small decisions of the page pipeline, kept apart from the offscreen document so Node tests can reach them.
import { busyReply } from "./busy.js";

// Service worker: which OCR scope to ask the engine for. "auto" means the speed is not measured yet, so the
// engine resolves it (resolveScope) once the measured mode is known.
export function ocrScopeFor(perfMode, mode) {
  if (perfMode === "prefetch") return "all";
  if (perfMode === "on-demand") return "none";
  if (mode === "on-demand") return "none";
  return mode ? "all" : "auto";
}

// Engine: "auto" becomes "all" or "none" by the measured mode; explicit scopes pass through.
export function resolveScope(ocr, mode) {
  return ocr === "auto" ? (mode === "on-demand" ? "none" : "all") : ocr;
}

// A page request is turned away (the content script retries) until the engine is prepared: before "ready" with the
// download/loading reply, afterwards while the warm-up and speed check run, with a models_loading reply so the page
// badge shows the start-up text instead of "finding bubbles…" and no image is decoded meanwhile.
// prepared: the benchmark ({mode, ...}) once the engine's background preparation is done, else null.
export function pageGate(status, prepared) {
  return busyReply(status) || (prepared ? null : busyReply({ ...status, state: "loading" }));
}

// Disposes a replaced engine (dispose is idempotent); a failing dispose is only reported. Resolves null.
export async function retireEngine(engine, onError = (e) => console.error("engine dispose failed", e)) {
  try {
    await engine?.dispose();
  } catch (e) {
    onError(e);
  }
  return null;
}

// Waits for the engine's preparation (a promise of the benchmark, or of null/an error) for at most ms. Resolves the
// benchmark, or null on a timeout or a failure; never throws.
export async function waitPrepared(preparing, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, null);
  });
  try {
    return (await Promise.race([Promise.resolve(preparing).catch(() => null), timeout])) ?? null;
  } finally {
    clearTimeout(timer);
  }
}
