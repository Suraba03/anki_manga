// Service worker: per-site activation, and the relay between content scripts and the offscreen OCR engine.
import { getSettings } from "./lib/settings.js";
import { ocrScopeFor } from "./engine/gate.js";

// Classic content scripts, loaded in this order into one isolated world.
export const CONTENT_FILES = ["content/page-finder.js", "content/layout.js", "content/overlay.js", "content/status.js", "content/main.js"];

chrome.runtime.onInstalled.addListener(async ({ reason } = {}) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  restoreSites();
  // A fresh install: the welcome tab explains the one-time model download, which starts right away (the
  // offscreen document boots the engine when it loads). The tab cannot start it itself: am:engine refuses tabs.
  if (reason === "install") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") }).catch(() => {});
    await ensureOffscreen().catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  restoreSites();
});

// Content scripts run next to untrusted pages: they must not read storage.local (settings hold the user's API key).
// The mode they need is handed out by am:perf-mode below. Not persisted by Chrome, so set on every worker start.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

function scriptFor(origin) {
  return { id: `am:${origin}`, matches: [`${origin}/*`], js: CONTENT_FILES, persistAcrossSessions: true, runAt: "document_idle" };
}

// Updating/reloading the extension clears dynamically registered content scripts, and the
// scripts already running in open tabs lose their connection. Re-register every enabled site
// and inject a fresh copy into its open tabs (main.js retires the stale copy).
export async function restoreSites() {
  for (const origin of await enabledOrigins()) {
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) continue;
    const id = `am:${origin}`;
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
    await chrome.scripting.registerContentScripts([scriptFor(origin)]);
    for (const tab of await chrome.tabs.query({ url: `${origin}/*` })) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES }).catch(() => {});
    }
  }
}

async function enabledOrigins() {
  return (await chrome.storage.local.get("enabledOrigins")).enabledOrigins || [];
}

async function enableSite(origin, tabId) {
  const id = `am:${origin}`;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  await chrome.scripting.registerContentScripts([scriptFor(origin)]);
  const origins = new Set(await enabledOrigins());
  origins.add(origin);
  await chrome.storage.local.set({ enabledOrigins: [...origins] });
  if (tabId != null) {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES }).catch(() => {});
  }
}

async function disableSite(origin, tabId) {
  const id = `am:${origin}`;
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
  const origins = (await enabledOrigins()).filter((o) => o !== origin);
  await chrome.storage.local.set({ enabledOrigins: origins });
  if (tabId != null) chrome.tabs.reload(tabId);
}

// --- offscreen engine host ----------------------------------------------------------
// OCR runs in an offscreen document (the service worker cannot host WebGPU/WASM sessions).
let offscreenReady = null;

export function ensureOffscreen() {
  offscreenReady ||= (async () => {
    const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (open.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["WORKERS"],
      justification: "Runs the manga text recognition models",
    });
  })().finally(() => {
    offscreenReady = null;
  });
  return offscreenReady;
}

