// Service worker: per-site activation, and (later tasks) image fetching + helper relay.
import { call, ensurePaired } from "./lib/helper-client.js";

// Classic content scripts, loaded in this order into one isolated world.
export const CONTENT_FILES = ["content/page-finder.js", "content/layout.js", "content/overlay.js", "content/main.js"];

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

// --- page pipeline ------------------------------------------------------------------
const MIN_SIDE = 400;
const MIN_LONG_SIDE = 600;
const relaying = new Set(); // `${tabId}:${pageId}` streams in flight

async function noteMissingHost(tabId, host) {
  const { missingHosts = {} } = await chrome.storage.session.get("missingHosts");
  const hosts = new Set(missingHosts[tabId] || []);
  hosts.add(host);
  missingHosts[tabId] = [...hosts];
  await chrome.storage.session.set({ missingHosts });
}

async function postPage(bytes, contentType, imageUrl) {
  const resp = await call(`/pages?url=${encodeURIComponent(imageUrl || "")}`, {
    method: "POST",
    body: bytes,
    headers: { "Content-Type": contentType || "application/octet-stream" },
  });
  return resp.json();
}

async function processImage(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const url = new URL(msg.imageUrl);
  const pattern = `${url.protocol}//${url.host}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    await noteMissingHost(tabId, url.host);
    return { ok: false, error: "no_image_permission", host: url.host };
  }
  let resp;
  try {
    resp = await fetch(msg.imageUrl, { credentials: "include" });
  } catch {
    return { ok: false, error: "fetch_failed" };
  }
  if (!resp.ok) return { ok: false, error: "fetch_failed" };
  const blob = await resp.blob();
  try {
    const bmp = await createImageBitmap(blob);
    const small = Math.min(bmp.width, bmp.height) < MIN_SIDE || Math.max(bmp.width, bmp.height) < MIN_LONG_SIDE;
    bmp.close();
    if (small) return { ok: false, error: "not_manga" };
  } catch {
    return { ok: false, error: "fetch_failed" };
  }
  return sendPage(await blob.arrayBuffer(), blob.type, msg.imageUrl, tabId);
}

async function sendPage(bytes, contentType, imageUrl, tabId) {
  let page;
  try {
    page = await postPage(bytes, contentType, imageUrl);
  } catch (e) {
    return { ok: false, error: e.error || "helper_unreachable" };
  }
  if (page.bubbles.some((b) => b.text == null)) relayTexts(tabId, page.page_id);
  return { ok: true, page };
}

// Stream OCR results from the helper's SSE endpoint to the tab.
async function relayTexts(tabId, pageId) {
  const key = `${tabId}:${pageId}`;
  if (relaying.has(key)) return;
  relaying.add(key);
  try {
    const resp = await call(`/pages/${pageId}/events`);
    const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (frame.startsWith("event: done")) return;
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const { bubble_id, text } = JSON.parse(data.slice(6));
        chrome.tabs.sendMessage(tabId, { type: "am:bubble-text", pageId, bubbleId: bubble_id, text }).catch(() => {});
      }
    }
  } catch {
    /* helper went away; the content script retries pages on its own */
  } finally {
    relaying.delete(key);
  }
}

async function select(msg, sender) {
  const selection = { ...msg, tabId: sender.tab && sender.tab.id, at: Date.now() };
  delete selection.type;
  await chrome.storage.session.set({ lastSelection: selection });
  chrome.runtime.sendMessage({ type: "am:selected", selection }).catch(() => {});
  if (sender.tab) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  return { ok: true };
}

// Message router. Handlers return a promise; the response is sent when it settles.
const handlers = {
  "am:enable-site": (msg) => enableSite(msg.origin, msg.tabId).then(() => ({ ok: true })),
  "am:disable-site": (msg) => disableSite(msg.origin, msg.tabId).then(() => ({ ok: true })),
  "am:page": processImage,
  "am:prioritize": (msg) =>
    call(`/pages/${msg.pageId}/bubbles/${msg.bubbleId}/prioritize`, { method: "POST" })
      .then(() => ({ ok: true }))
      .catch(() => ({ ok: false })),
  "am:select": select,
};

chrome.tabs.onRemoved.addListener(async (tabId) => {
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

export { handlers };
