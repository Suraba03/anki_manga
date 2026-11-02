// Side panel: model status, the active site, and the entries of clicked bubbles (see entries.js, settings.js).
import { modelStatusLine } from "./logic.js";
import { engine } from "./engine.js";
import { state } from "./state.js";
import { initSettings, loadDecks } from "./settings.js";
import { explainSelection } from "./entries.js";

const $ = (id) => document.getElementById(id);

// --- model status -----------------------------------------------------------------------
function showModelStatus(s) {
  const line = modelStatusLine(s);
  $("status").dataset.state = line.kind;
  $("status").textContent = line.text;
  $("status-retry").hidden = !line.retry;
  $("status-retry").textContent = line.retry || "";
}

$("status-retry").addEventListener("click", async () => {
  showModelStatus({ state: "downloading", progress: 0 });
  await engine({ type: "eng:retry" });
});

async function watchModelStatus() {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.modelStatus) showModelStatus(changes.modelStatus.newValue);
  });
  const { modelStatus } = await chrome.storage.session.get("modelStatus");
  if (modelStatus) return showModelStatus(modelStatus);
  // Nothing mirrored yet: asking wakes the engine, which then reports by itself.
  const s = await engine({ type: "eng:status" });
  showModelStatus(s.ok ? s : undefined);
}

// --- site toggle ----------------------------------------------------------------
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshSite() {
  const tab = await currentTab();
  let origin = null;
  try {
    const url = new URL(tab.url);
    if (url.protocol === "http:" || url.protocol === "https:") origin = url.origin;
  } catch {
    /* chrome:// etc. */
  }
  state.origin = origin;
  state.tabId = tab ? tab.id : null;
  $("site-name").textContent = origin ? new URL(origin).host : "This page can't be used";
  const enabled = ((await chrome.storage.local.get("enabledOrigins")).enabledOrigins || []).includes(origin);
  $("site-toggle").disabled = !origin;
  $("site-toggle").textContent = enabled ? "Disable on this site" : "Enable on this site";
  $("site-toggle").dataset.enabled = enabled ? "1" : "";
  await renderHostRequests();
  await renderPageStatus(enabled);
  await loadDecks();
}

async function renderPageStatus(enabled = !!$("site-toggle").dataset.enabled) {
  const el = $("page-status");
  const { pageStatus = {} } = await chrome.storage.session.get("pageStatus");
  const summary = state.tabId != null && pageStatus[state.tabId];
  el.hidden = !enabled;
  if (!enabled) return;
  el.textContent = summary ? globalThis.AnkiManga.Status.summaryText(summary) : "Waiting for the page… (reload the tab if this stays)";
  if (!summary && state.tabId != null) chrome.tabs.sendMessage(state.tabId, { type: "am:status-request" }).catch(() => {});
}


// Images often come from a CDN host; asking for it needs a click (user gesture).
async function renderHostRequests() {
  const { missingHosts = {} } = await chrome.storage.session.get("missingHosts");
  const hosts = state.tabId != null ? missingHosts[state.tabId] || [] : [];
  const buttons = [];
  for (const host of hosts) {
    if (await chrome.permissions.contains({ origins: [`*://${host}/*`] })) continue;
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = `Allow images from ${host}`;
    btn.addEventListener("click", async () => {
      if (!(await chrome.permissions.request({ origins: [`*://${host}/*`] }))) return;
      const { missingHosts: mh = {} } = await chrome.storage.session.get("missingHosts");
      mh[state.tabId] = (mh[state.tabId] || []).filter((h) => h !== host);
      await chrome.storage.session.set({ missingHosts: mh });
      chrome.tabs.sendMessage(state.tabId, { type: "am:retry" }).catch(() => {});
      renderHostRequests();
    });
    buttons.push(btn);
  }
  const { captureBlocked = {} } = await chrome.storage.session.get("captureBlocked");
  if (state.tabId != null && captureBlocked[state.tabId] && !(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "Allow screenshots (needed for canvas readers)";
    btn.addEventListener("click", async () => {
      if (!(await chrome.permissions.request({ origins: ["<all_urls>"] }))) return;
      const { captureBlocked: cb = {} } = await chrome.storage.session.get("captureBlocked");
      delete cb[state.tabId];
      await chrome.storage.session.set({ captureBlocked: cb });
      chrome.tabs.sendMessage(state.tabId, { type: "am:retry" }).catch(() => {});
      renderHostRequests();
    });
    buttons.push(btn);
  }
  $("host-requests").replaceChildren(...buttons);
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.missingHosts || changes.captureBlocked) renderHostRequests();
  if (changes.pageStatus) renderPageStatus();
});

$("site-toggle").addEventListener("click", async () => {
  const { origin, tabId } = state;
  if (!origin) return;
  if ($("site-toggle").dataset.enabled) {
    await chrome.runtime.sendMessage({ type: "am:disable-site", origin, tabId });
  } else {
    // Must run inside the click handler (user gesture).
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return;
    await chrome.runtime.sendMessage({ type: "am:enable-site", origin, tabId });
  }
  await refreshSite();
});

chrome.tabs.onActivated.addListener(refreshSite);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === state.tabId && info.url) refreshSite();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "am:selected") explainSelection(msg.selection);
});

export { state };

await initSettings();
await watchModelStatus();
await refreshSite();
{
  // A click that opened the panel arrives before this page listens: pick it up.
  const { lastSelection } = await chrome.storage.session.get("lastSelection");
  if (lastSelection && Date.now() - lastSelection.at < 15000) explainSelection(lastSelection);
}
