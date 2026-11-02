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

// --- own key -------------------------------------------------------------------------------
const trimUrl = (u) => String(u || "").trim().replace(/\/+$/, "");
// Provider plus base URL identify where a key belongs (the base URL only counts for "custom").
const keyHome = ({ provider, baseUrl }) => `${provider}|${provider === "custom" ? trimUrl(baseUrl) : ""}`;

// stored: the saved llm settings; form: {provider, baseUrl, typedKey}. A blank key field reuses the stored key
// only for the same provider and base URL, so a key is never sent to a host it was not entered for.
export function ownKeyCheck(stored, { provider, baseUrl, typedKey }) {
  const typed = String(typedKey || "").trim();
  if (typed) return { ok: true, key: typed };
  if (stored.apiKey && keyHome(stored) === keyHome({ provider, baseUrl })) return { ok: true, key: stored.apiKey };
  return { ok: false, error: "Enter the API key for this provider." };
}

// The explanation mode after a settings event. It becomes "own" only once a key is saved (or already is).
export function llmModeAfter(event, llm) {
  switch (event) {
    case "select_free":
      return "free";
    case "select_own":
      return llm.apiKey ? "own" : llm.mode;
    case "save_own":
      return "own";
    default: // open_own_key, save_own_refused
      return llm.mode;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// -> {ok:true, origin, baseUrl} | {ok:false, error}. https, or http for this computer only.
export function validateBaseUrl(input) {
  const bad = { ok: false, error: "Enter the provider's base URL, e.g. https://api.example.com/v1." };
  let u;
  try {
    u = new URL(String(input || "").trim());
  } catch {
    return bad;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return bad;
  if (u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname)) {
    return { ok: false, error: "Use an https:// base URL (http:// is only allowed for localhost)." };
  }
  return { ok: true, origin: u.origin, baseUrl: String(input).trim() };
}

// --- anki permission, free count -------------------------------------------------------------
// Anki shows its dialog on every requestPermission from an origin it has not allowed: after a "No" only a user
// action (Connect to Anki, "+") may ask again, never a tab event or a bubble click.
export const shouldAskPermission = ({ denied, userAction }) => !denied || !!userAction;

// A limit answer from the free tier means nothing is left (null: not a limit answer).
export const freeRemainingAfterError = (code) => (code === "free_daily_limit" || code === "free_monthly_cap" ? 0 : null);

// A bubble clicked before the engine read it answers text_pending: ask again until it has text (or another answer),
// up to timeoutMs. The click already moved the bubble to the front of the engine's queue.
export async function waitForBubbleText(fetchBubble, { intervalMs = 700, timeoutMs = 60000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const end = now() + timeoutMs;
  for (;;) {
    const b = await fetchBubble();
    if (b?.ok || b?.error !== "text_pending" || now() >= end) return b;
    await sleep(intervalMs);
  }
}