export async function engineCall(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

// --- page pipeline ------------------------------------------------------------------
// The offscreen document fetches/decodes the image, detects bubbles and OCRs them; this side checks the
// image-host permission and relays finished texts to the tabs that show the page.
// pageId -> Set<tabId>. Mirrored in chrome.storage.session so a restarted worker still knows who watches a page
// (a text finishing after a restart would otherwise be dropped); loaded lazily on first use.
const watchers = new Map();
let watchersLoaded = null;
let watchersSaved = Promise.resolve();

function loadWatchers() {
  watchersLoaded ||= chrome.storage.session.get("watchers").then(({ watchers: saved = {} }) => {
    for (const [pageId, tabs] of Object.entries(saved)) {
      const set = watchers.get(pageId) || new Set();
      for (const t of tabs) set.add(t);
      watchers.set(pageId, set);
    }
  });
  return watchersLoaded;
}

function saveWatchers() {
  const snapshot = {};
  for (const [pageId, tabs] of watchers) if (tabs.size) snapshot[pageId] = [...tabs];
  watchersSaved = watchersSaved.then(() => chrome.storage.session.set({ watchers: snapshot })).catch(() => {});
  return watchersSaved;
}

async function forgetWatcher(tabId) {
  await loadWatchers();
  let changed = false;
  for (const tabs of watchers.values()) changed = tabs.delete(tabId) || changed;
  if (changed) await saveWatchers();
}

async function noteMissingHost(tabId, host) {
  const { missingHosts = {} } = await chrome.storage.session.get("missingHosts");
  const hosts = new Set(missingHosts[tabId] || []);
  hosts.add(host);
  missingHosts[tabId] = [...hosts];
  await chrome.storage.session.set({ missingHosts });
}

// "all": OCR every bubble as soon as the page is detected; "none": only bubbles the user hovers; "auto": the speed
// is not measured yet, so the engine decides after the measurement (engine/gate.js).
async function ocrScope() {
  const { perfMode } = await getSettings();
  const { modelStatus } = await chrome.storage.session.get("modelStatus");
  return ocrScopeFor(perfMode, modelStatus && modelStatus.mode);
}

// Under Chrome's 64 MB limit for one message, which also carries the envelope.
const MAX_DATA_URL = 48 * 1024 * 1024;

async function processImage(msg) {
  // The content script already loaded the image the way the page does (its Referer, cookies). Those bytes come from a
  // page of a site the user enabled, so no host permission is needed. Same bytes as a fetch, so the same page id.
  if (msg.dataUrl !== undefined) {
    if (typeof msg.dataUrl !== "string" || !msg.dataUrl.startsWith("data:") || msg.dataUrl.length > MAX_DATA_URL) {
      return { ok: false, error: "bad_image" };
    }
    return engineCall({ type: "eng:page", source: { dataUrl: msg.dataUrl }, key: msg.imageUrl, priority: msg.priority, ocr: await ocrScope() });
  }
  const url = new URL(msg.imageUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "fetch_failed" }; // e.g. blob:
  const pattern = `${url.protocol}//${url.host}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: "no_image_permission", host: url.host };
  }
  return engineCall({ type: "eng:page", source: { url: msg.imageUrl }, key: msg.imageUrl, priority: msg.priority, ocr: await ocrScope() });
}

export async function relayText({ pageId, bubbleId, text }) {
  await loadWatchers();
  for (const tabId of watchers.get(pageId) || []) {
    chrome.tabs.sendMessage(tabId, { type: "am:bubble-text", pageId, bubbleId, text }).catch(() => {});
  }
}

async function watchPage(tabId, pageId) {
  await loadWatchers();
  if (!watchers.has(pageId)) watchers.set(pageId, new Set());
  const tabs = watchers.get(pageId);
  if (!tabs.has(tabId)) {
    tabs.add(tabId);
    await saveWatchers();
  }
  // Texts finished before this tab registered (or on an earlier visit) are sent now; later ones are relayed as they finish.
  try {
    const reply = await engineCall({ type: "eng:texts", pageId });
    for (const { bubbleId, text } of (reply && reply.texts) || []) {
      chrome.tabs.sendMessage(tabId, { type: "am:bubble-text", pageId, bubbleId, text }).catch(() => {});
    }
  } catch {
    // the engine is not reachable right now: the watcher is registered and new texts still arrive
  }
}

// The performance mode content scripts act on: "prefetch" or "on-demand". Nothing else of the settings leaves the worker.
async function perfMode() {
  const { perfMode: pref } = await getSettings();
  if (pref === "prefetch" || pref === "on-demand") return pref;
  const { benchmark } = await chrome.storage.local.get("benchmark");
  return benchmark && benchmark.mode === "on-demand" ? "on-demand" : "prefetch";
}

// Sends msg to every open tab of an enabled site.
async function toEnabledTabs(msg) {
  for (const origin of await enabledOrigins()) {
    for (const tab of await chrome.tabs.query({ url: `${origin}/*` })) {
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    }
  }
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !(changes.settings || changes.benchmark)) return;
  await toEnabledTabs({ type: "am:perf-mode", mode: await perfMode() });
});

// The PNG header holds the image width at bytes 16-19: no need to decode the screenshot here.
function pngWidth(dataUrl) {
  const start = dataUrl.indexOf(",") + 1;
  const head = atob(dataUrl.slice(start, start + 32));
  return ((head.charCodeAt(16) << 24) | (head.charCodeAt(17) << 16) | (head.charCodeAt(18) << 8) | head.charCodeAt(19)) >>> 0;
}

// A host[:port] as URL() writes it, with proper labels (no "..", "-", wildcards, paths or credentials).
function validHost(host) {
  if (typeof host !== "string" || host.includes("*")) return false;
  try {
    const u = new URL(`http://${host}`);
    if (u.host !== host) return false;
    return u.hostname.startsWith("[") || u.hostname.split(".").every((l) => /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/.test(l));
  } catch {
    return false;
  }
}

async function blockCapture(tab) {
  const { captureBlocked = {} } = await chrome.storage.session.get("captureBlocked");
  captureBlocked[tab.id] = true;
  await chrome.storage.session.set({ captureBlocked });
}

// Fallback for canvas pages / images we can't fetch: the offscreen document crops a screenshot of the element.
async function captureElement(msg, sender) {
  const tab = sender.tab;
  if (!tab) return { ok: false, error: "no_tab" };
  if (msg.probe) {
    // Asked before the first screenshot, so a missing permission shows up at once instead of when the page is in view.
    if (await chrome.permissions.contains({ origins: ["<all_urls>"] })) return { ok: true };
    await blockCapture(tab);
    return { ok: false, error: "capture_failed" };
  }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    await blockCapture(tab);
    return { ok: false, error: "capture_failed", detail: String(e.message || e) };
  }
  // The page may move again while the engine works; the tab only needs to know when the pixels were taken.
  if (msg.id != null) chrome.tabs.sendMessage(tab.id, { type: "am:capture-taken", id: msg.id }, { frameId: sender.frameId }).catch(() => {});
  const { x, y, width, height } = msg.rect;
  const scale = pngWidth(dataUrl) / msg.viewportWidth; // device pixels per CSS pixel in the capture
  return engineCall({ type: "eng:page", source: { dataUrl, crop: { x, y, width, height, scale } }, ocr: await ocrScope() });
}

// A hovered bubble is OCR'd next. If its text is already known the engine says so in the reply, and the
// hovering tab gets it directly (its watcher may have been lost in a worker restart).
async function prioritize(msg, sender) {
  const reply = await engineCall({ type: "eng:prioritize", pageId: msg.pageId, bubbleId: msg.bubbleId });
  if (reply && reply.text != null && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, { type: "am:bubble-text", pageId: msg.pageId, bubbleId: msg.bubbleId, text: reply.text }).catch(() => {});
  }
  return { ok: !!(reply && reply.ok) };
}

async function select(msg, sender) {
  // Must run before any await: the click's user gesture only lasts through this sync part.
  if (sender.tab) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  const selection = { ...msg, tabId: sender.tab && sender.tab.id, at: Date.now() };
  delete selection.type;
  await chrome.storage.session.set({ lastSelection: selection });
  chrome.runtime.sendMessage({ type: "am:selected", selection }).catch(() => {});
  return { ok: true };
}

function fromEngine(fn) {
  return async (msg, sender) => {
    if (sender.tab) return { ok: false };
    await fn(msg);
    return { ok: true };
  };
}

// Message router. Handlers return a promise; the response is sent when it settles.
const handlers = {
  "am:enable-site": (msg) => enableSite(msg.origin, msg.tabId).then(() => ({ ok: true })),
  "am:disable-site": (msg) => disableSite(msg.origin, msg.tabId).then(() => ({ ok: true })),
  "am:page": processImage,
  // The content script knows the image is a manga page that its host permission is missing for (the panel lists the hosts).
  "am:missing-host": async (msg, sender) => {
    if (sender.tab && validHost(msg.host)) await noteMissingHost(sender.tab.id, msg.host);
    return { ok: true };
  },
  "am:capture": captureElement,
  "am:watch": async (msg, sender) => {
    if (sender.tab) await watchPage(sender.tab.id, msg.pageId);
    return { ok: true };
  },
  "am:prioritize": prioritize,
  // How far each page the tab is working on is from the screen: the engine reads it at every pick of its queues.
  "am:priorities": async (msg, sender) => (sender.tab ? engineCall({ type: "eng:priorities", items: msg.items }) : { ok: false }),
  "am:perf-mode": async (msg, sender) => (sender.tab ? { ok: true, mode: await perfMode() } : { ok: false }),
  "am:engine": async (msg, sender) => (sender.tab ? { ok: false } : engineCall(msg.msg)), // panel only
  // Messages from the offscreen document (a content script must not be able to send these). The
  // offscreen document has no chrome.storage, so the worker reads and writes it on the engine's behalf.
  "eng:text": fromEngine(async (msg) => relayText(msg)),
  "eng:model-status": fromEngine(async (msg) => {
    await chrome.storage.session.set({ modelStatus: msg.status });
    // Pages that failed while the engine was down (or are waiting) try again.
    if (msg.status && msg.status.state === "ready") await toEnabledTabs({ type: "am:retry" });
  }),
  // The saved speed check (engine/startup.js reuses it while the backend and model files are unchanged).
  "eng:get-benchmark": async (msg, sender) => {
    if (sender.tab) return { ok: false };
    const { benchmark = null } = await chrome.storage.local.get("benchmark");
    return { ok: true, benchmark };
  },
  "eng:benchmark": fromEngine((msg) =>
    msg.benchmark ? chrome.storage.local.set({ benchmark: msg.benchmark }) : chrome.storage.local.remove("benchmark"),
  ),
  // Development only: a local mirror of the model files. Unpacked extensions only; SHA-256 still applies.
  "eng:dev-config": async (msg, sender) => {
    if (sender.tab) return { ok: false };
    const { devModelBase = null } = await chrome.storage.local.get("devModelBase");
    return { devModelBase: chrome.runtime.getManifest().update_url ? null : devModelBase };
  },
  "am:select": select,
  "am:status": async (msg, sender) => {
    if (!sender.tab) return { ok: false };
    const { pageStatus = {} } = await chrome.storage.session.get("pageStatus");
    pageStatus[sender.tab.id] = msg.summary;
    await chrome.storage.session.set({ pageStatus });
    return { ok: true };
  },
};

async function forgetStatus(tabId) {
  const { pageStatus = {} } = await chrome.storage.session.get("pageStatus");
  if (!(tabId in pageStatus)) return;
  delete pageStatus[tabId];
  await chrome.storage.session.set({ pageStatus });
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    forgetStatus(tabId);
    forgetWatcher(tabId); // a navigation destroys the page's overlay; its content script registers again
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  forgetStatus(tabId);
  await forgetWatcher(tabId);
  const { missingHosts = {} } = await chrome.storage.session.get("missingHosts");
  if (missingHosts[tabId]) {
    delete missingHosts[tabId];
    await chrome.storage.session.set({ missingHosts });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.error || String(e.message || e) }));
  return true;
});

// Test hook: the e2e harness evaluates in the service-worker global scope, where module
// exports are not reachable (dynamic import() is disallowed in service workers).
Object.assign(globalThis, { ensureOffscreen, engineCall, handlers });

export { handlers };
