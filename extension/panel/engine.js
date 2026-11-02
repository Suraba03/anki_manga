// Calls into the OCR/dictionary engine through the service worker (the panel never talks to the offscreen document directly).
export async function engine(msg) {
  try {
    return (await chrome.runtime.sendMessage({ type: "am:engine", msg })) || { ok: false, error: "engine_error" };
  } catch {
    return { ok: false, error: "engine_error" };
  }
}
