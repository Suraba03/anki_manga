// User settings in chrome.storage.local (used by the service worker, the offscreen document and the panel).
const DEFAULTS = {
  perfMode: "auto", // "auto" | "prefetch" | "on-demand"
  llm: { mode: "free", provider: "deepseek", apiKey: "", baseUrl: "", model: "" },
};

async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return settings;
}

export async function getSettings() {
  const saved = await load();
  const installId = saved.installId || crypto.randomUUID();
  if (!saved.installId) await chrome.storage.local.set({ settings: { ...saved, installId } });
  return { ...DEFAULTS, ...saved, llm: { ...DEFAULTS.llm, ...saved.llm }, installId };
}

// patch: {perfMode?, llm?: partial}. installId is never overwritten.
export async function setSettings(patch) {
  const current = await getSettings();
  const { installId: _ignored, ...rest } = patch;
  const next = { ...current, ...rest, llm: { ...current.llm, ...rest.llm } };
  await chrome.storage.local.set({ settings: next });
  return next;
}
