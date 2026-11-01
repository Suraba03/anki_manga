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
