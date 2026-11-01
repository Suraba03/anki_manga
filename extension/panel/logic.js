// Pure helpers of the side panel (copy and small formatting rules); panel.js does the DOM wiring.

const OWN_KEY = "own_key";
const GENERIC = "Explanation failed — click the bubble again to retry.";

const EXPLAIN_MESSAGES = {
  free_daily_limit: ["Today's free explanations are used up — they reset tomorrow. Add your own API key to keep going.", OWN_KEY],
  free_monthly_cap: ["Free explanations are used up for this month. Add your own API key to keep going.", OWN_KEY],
  free_unavailable: ["The free explanation service is unavailable right now. Try again later or add your own API key.", OWN_KEY],
  no_text: ["No text was recognized in this bubble.", null],
  no_api_key: ["Add your DeepSeek API key in Settings to get explanations.", null],
  auth: ["DeepSeek rejected the API key — check it in Settings.", null],
  bad_response: [GENERIC, null],
  network: [GENERIC, null],
  no_balance: ["Your DeepSeek account has no balance — top it up on platform.deepseek.com.", null],
  rate_limited: ["DeepSeek is rate-limiting requests — wait a moment and click the bubble again.", null],
  page_expired: ["This page is no longer cached — scroll back to it and try again.", null],
  models_downloading: ["The OCR models are still downloading — try again in a moment.", null],
  models_loading: ["The OCR models are still loading — try again in a moment.", null],
  text_pending: ["This bubble is still being read — click it again in a moment.", null],
  unknown_bubble: ["This bubble is no longer available — click it again.", null],
};

// -> {text, action}: action "own_key" asks the panel to offer "Use my own API key".
export function explainErrorMessage(code) {
  const hit = Object.hasOwn(EXPLAIN_MESSAGES, code) && EXPLAIN_MESSAGES[code];
  return hit ? { text: hit[0], action: hit[1] } : { text: `Something went wrong (${code}).`, action: null };
}

const MODEL_ERRORS = {
  model_download_failed: ["Model download failed — check your connection.", "Retry"],
  model_corrupt: ["A downloaded model file failed its check.", "Retry"],
  models_cleared: ["Models deleted.", "Download again"],
};

// modelStatus ({state, progress, ep, error}) -> {kind: "ready"|"warming"|"down", text, retry: button label | null}
export function modelStatusLine(s) {
  if (!s) return { kind: "warming", text: "Starting…", retry: null };
  if (s.state === "downloading") return { kind: "warming", text: `Downloading models… ${Math.floor((s.progress || 0) * 100)}%`, retry: null };
  if (s.state === "loading") return { kind: "warming", text: "Loading models…", retry: null };
  if (s.state === "ready") return { kind: "ready", text: `Ready (${s.ep === "webgpu" ? "WebGPU" : "CPU"})`, retry: null };
  const [text, retry] = (Object.hasOwn(MODEL_ERRORS, s.error) && MODEL_ERRORS[s.error]) || ["The OCR engine failed to start.", "Retry"];
  return { kind: "down", text, retry };
}

export function freeLeftText(remaining) {
  return Number.isFinite(remaining) ? `${remaining} left today` : "";
}

const ORIGIN_HINT =
  "Anki refused this extension — accept the AnkiConnect permission prompt in Anki, or add this extension's origin to webCorsOriginList in AnkiConnect's config.";

// kind: AnkiError.kind; detail: its message (shown for anki_error).
export function ankiErrorMessage(kind, detail = "") {
  if (kind === "anki_unreachable") return "Anki isn't running — open Anki with AnkiConnect to add cards.";
  if (kind === "anki_origin_blocked") return ORIGIN_HINT;
  return `Anki could not add the card${detail ? `: ${detail}` : ""}.`;
}

export const DICT_UNAVAILABLE = "The dictionary could not be loaded — check your connection and click the word again.";

// Same scheme as v1, so a picture added twice is stored once by Anki.
export const pictureFilename = (pageId, bubbleId) => `anki_manga_${pageId.slice(0, 12)}_${bubbleId}.jpg`;

export const NO_DECK = "Pick an Anki deck in Settings first.";
