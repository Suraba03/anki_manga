import test from "node:test";
import assert from "node:assert/strict";

// Minimal chrome stub: enough for background.js to load and for restoreSites() to run.
const calls = { registered: [], executed: [], unregistered: [] };
const listeners = () => ({ addListener() {} });
globalThis.chrome = {
  runtime: { onInstalled: listeners(), onStartup: listeners(), onMessage: listeners(), sendMessage: async () => {} },
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

const { restoreSites, CONTENT_FILES } = await import("../background.js");

test("restoreSites re-registers enabled sites after an extension reload and injects open tabs", async () => {
  await restoreSites();
  assert.deepEqual(calls.registered.map((s) => s.id), ["am:https://reader.example"]);
  assert.deepEqual(calls.registered[0].js, CONTENT_FILES);
  assert.deepEqual(calls.executed.map((e) => e.target.tabId), [7]);
});
