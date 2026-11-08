// Pure helpers of the side panel (copy and small formatting rules); panel.js does the DOM wiring.

const OWN_KEY = "own_key";
const GENERIC = "Explanation failed — click the bubble again to retry.";

// The free tier's budget resets on the 1st of the next month, UTC (the server's month is a UTC month).
function monthlyCapText(now) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const date = next.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  return `The free service has used its budget for this month; it comes back on ${date}. You can add your own API key in Settings.`;
}

const EXPLAIN_MESSAGES = {
  free_daily_limit: ["Today's free explanations are used up — they reset tomorrow. Add your own API key to keep going.", OWN_KEY],
  free_monthly_cap: [monthlyCapText, OWN_KEY],
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
  explanations_off: ["Explanations are off. Turn them on in Settings → Explanations.", null],
  refused: ["No explanation for this line: the model declined it. The text, readings and dictionary still work.", null],
};
const FREE_NOT_COUNTED = " It did not count toward your free limit.";

// -> {text, action}: action "own_key" asks the panel to offer "Use my own API key". free: the free tier answered
// (a refusal there says the free limit was not used). now: only the monthly-cap message depends on it.
export function explainErrorMessage(code, { free = false, now = new Date() } = {}) {
  const hit = Object.hasOwn(EXPLAIN_MESSAGES, code) && EXPLAIN_MESSAGES[code];
  if (!hit) return { text: `Something went wrong (${code}).`, action: null };
  const text = typeof hit[0] === "function" ? hit[0](now) : hit[0];
  return { text: code === "refused" && free ? text + FREE_NOT_COUNTED : text, action: hit[1] };
}

const MODEL_ERRORS = {
  model_download_failed: ["Model download failed — check your connection.", "Retry"],
  model_corrupt: ["A downloaded model file failed its check.", "Retry"],
  models_cleared: ["Models deleted.", "Download again"],
};

const STARTING = "Starting the OCR engine…";

// Non-breaking spaces inside each chunk: a narrow panel wraps the line after the comma, not inside "120 / 337 MB".
const unbroken = (s) => s.replace(/ /g, "\u00a0");

function timeLeft(sec) {
  if (sec == null) return "";
  return `, ${unbroken(sec < 60 ? "less than a minute left" : `about ${Math.round(sec / 60)} min left`)}`;
}

// modelStatus ({state, progress, receivedBytes, totalBytes, etaSec, firstRun, ep, error}; engine/startup.js)
// -> {kind: "ready"|"warming"|"down", text, retry: button label | null}. Shared by the panel and the welcome page.
export function modelStatusLine(s) {
  if (!s) return { kind: "warming", text: "Starting…", retry: null };
  if (s.state === "downloading") {
    // No size yet, or nothing to download (warm start): the engine is starting, not downloading.
    if (!(s.totalBytes > 0)) return { kind: "warming", text: STARTING, retry: null };
    const mb = (bytes) => Math.round(bytes / 1e6);
    return { kind: "warming", text: `Downloading models: ${unbroken(`${mb(s.receivedBytes || 0)} / ${mb(s.totalBytes)} MB`)}${timeLeft(s.etaSec)}`, retry: null };
  }
  if (s.state === "loading") return { kind: "warming", text: s.firstRun ? "Preparing models (first run only)…" : STARTING, retry: null };
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

// How a "+" button looks once its card exists: added just now reads as success (green), already in the deck stays grey.
export const cardDoneState = (outcome) => (outcome === "added" ? { label: "✓ added", cls: "added" } : { label: "✓ in deck", cls: "have" });

export const NO_DECK = "Pick an Anki deck in Settings first.";

// The deck cards go to is the user's choice, never a guess. resolveDeck says which saved deck is in force: the one
// for this site, else the last one picked, as long as Anki has it. Nothing is ever deleted from storage because Anki's
// list lacks a deck (Anki may be on another profile or still loading). -> {deck: the one to use | null, missing: the
// site or last deck Anki does not have, for the message | null}
export function resolveDeck(decks, origin, names) {
  const saved = [...new Set([origin && decks?.[origin], decks?._last].filter(Boolean))];
  const deck = saved.find((d) => names.includes(d)) ?? null;
  const missing = saved.find((d) => !names.includes(d) && (deck === null || saved.indexOf(d) < saved.indexOf(deck))) ?? null;
  return { deck, missing };
}

// What the settings offer for the deck resolveDeck found (null: none in force): nothing saved is touched until the user
// confirms "manga mining" (preselected when it exists), picks a deck, or creates "manga mining".
// -> {selected, offer: "use" | "create" | null}
export const DEFAULT_DECK = "manga mining";
export function deckChoice(names, deck) {
  if (deck && names.includes(deck)) return { selected: deck, offer: null };
  if (names.includes(DEFAULT_DECK)) return { selected: DEFAULT_DECK, offer: "use" };
  return { selected: null, offer: "create" };
}

// The deck a "+" sends to. checked: {origin, deck} from the last successful look at Anki's deck list (null before
// one): for this site it decides, so a deck Anki lacked is never used. Without one (Anki unreachable so far),
// the saved decks are read as they are.
export function deckForCard(decks, origin, checked) {
  if (checked && checked.origin === origin) return checked.deck;
  return (origin && decks?.[origin]) || decks?._last || null;
}

// Whether the deck in force differs from the last one announced to the entries on screen (null: none).
export const deckChanged = (announced, deck) => (announced ?? null) !== (deck ?? null);

// Overlapping async calls: each next() gets an isCurrent() that turns false once a newer call started.
export function latestCall() {
  let n = 0;
  return () => {
    const mine = ++n;
    return () => mine === n;
  };
}

// The line above the entries, next to every "+": where a card goes.
export const deckTargetText = (deck) => (deck ? `Cards go to → ${deck}` : NO_DECK);

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
// Deleting the key from "own" turns explanations off: it never moves the text to the free server on its own.
export function llmModeAfter(event, llm) {
  switch (event) {
    case "select_free":
      return "free";
    case "select_off":
      return "off";
    case "delete_key":
      return llm.mode === "own" ? "off" : llm.mode;
    case "select_own":
      return llm.apiKey ? "own" : llm.mode;
    case "save_own":
      return "own";
    default: // open_own_key, save_own_refused
      return llm.mode;
  }
}

// What goes where, for the hint under Explanations. mode: "free" | "own" | "off" (anything else reads as "free").
export function explanationsHint(mode) {
  if (mode === "off") return "Nothing is sent. Reading, the dictionary and cards work without explanations.";
  if (mode === "own") return "The text of the bubble you click goes from your browser to your provider, with your API key. Page images are not uploaded.";
  return "The text of the bubble you click, a random install ID and the prompt version go to the project's server, which asks DeepSeek. The server also sees your network address (for the daily limit). Page images are not uploaded.";
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
