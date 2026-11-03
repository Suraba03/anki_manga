// A demo session: Chrome for Testing with the unpacked extension, a reader window (the demo page on a local origin)
// and a panel window (panel/panel.html opened as a page, the way the e2e harness does), plus the fake AnkiConnect and
// the free-tier proxy. Used by screenshots.mjs and video.mjs.
//
// Safety, same as tools/e2e/run.mjs: the real AnkiConnect (port 8765) is never reached. Every request of the panel
// page passes through a Fetch guard: one aimed at 8765 is redirected to the fake (8766 + ANKI_MANGA_PORT_OFFSET), or failed.
// Free tier: the panel's requests to the free server are made here (node) so they can be counted and, while
// developing, answered from tools/.cache/demo-free.json (recorded real answers). --live always asks the server.
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { createServer } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FREE_URL } from "../../extension/lib/llm.js";
import { Cdp, EXTENSION, OUT, ROOT, installChrome, launch, startServer, waitFor, sleep } from "./common.mjs";
import { port } from "../ports.mjs";

// Frame: 1280x800 = a 60 px headline/caption strip on top + [reader 759 | 1 px divider | panel 520] x 740.
// The panel page is zoomed 1.25x (CSS zoom, so text stays vector-sharp) to make its text larger in the thumbnails.
export const VIEW = { readerW: 759, panelW: 520, panelZoom: 1.25, h: 740, topH: 60 };
const FAKE_ANKI_PORT = port(8766);
const REAL_ANKI_PORT = 8765;
const FREE_HOST = new URL(FREE_URL).hostname;
const FREE_CACHE = join(ROOT, "tools/.cache/demo-free.json");
const OUR_NAME = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).name;
export const SITE_HOST = "reader.example";

const READER_HTML = `<!doctype html><meta charset="utf-8"><title>Demo reader</title>
<body style="margin:0;height:${VIEW.h}px;background:#2b2b2e;display:flex;justify-content:center;overflow:hidden">
<img src="/page.png" style="height:${VIEW.h}px;display:block">`;

// A drawn arrow that eases between points (headless Chrome has no cursor). window.__cursor.moveTo returns a Promise.
const CURSOR_SCRIPT = `(() => {
  if (window.__cursor) return;
  const make = () => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("width", "26"); el.setAttribute("height", "34"); el.setAttribute("viewBox", "0 0 26 34");
    el.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;display:none;filter:drop-shadow(0 2px 2px rgba(0,0,0,.45));zoom:" + 1 / (parseFloat(document.documentElement.style.zoom) || 1);
    el.innerHTML = '<path d="M2 2 L2 27 L8.5 21 L13 31 L17.5 29 L13 19.5 L22 19.5 Z" fill="#fff" stroke="#111" stroke-width="2" stroke-linejoin="round"/>';
    document.documentElement.appendChild(el);
    return el;
  };
  let el = null, x = 0, y = 0;
  const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const put = () => { el.style.transform = "translate(" + x + "px," + y + "px)"; };
  window.__cursor = {
    show(px, py) { el ||= make(); x = px; y = py; put(); el.style.display = "block"; },
    hide() { if (el) el.style.display = "none"; },
    pos: () => [x, y],
    moveTo(px, py, ms) {
      el ||= make();
      el.style.display = "block";
      const x0 = x, y0 = y, t0 = performance.now();
      return new Promise((done) => {
        const step = (now) => {
          const k = Math.min(1, (now - t0) / ms), e = ease(k);
          x = x0 + (px - x0) * e; y = y0 + (py - y0) * e; put();
          if (k < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
    },
    press(down) {
      if (!el) return;
      el.firstChild.style.transformOrigin = "2px 2px";
      el.firstChild.style.transform = down ? "scale(.86)" : "";
      if (!down) return;
      const ring = document.createElement("div"); // a ring that spreads from the click point
      ring.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border:3px solid #f5a524;border-radius:50%;zoom:" + 1 / (parseFloat(document.documentElement.style.zoom) || 1) + ";left:" + (x + 2) + "px;top:" + (y + 2) + "px";
      document.documentElement.appendChild(ring);
      ring.animate([{ transform: "scale(.25)", opacity: 0.95 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 520, easing: "ease-out" }).finished.then(() => ring.remove());
    },
  };
})();`;

