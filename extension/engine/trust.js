// Who may talk to the offscreen engine, and which handlers exist in which build.
// chrome.runtime.sendMessage from a content script reaches every extension page, so the offscreen document
// must check the sender itself.

// An unpacked extension has no update_url (the same test that gates devModelBase in the service worker).
export function isDevBuild(manifest) {
  return !manifest.update_url;
}

// id: chrome.runtime.id, root: chrome.runtime.getURL("") (e.g. "chrome-extension://<id>/").
// Store build: only the extension's own service worker. Dev build: also the extension's own pages (the e2e
// harness opens the panel in a tab); a content script (page URL) never passes.
export function acceptSender(sender, { id, root, dev }) {
  if (!sender || sender.id !== id || typeof sender.url !== "string") return false;
  if (!sender.url.startsWith(root)) return false;
  if (dev) return true;
  return !sender.tab && sender.url === `${root}background.js`;
}

// The probe handlers (arbitrary fetch, AnkiConnect, WebGPU) are for the platform probe of an unpacked build.
export function engineHandlers(common, probes, dev) {
  return dev ? { ...common, ...probes } : { ...common };
}
