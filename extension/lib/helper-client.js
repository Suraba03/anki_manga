// Talks to the local helper (http://127.0.0.1:47812). Used by background and panel.
export const HELPER = "http://127.0.0.1:47812";

export class HelperError extends Error {
  constructor(error, status = 0, extra = {}) {
    super(error);
    this.error = error; // server's "error" string, or "helper_unreachable"
    this.status = status;
    Object.assign(this, extra);
  }
}

async function getToken() {
  return (await chrome.storage.local.get("token")).token || null;
}

async function rawFetch(path, init = {}) {
  try {
    return await fetch(HELPER + path, init);
  } catch {
    throw new HelperError("helper_unreachable");
  }
}

export async function call(path, { method = "GET", json, body, headers = {} } = {}) {
  const token = await getToken();
  const h = { ...headers };
  if (token) h["X-AM-Token"] = token;
  let payload = body;
  if (json !== undefined) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(json);
  }
  const resp = await rawFetch(path, { method, headers: h, body: payload });
  if (!resp.ok) {
    let data = {};
    try {
      data = await resp.json();
    } catch {
      /* non-JSON error body */
    }
    throw new HelperError(data.error || `http_${resp.status}`, resp.status, data);
  }
  return resp;
}

export async function callJson(path, opts) {
  const resp = await call(path, opts);
  return resp.status === 204 ? null : resp.json();
}

export async function health() {
  const resp = await rawFetch("/health");
  if (!resp.ok) throw new HelperError(`http_${resp.status}`, resp.status);
  return resp.json();
}

// Make sure we hold a working token: reuse the stored one, else pair (first use).
export async function ensurePaired() {
  try {
    if (await getToken()) {
      const check = await rawFetch("/auth/check", { headers: { "X-AM-Token": await getToken() } });
      if (check.status === 204) return { ok: true };
    }
    const resp = await rawFetch("/pair", { method: "POST" });
    const data = await resp.json();
    if (resp.status === 409) return { ok: false, error: "already_paired", hint: data.hint };
    if (!resp.ok) return { ok: false, error: data.error || `http_${resp.status}` };
    await chrome.storage.local.set({ token: data.token });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.error || "helper_unreachable" };
  }
}
