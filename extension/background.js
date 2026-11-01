// Service worker: per-site activation, and (later tasks) image fetching + helper relay.
import { ensurePaired } from "./lib/helper-client.js";

// Classic content scripts, loaded in this order into one isolated world.
export const CONTENT_FILES = ["content/page-finder.js", "content/main.js"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function enabledOrigins() {
  return (await chrome.storage.local.get("enabledOrigins")).enabledOrigins || [];
}

async function enableSite(origin, tabId) {
  const id = `am:${origin}`;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  await chrome.scripting.registerContentScripts([
    { id, matches: [`${origin}/*`], js: CONTENT_FILES, persistAcrossSessions: true, runAt: "document_idle" },
  ]);
  const origins = new Set(await enabledOrigins());
  origins.add(origin);
  await chrome.storage.local.set({ enabledOrigins: [...origins] });
  if (tabId != null) {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES }).catch(() => {});
  }
  await ensurePaired();
}

async function disableSite(origin, tabId) {
  const id = `am:${origin}`;
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
  const origins = (await enabledOrigins()).filter((o) => o !== origin);
  await chrome.storage.local.set({ enabledOrigins: origins });
  if (tabId != null) chrome.tabs.reload(tabId);
}

// Message router. Handlers return a promise; the response is sent when it settles.
const handlers = {
  "am:enable-site": (msg) => enableSite(msg.origin, msg.tabId).then(() => ({ ok: true })),
  "am:disable-site": (msg) => disableSite(msg.origin, msg.tabId).then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.error || String(e.message || e) }));
  return true;
});

export { handlers };
