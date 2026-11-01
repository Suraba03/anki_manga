import test from "node:test";
import assert from "node:assert/strict";
import { acceptSender, engineHandlers, isDevBuild } from "../engine/trust.js";

const ext = { id: "ext", root: "chrome-extension://ext/" };
const worker = { id: "ext", url: "chrome-extension://ext/background.js" };
const panelInTab = { id: "ext", url: "chrome-extension://ext/panel/panel.html", tab: { id: 5 } };
const sidePanel = { id: "ext", url: "chrome-extension://ext/panel/panel.html" };
const contentScript = { id: "ext", url: "https://reader.example/ch1", tab: { id: 6 } };
const otherExtension = { id: "other", url: "chrome-extension://other/background.js" };

test("the offscreen engine takes messages from the extension's own service worker only", () => {
  assert.equal(acceptSender(worker, { ...ext, dev: false }), true);
  assert.equal(acceptSender(contentScript, { ...ext, dev: false }), false, "a content script (tab sender)");
  assert.equal(acceptSender(sidePanel, { ...ext, dev: false }), false, "another extension page");
  assert.equal(acceptSender(panelInTab, { ...ext, dev: false }), false);
  assert.equal(acceptSender(otherExtension, { ...ext, dev: false }), false);
  assert.equal(acceptSender(undefined, { ...ext, dev: false }), false);
  assert.equal(acceptSender({ id: "ext", url: "chrome-extension://ext/background.js", tab: { id: 1 } }, { ...ext, dev: false }), false);
});

test("an unpacked (dev) build also takes extension pages, but never a content script", () => {
  assert.equal(acceptSender(worker, { ...ext, dev: true }), true);
  assert.equal(acceptSender(panelInTab, { ...ext, dev: true }), true, "the e2e harness opens the panel in a tab");
  assert.equal(acceptSender(sidePanel, { ...ext, dev: true }), true);
  assert.equal(acceptSender(contentScript, { ...ext, dev: true }), false);
  assert.equal(acceptSender(otherExtension, { ...ext, dev: true }), false);
});

test("a build with update_url (the Store) is not a dev build", () => {
  assert.equal(isDevBuild({ name: "x" }), true);
  assert.equal(isDevBuild({ name: "x", update_url: "https://clients2.google.com/service/update2/crx" }), false);
});

test("the probe handlers are part of the engine only in a dev build", () => {
  const common = { "eng:page": 1, "eng:clear": 2 };
  const probes = { "eng:probe-fetch": 3, "eng:probe-anki": 4, "eng:probe-webgpu": 5 };
  assert.deepEqual(Object.keys(engineHandlers(common, probes, false)), ["eng:page", "eng:clear"]);
  assert.deepEqual(Object.keys(engineHandlers(common, probes, true)).sort(), [...Object.keys(common), ...Object.keys(probes)].sort());
});
