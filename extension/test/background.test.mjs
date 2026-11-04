import test from "node:test";
import assert from "node:assert/strict";

// Minimal chrome stub: enough for background.js to load and for restoreSites() to run.
const calls = { registered: [], executed: [], unregistered: [], offscreenCreated: [], sent: [], permissionChecks: [] };
const session = {}; // chrome.storage.session
let allUrls = false; // is <all_urls> granted (screenshots)
let offscreenOpen = false;
const listeners = () => ({ addListener() {} });
globalThis.chrome = {
  runtime: {
    onInstalled: listeners(),
    onStartup: listeners(),
    onMessage: listeners(),
    sendMessage: async (msg) => {
      calls.sent.push(msg);
      return { ok: true, echo: msg.type };
    },
    getContexts: async () => (offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
  },
  offscreen: {
    createDocument: async (opts) => {
      calls.offscreenCreated.push(opts);
      await new Promise((r) => setTimeout(r, 10));
      offscreenOpen = true;
    },
  },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  tabs: {
    onRemoved: listeners(),
    onUpdated: listeners(),
    query: async ({ url }) => (url === "https://reader.example/*" ? [{ id: 7, url: "https://reader.example/ch1" }] : []),
    captureVisibleTab: async () => {
      throw new Error("not allowed");
    },
  },
  permissions: {
    contains: async ({ origins }) => {
      calls.permissionChecks.push(origins[0]);
      if (origins[0] === "<all_urls>") return allUrls;
      if (!/^https?:\/\//.test(origins[0])) throw new Error(`Invalid value for origin pattern ${origins[0]}`);
      return origins[0] !== "https://revoked.example/*";
    },
  },
  storage: {
    local: {
      get: async () => ({ enabledOrigins: ["https://reader.example", "https://revoked.example"] }),
      set: async () => {},
      setAccessLevel: async () => {},
    },
    session: {
      get: async (key) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
      set: async (obj) => Object.assign(session, structuredClone(obj)),
    },
    onChanged: listeners(),
  },
  scripting: {
    getRegisteredContentScripts: async () => [],
    registerContentScripts: async (scripts) => calls.registered.push(...scripts),
    unregisterContentScripts: async ({ ids }) => calls.unregistered.push(...ids),
    executeScript: async (opts) => calls.executed.push(opts),
  },
};

const { restoreSites, CONTENT_FILES, ensureOffscreen, engineCall, handlers } = await import("../background.js");

test("restoreSites re-registers enabled sites after an extension reload and injects open tabs", async () => {
  await restoreSites();
  assert.deepEqual(calls.registered.map((s) => s.id), ["am:https://reader.example"]);
  assert.deepEqual(calls.registered[0].js, CONTENT_FILES);
  assert.deepEqual(calls.executed.map((e) => e.target.tabId), [7]);
});

test("ensureOffscreen creates the offscreen document once, even for concurrent callers", async () => {
  await Promise.all([ensureOffscreen(), ensureOffscreen()]);
  await ensureOffscreen();
  assert.equal(calls.offscreenCreated.length, 1);
  assert.equal(calls.offscreenCreated[0].url, "offscreen/offscreen.html");
  assert.deepEqual(calls.offscreenCreated[0].reasons, ["WORKERS"]);
  assert.equal(calls.offscreenCreated[0].justification, "Runs the manga text recognition models");
});

test("engineCall targets the offscreen document and returns its reply", async () => {
  const reply = await engineCall({ type: "eng:probe-fetch", url: "https://x.example/" });
  assert.deepEqual(calls.sent.at(-1), { target: "offscreen", type: "eng:probe-fetch", url: "https://x.example/" });
  assert.deepEqual(reply, { ok: true, echo: "eng:probe-fetch" });
});

// --- images the content script already loaded, blob: URLs, host requests, screenshot probe -------------------
const tab = { tab: { id: 3, windowId: 1 } };
const png = "data:image/png;base64,AAAA";

test("am:page with the image bytes skips the host-permission check and passes the data URL on", async () => {
  calls.permissionChecks.length = 0;
  const reply = await handlers["am:page"]({ type: "am:page", imageUrl: "https://cdn.example/p.jpg", dataUrl: png }, tab);
  assert.equal(reply.ok, true);
  assert.deepEqual(calls.permissionChecks, []);
  const sent = calls.sent.at(-1);
  assert.equal(sent.type, "eng:page");
  assert.deepEqual(sent.source, { dataUrl: png });
});

test("am:page rejects a bad or oversized data URL", async () => {
  const before = calls.sent.length;
  for (const dataUrl of ["https://x.example/p.jpg", 5, "data:" + "A".repeat(48 * 1024 * 1024)]) {
    assert.deepEqual(await handlers["am:page"]({ type: "am:page", imageUrl: "https://cdn.example/p.jpg", dataUrl }, tab), { ok: false, error: "bad_image" });
  }
  assert.equal(calls.sent.length, before, "nothing reached the engine");
});

test("am:page with a blob: URL (no bytes) fails as fetch_failed instead of throwing", async () => {
  const before = calls.sent.length;
  const reply = await handlers["am:page"]({ type: "am:page", imageUrl: "blob:https://reader.example/1-2-3" }, tab);
  assert.deepEqual(reply, { ok: false, error: "fetch_failed" });
  assert.equal(calls.sent.length, before);
});

test("no_image_permission does not note the host by itself: the content script reports it once the image is known to be a page", async () => {
  const reply = await handlers["am:page"]({ type: "am:page", imageUrl: "https://revoked.example/p.jpg" }, tab);
  assert.deepEqual(reply, { ok: false, error: "no_image_permission", host: "revoked.example" });
  assert.equal(session.missingHosts, undefined);
});

test("am:missing-host notes a valid host for the sending tab, nothing else", async () => {
  await handlers["am:missing-host"]({ type: "am:missing-host", host: "revoked.example" }, tab);
  await handlers["am:missing-host"]({ type: "am:missing-host", host: "cdn.example:8443" }, tab);
  await handlers["am:missing-host"]({ type: "am:missing-host", host: "evil.example/x" }, tab);
  await handlers["am:missing-host"]({ type: "am:missing-host", host: 7 }, tab);
  await handlers["am:missing-host"]({ type: "am:missing-host", host: "from-panel.example" }, {});
  assert.deepEqual(session.missingHosts, { 3: ["revoked.example", "cdn.example:8443"] });
});

test("am:missing-host accepts host names as URL() writes them (underscores, IPv6, ports) and rejects the rest", async () => {
  for (const key of Object.keys(session)) delete session[key];
  const good = ["cdn_1.example.com", "[::1]:8080", "cdn.example:8443", "xn--r8jz45g.example"];
  const bad = ["..", "-", "a..b", "a.b.", "evil.example/x", "*.example", "a b", "user@x.example", "x.example:99999", "", "A.Example"];
  for (const host of [...good, ...bad]) await handlers["am:missing-host"]({ type: "am:missing-host", host }, tab);
  assert.deepEqual(session.missingHosts, { 3: good });
  for (const key of Object.keys(session)) delete session[key];
});

test("am:capture probe reports whether screenshots are allowed, and marks the tab when not", async () => {
  const before = calls.sent.length;
  allUrls = true;
  assert.deepEqual(await handlers["am:capture"]({ type: "am:capture", probe: true }, tab), { ok: true });
  assert.equal(session.captureBlocked, undefined);
  allUrls = false;
  const reply = await handlers["am:capture"]({ type: "am:capture", probe: true }, tab);
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "capture_failed");
  assert.deepEqual(session.captureBlocked, { 3: true });
  assert.equal(calls.sent.length, before, "a probe never reaches the engine");
});
