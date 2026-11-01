import test from "node:test";
import assert from "node:assert/strict";

// Minimal chrome stub: enough for background.js to load and for restoreSites() to run.
const calls = { registered: [], executed: [], unregistered: [], offscreenCreated: [], sent: [] };
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
  },
  permissions: { contains: async ({ origins }) => origins[0] !== "https://revoked.example/*" },
  storage: {
    local: { get: async () => ({ enabledOrigins: ["https://reader.example", "https://revoked.example"] }), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
  scripting: {
    getRegisteredContentScripts: async () => [],
    registerContentScripts: async (scripts) => calls.registered.push(...scripts),
    unregisterContentScripts: async ({ ids }) => calls.unregistered.push(...ids),
    executeScript: async (opts) => calls.executed.push(opts),
  },
};

const { restoreSites, CONTENT_FILES, ensureOffscreen, engineCall } = await import("../background.js");

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
