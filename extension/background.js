// Service worker: per-site activation, and the relay between content scripts and the offscreen OCR engine.
import { getSettings } from "./lib/settings.js";

// Classic content scripts, loaded in this order into one isolated world.
export const CONTENT_FILES = ["content/page-finder.js", "content/layout.js", "content/overlay.js", "content/status.js", "content/main.js"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  restoreSites();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  restoreSites();
});

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
const watchers = new Map(); // pageId -> Set<tabId>; in-memory only, content scripts re-register on hover

async function noteMissingHost(tabId, host) {
  const { missingHosts = {} } = await chrome.storage.session.get("missingHosts");
  const hosts = new Set(missingHosts[tabId] || []);
  hosts.add(host);
  missingHosts[tabId] = [...hosts];
  await chrome.storage.session.set({ missingHosts });
}

// "all": OCR every bubble as soon as the page is detected; "none": only bubbles the user hovers.
async function ocrScope() {
  const { perfMode } = await getSettings();
  if (perfMode === "prefetch") return "all";
  if (perfMode === "on-demand") return "none";
  const { modelStatus } = await chrome.storage.session.get("modelStatus");
  return modelStatus && modelStatus.mode === "on-demand" ? "none" : "all";
}

async function processImage(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const url = new URL(msg.imageUrl);
  const pattern = `${url.protocol}//${url.host}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    await noteMissingHost(tabId, url.host);
    return { ok: false, error: "no_image_permission", host: url.host };
  }
  return engineCall({ type: "eng:page", source: { url: msg.imageUrl }, ocr: await ocrScope() });
}

export function relayText({ pageId, bubbleId, text }) {
  for (const tabId of watchers.get(pageId) || []) {
    chrome.tabs.sendMessage(tabId, { type: "am:bubble-text", pageId, bubbleId, text }).catch(() => {});
  }
}

function watchPage(tabId, pageId) {
  if (!watchers.has(pageId)) watchers.set(pageId, new Set());
  watchers.get(pageId).add(tabId);
}

// The PNG header holds the image width at bytes 16-19: no need to decode the screenshot here.
function pngWidth(dataUrl) {
  const start = dataUrl.indexOf(",") + 1;
  const head = atob(dataUrl.slice(start, start + 32));
  return ((head.charCodeAt(16) << 24) | (head.charCodeAt(17) << 16) | (head.charCodeAt(18) << 8) | head.charCodeAt(19)) >>> 0;
}

// Fallback for canvas pages / images we can't fetch: the offscreen document crops a screenshot of the element.
async function captureElement(msg, sender) {
  const tab = sender.tab;
  if (!tab) return { ok: false, error: "no_tab" };
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    const { captureBlocked = {} } = await chrome.storage.session.get("captureBlocked");
    captureBlocked[tab.id] = true;
    await chrome.storage.session.set({ captureBlocked });
    return { ok: false, error: "capture_failed", detail: String(e.message || e) };
  }
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
  "am:capture": captureElement,
  "am:watch": (msg, sender) => {
    if (sender.tab) watchPage(sender.tab.id, msg.pageId);
    return Promise.resolve({ ok: true });
  },
  "am:prioritize": prioritize,
  "am:engine": (msg) => engineCall(msg.msg),
  // Messages from the offscreen document (a content script must not be able to send these). The
  // offscreen document has no chrome.storage, so the worker reads and writes it on the engine's behalf.
  "eng:text": fromEngine(async (msg) => relayText(msg)),
  "eng:model-status": fromEngine((msg) => chrome.storage.session.set({ modelStatus: msg.status })),
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
  if (info.status === "loading") forgetStatus(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  forgetStatus(tabId);
  for (const tabs of watchers.values()) tabs.delete(tabId);
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
