// The origins whose browser data the lab clears before a site, and the record of where each site's tab went.
// Pure; run.mjs does the CDP calls.

const STORAGE = ["local_storage", "indexeddb", "cache_storage", "service_workers", "websql", "file_systems", "shader_cache"];

// Site storage only: cookies also hold logins and consent, which a reader needs. A site whose reading position lives
// in a cookie sets "resetCookies": true in the site list.
export const clearTypes = (site) => (site?.resetCookies === true ? [...STORAGE, "cookies"] : STORAGE).join(",");

// http(s) origins of a list of URLs, deduped, in order (never chrome-extension://, about:, junk).
export function httpOrigins(urls) {
  const out = [];
  for (const u of urls || []) {
    let url;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    if ((url.protocol === "http:" || url.protocol === "https:") && !out.includes(url.origin)) out.push(url.origin);
  }
  return out;
}

// {name: [origins]} plus new origins for one site: deduped, the newest `cap` kept.
export function mergeOrigins(saved, name, origins, cap = 20) {
  const merged = httpOrigins([...(saved?.[name] || []), ...origins]);
  return { ...saved, [name]: merged.slice(-cap) };
}

// What to clear before a site: its listed origin and the ones its tab ended on or framed in an earlier run.
export function originsToClear(site, saved) {
  return httpOrigins([site.url, ...(saved?.[site.name] || [])]);
}
