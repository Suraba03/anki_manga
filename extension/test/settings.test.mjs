import test from "node:test";
import assert from "node:assert/strict";

function stubStorage() {
  const data = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
        set: async (obj) => Object.assign(data, structuredClone(obj)),
      },
    },
  };
  return data;
}

test("defaults, with an installId created once", async () => {
  const data = stubStorage();
  const { getSettings } = await import("../lib/settings.js");
  const a = await getSettings();
  assert.equal(a.perfMode, "auto");
  assert.deepEqual(a.llm, { mode: "free", provider: "deepseek", apiKey: "", baseUrl: "", model: "" });
  assert.match(a.installId, /^[0-9a-f-]{36}$/);
  const b = await getSettings();
  assert.equal(b.installId, a.installId);
  assert.equal(data.settings.installId, a.installId);
});

test("setSettings merges patches, including nested llm, and never changes installId", async () => {
  stubStorage();
  const { getSettings, setSettings } = await import("../lib/settings.js");
  const { installId } = await getSettings();
  await setSettings({ perfMode: "prefetch" });
  await setSettings({ llm: { mode: "own", apiKey: "k" }, installId: "evil" });
  const s = await getSettings();
  assert.equal(s.perfMode, "prefetch");
  assert.deepEqual(s.llm, { mode: "own", provider: "deepseek", apiKey: "k", baseUrl: "", model: "" });
  assert.equal(s.installId, installId);
});

test("deleting the saved key clears only the key (and may switch to off)", async () => {
  stubStorage();
  const { getSettings, setSettings } = await import("../lib/settings.js");
  await setSettings({ llm: { mode: "own", provider: "custom", apiKey: "k", baseUrl: "http://localhost:1/v1", model: "m" } });
  await setSettings({ llm: { apiKey: "", mode: "off" } });
  assert.deepEqual((await getSettings()).llm, { mode: "off", provider: "custom", apiKey: "", baseUrl: "http://localhost:1/v1", model: "m" });
});