// The stand-in for AnkiConnect (as in the e2e harness).
function startFakeAnki() {
  const notes = [];
  const state = { model: null }; // the createModel request (real templates and CSS of the note type), kept to render the card
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      if (req.method !== "POST") return res.end();
      const { action, params } = JSON.parse(body);
      const results = {
        requestPermission: { permission: "granted", requireApikey: false, version: 6 },
        deckNames: ["Default", "manga mining"],
        modelNames: state.model ? ["Manga Mining (anki_manga)"] : [],
        findNotes: [],
        notesInfo: [],
      };
      if (action === "addNote") notes.push(params.note);
      if (action === "createModel") state.model = params;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: action === "addNote" ? 1 : (results[action] ?? null), error: null }));
    });
  });
  return new Promise((resolve) => {
    server.on("error", () => resolve(null));
    server.listen(FAKE_ANKI_PORT, "127.0.0.1", () => resolve({ server, notes, state }));
  });
}

export async function startSession({ port: cdpPort = port(9336), servePort = port(47903), live = false } = {}) {
  const origin = `http://${SITE_HOST}`; // port 80 is mapped to the local server below
  const server = await startServer(servePort, {
    "/": { type: "text/html; charset=utf-8", body: READER_HTML },
    "/blank": { type: "text/html; charset=utf-8", body: READER_HTML.replace(/<img[^>]*>/, "") },
    "/page.png": { type: "image/png", file: join(OUT, "demo-page.png") },
  });
  const anki = await startFakeAnki();
  if (!anki) throw new Error(`port ${FAKE_ANKI_PORT} is busy`);
  const profile = mkdtempSync(join(tmpdir(), "anki-manga-demo-"));
  // A copy of extension/ whose manifest also lists the demo host: only that way is the content script allowed on it
  // (a granted host permission needs a user gesture in a real browser). The code is the same as in extension/.
  const extCopy = join(OUT, "tmp", "ext");
  rmSync(extCopy, { recursive: true, force: true });
  mkdirSync(extCopy, { recursive: true });
  cpSync(EXTENSION, extCopy, { recursive: true, filter: (p) => !/\/(node_modules|test)(\/|$)/.test(p.slice(EXTENSION.length)) });
  const manifestFile = join(extCopy, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.host_permissions.push(`${origin}/*`);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const chrome = launch(installChrome(), [
    "--headless=new", `--load-extension=${extCopy}`, `--host-resolver-rules=MAP ${SITE_HOST}:80 127.0.0.1:${servePort}`, "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--enable-unsafe-webgpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank",
  ]);
  const s = { origin, anki, free: { requests: 0, live: 0 }, redirected: 0, tabs: [] };
  const base = `http://127.0.0.1:${cdpPort}`;

  s.close = async () => {
    for (const t of s.tabs) t.close();
    s.sw?.close();
    chrome.kill();
    server.close();
    anki.server.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  };

  try {
    s.sw = await waitFor(async () => {
      const targets = await (await fetch(`${base}/json/list`)).json();
      for (const t of targets.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
        const cdp = await Cdp.open(t.webSocketDebuggerUrl);
        if ((await cdp.evaluate("chrome.runtime.getManifest().name").catch(() => null)) === OUR_NAME) return cdp;
        cdp.close();
      }
    }, "the extension service worker");
    const sw = s.sw;
    await waitFor(() => sw.evaluate('typeof handlers === "object"'), "background.js to load");
    await sw.evaluate(`chrome.storage.local.set({devModelBase: ${JSON.stringify(`${origin}/models/`)}})`);
    await sw.evaluate('chrome.storage.local.set({settings: {perfMode: "prefetch"}})');
    await sw.evaluate(`handlers["am:enable-site"]({origin: ${JSON.stringify(origin)}}, {})`);
    s.extId = await sw.evaluate("chrome.runtime.id");
    // The real side panel is not part of these frames (the panel page is shown in its own window instead). Opening it
    // would narrow the reader window mid-recording, so the harness makes that one call do nothing.
    await sw.evaluate("chrome.sidePanel.open = async () => {}");

    // Each page in its own window: tabs of one window would leave all but one "hidden" (no frames, no animation).
    s.newWindow = async (w, h, dsf = 1) => {
      const v = await (await fetch(`${base}/json/version`)).json();
      const b = await Cdp.open(v.webSocketDebuggerUrl);
      const { targetId } = await b.send("Target.createTarget", { url: "about:blank", newWindow: true, width: w, height: h });
      b.close();
      const t = (await (await fetch(`${base}/json/list`)).json()).find((x) => x.id === targetId);
      const cdp = await Cdp.open(t.webSocketDebuggerUrl);
      s.tabs.push(cdp);
      await cdp.send("Page.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf, mobile: false });
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CURSOR_SCRIPT });
      return cdp;
    };

    s.waitEngine = async () => {
      await sw.evaluate("ensureOffscreen()");
      const status = await waitFor(async () => {
        const st = await sw.evaluate('chrome.storage.session.get("modelStatus").then((r) => r.modelStatus || null)');
        return st && (st.state === "ready" || st.state === "error") ? st : null;
      }, "the engine to become ready", 300000);
      if (status.state === "error") throw new Error(`engine failed to start: ${status.error}`);
      return status;
    };

    // Renders an HTML string to a PNG (strips, card view, end card) in a window of its own.
    s.renderHtml = async (html, w, h, file) => {
      const win = (s.shotWin ||= await s.newWindow(1280, 800));
      await win.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await win.send("Page.navigate", { url: `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}` });
      await waitFor(() => win.evaluate("document.readyState === 'complete' && [...document.images].every((i) => i.complete)"), "the page to render");
      await sleep(250);
      const r = await win.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    };

    // The reader: opens the demo page (the extension finds the image and reads it).
    s.openReader = async () => {
      const reader = await s.newWindow(VIEW.readerW, VIEW.h);
      s.reader = reader;
      return reader;
    };
    s.loadReader = async () => {
      await s.reader.send("Page.navigate", { url: `${origin}/` });
    };

    // The panel page. The tab "being looked at" is the reader, not this window: tabs.query is answered for it.
    s.openPanel = async () => {
      const readerTab = await sw.evaluate(`chrome.tabs.query({url: ${JSON.stringify(`${origin}/*`)}}).then((t) => ({id: t[0].id, url: t[0].url, title: t[0].title}))`).catch(() => null);
      const panel = await s.newWindow(VIEW.panelW, VIEW.h);
      s.panel = panel;
      await panel.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `{ const zoom = () => { if (document.documentElement) document.documentElement.style.zoom = "${VIEW.panelZoom}"; };
          zoom(); addEventListener("DOMContentLoaded", zoom);
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (m, ...rest) => send(m && m.type === "am:engine" ? { target: "offscreen", ...m.msg } : m, ...rest);
          const tab = ${JSON.stringify(readerTab)};
          const query = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = (q, ...rest) => (q && q.active && tab ? Promise.resolve([{ ...tab, active: true }]) : query(q, ...rest)); }`,
      });
      panel.on("Fetch.requestPaused", (ev) => guard(s, panel, ev, live));
      await panel.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await panel.send("Page.navigate", { url: `chrome-extension://${s.extId}/panel/panel.html` });
      return panel;
    };
  } catch (e) {
    await s.close();
    throw e;
  }
  return s;
}

// Fail-safe guard for the real AnkiConnect plus the free-tier proxy.
function guard(s, panel, ev, live) {
  let target = null;
  let isFree = false;
  try {
    const u = new URL(ev.request.url);
    if ((u.port || (u.protocol === "https:" ? "443" : "80")) === String(REAL_ANKI_PORT)) {
      target = new URL(ev.request.url);
      target.protocol = "http:";
      target.hostname = "127.0.0.1";
      target.port = String(FAKE_ANKI_PORT);
    }
    isFree = u.hostname === FREE_HOST;
  } catch {
    // not network traffic of ours
  }
  const reply = isFree
    ? freeAnswer(s, panel, ev, live)
    : /:8765\b/.test(ev.request.url) && !target
      ? panel.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" })
      : panel.send("Fetch.continueRequest", { requestId: ev.requestId, ...(target && { url: target.href }) });
  if (target) s.redirected++;
  Promise.resolve(reply).catch(() => {});
}

async function freeAnswer(s, panel, ev, live) {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Free-Remaining", "Access-Control-Allow-Headers": "*" };
  const fulfill = (status, hdrs, body) =>
    panel.send("Fetch.fulfillRequest", {
      requestId: ev.requestId,
      responseCode: status,
      responseHeaders: Object.entries({ ...headers, ...hdrs }).map(([name, value]) => ({ name, value })),
      body: Buffer.from(body).toString("base64"),
    });
  if (ev.request.method === "OPTIONS") return fulfill(204, {}, "");
  s.free.requests++;
  const text = JSON.parse(ev.request.postData || "{}").text;
  const cache = existsSync(FREE_CACHE) ? JSON.parse(readFileSync(FREE_CACHE, "utf8")) : {};
  if (!live && cache[text]) {
    s.free.cached = (s.free.cached || 0) + 1;
    return fulfill(200, { "Content-Type": "application/json", "X-Free-Remaining": cache[text].remaining ?? "" }, cache[text].body);
  }
  s.free.live++;
  console.log(`  free tier: live request #${s.free.live} for ${JSON.stringify(text)}`);
  // The server only answers extension origins: the panel's own Origin header goes along (node's https, which lets it be set).
  const { status, body, remaining } = await new Promise((resolve, reject) => {
    const req = https.request(ev.request.url, { method: "POST", headers: { "Content-Type": "application/json", Origin: ev.request.headers.Origin || ev.request.headers.origin || `chrome-extension://${s.extId}` } }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, body: b, remaining: res.headers["x-free-remaining"] ?? null }));
    });
    req.on("error", reject);
    req.end(ev.request.postData);
  });
  const resp = { ok: status >= 200 && status < 300, status };
  if (resp.ok) {
    cache[text] = { body, remaining };
    mkdirSync(dirname(FREE_CACHE), { recursive: true });
    writeFileSync(FREE_CACHE, JSON.stringify(cache, null, 1));
  }
  return fulfill(resp.status, { "Content-Type": "application/json", ...(remaining != null && { "X-Free-Remaining": remaining }) }, body);
}

// ---- helpers for driving the pages ------------------------------------------------------------------------
export const text = (cdp, sel) => cdp.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`);

// Centre of the first element matching the selector whose text includes `contains`, in viewport coordinates.
export async function centerOf(cdp, sel, contains = "") {
  const r = await cdp.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(contains)}));
    if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; })()`);
  if (!r) throw new Error(`no element ${sel} containing ${contains}`);
  return r;
}

// Moves the drawn cursor (smooth, in the page) and the real mouse along the same eased path.
export async function moveMouse(cdp, x, y, ms = 700) {
  const [x0, y0] = await cdp.evaluate("window.__cursor.pos()");
  const anim = cdp.evaluate(`window.__cursor.moveTo(${x}, ${y}, ${ms})`);
  const t0 = Date.now();
  const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
  for (;;) {
    const k = Math.min(1, (Date.now() - t0) / ms);
    const e = ease(k);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + (x - x0) * e, y: y0 + (y - y0) * e });
    if (k >= 1) break;
    await sleep(25);
  }
  await anim;
}

export async function clickMouse(cdp, x, y) {
  await cdp.evaluate("window.__cursor.press(true)");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(90);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(120);
  await cdp.evaluate("window.__cursor.press(false)");
}

export const badgeText = (reader) => reader.evaluate('[...document.querySelectorAll(".am-badge")].map((b) => b.dataset.text).join("|")');
