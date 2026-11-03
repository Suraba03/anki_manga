// Compatibility survey: runs the unpacked extension on a list of real reader pages and records, per site, what the
// extension found and why it failed. The site list is a local JSON file (never committed):
//   [{"name": "...", "url": "https://...", "follow": "optional regex: open the first link whose href matches"}]
//
//   node tools/compat/survey.mjs <sites.json> [--grant-all] [--only name,name] [--headful]
//                                [--port-offset=N] [--resolve="MAP host:80 127.0.0.1:port"] [--out=name]
//
// Default run = what a user gets after "Enable on this site": only each start URL's origin is granted, so image hosts
// the extension asks about show up as missingHosts and screenshot needs as captureBlocked. --grant-all also grants
// <all_urls> (as if every "Allow …" button in the panel had been clicked).
// Output: tools/.cache/compat/<timestamp>[-all]/report.json, report.md and two screenshots per site.
//
// Safety: AnkiConnect is never called (nothing is clicked), and no explanation is requested.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, EXTENSION, ROOT, installChrome, launch, startServer, waitFor, sleep } from "../demo/common.mjs";
import { port } from "../ports.mjs";

const args = process.argv.slice(2);
const sitesFile = args.find((a) => !a.startsWith("--"));
if (!sitesFile) throw new Error("usage: node tools/compat/survey.mjs <sites.json> [--grant-all] [--only a,b] [--headful]");
const grantAll = args.includes("--grant-all");
const headful = args.includes("--headful");
const onlyArg = args.find((a) => a.startsWith("--only"));
const only = onlyArg ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1]).split(",") : null;
let sites = JSON.parse(readFileSync(sitesFile, "utf8"));
if (only) sites = sites.filter((s) => only.includes(s.name));

const flag = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const offset = Number(flag("port-offset") || 0);
const resolveRules = flag("resolve"); // passed to Chrome as --host-resolver-rules (local fixture hosts)
const outName = flag("out");
const short = flag("wait") === "short"; // local fixtures: no network, shorter waits
const PORT = port(9341) + offset;
const SERVE_PORT = port(47911) + offset;
const VIEW = { w: 1280, h: 900 };
const OUR_NAME = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).name;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = join(ROOT, "tools/.cache/compat", `${outName || stamp}${grantAll ? "-all" : ""}`);
mkdirSync(OUT, { recursive: true });

// Facts about the page, read in the page's own world (the overlay and badges are plain DOM).
const PAGE_FACTS = `(() => {
  const big = (w, h) => Math.min(w, h) >= 400 && Math.max(w, h) >= 600;
  const hostOf = (u) => { try { const x = new URL(u, location.href); return x.protocol.startsWith("http") ? x.host : x.protocol; } catch { return "?"; } };
  const count = (list) => list.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  const imgs = [...document.images];
  const manga = imgs.filter((i) => big(i.naturalWidth, i.naturalHeight));
  const all = [...document.querySelectorAll("body *")].slice(0, 8000);
  const bg = all.filter((e) => { const r = e.getBoundingClientRect(); if (r.width < 300 || r.height < 400) return false;
    const s = getComputedStyle(e).backgroundImage; return s && s.includes("url("); });
  return {
    url: location.href,
    title: document.title.slice(0, 70),
    mangaImgs: manga.length,
    imgHosts: count(manga.map((i) => hostOf(i.currentSrc || i.src))),
    lazyImgs: imgs.filter((i) => i.dataset.src || i.getAttribute("data-original") || i.loading === "lazy").length,
    canvases: [...document.querySelectorAll("canvas")].filter((c) => big(c.width, c.height)).length,
    bgImages: bg.length,
    svgImages: [...document.querySelectorAll("svg image")].length,
    shadowHosts: all.filter((e) => e.shadowRoot).length,
    iframes: [...document.querySelectorAll("iframe")].filter((f) => { const r = f.getBoundingClientRect(); return r.width > 300 && r.height > 300; }).map((f) => hostOf(f.src)),
    badges: [...document.querySelectorAll(".am-badge")].map((b) => b.dataset.text).filter(Boolean),
    bubbles: document.querySelectorAll(".am-bubble").length,
    bubblesRead: document.querySelectorAll(".am-bubble:not(.am-pending)").length,
    layers: document.querySelectorAll(".am-layer").length,
  };
})()`;

function chromeUserAgent(chromePath) {
  const v = execFileSync(chromePath, ["--version"], { encoding: "utf8" }).match(/(\d+)\./)[1];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
}

async function main() {
  const server = await startServer(SERVE_PORT, {});
  const profile = mkdtempSync(join(tmpdir(), "anki-manga-compat-"));
  const extCopy = join(OUT, "ext");
  cpSync(EXTENSION, extCopy, { recursive: true, filter: (p) => !/\/(node_modules|test)(\/|$)/.test(p.slice(EXTENSION.length)) });
  // A granted host permission needs a user gesture in a real browser; listing the origins in the copy's manifest is
  // the same grant without one. The code is the same as in extension/.
  const manifestFile = join(extCopy, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const origins = [...new Set(sites.map((s) => new URL(s.url).origin))];
  manifest.host_permissions.push(...origins.map((o) => `${o}/*`), ...(grantAll ? ["<all_urls>"] : []));
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const chromePath = installChrome();
  const chrome = launch(chromePath, [
    ...(headful ? [] : ["--headless=new"]),
    `--load-extension=${extCopy}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--enable-unsafe-webgpu",
    `--user-agent=${chromeUserAgent(chromePath)}`, "--lang=ja", `--window-size=${VIEW.w},${VIEW.h}`,
    ...(resolveRules ? [`--host-resolver-rules=${resolveRules}`] : []),
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank",
  ]);
  const base = `http://127.0.0.1:${PORT}`;
  const results = [];
  let sw;
  let off;
  try {
    sw = await waitFor(async () => {
      for (const t of (await (await fetch(`${base}/json/list`)).json()).filter((t) => t.type === "service_worker")) {
        const cdp = await Cdp.open(t.webSocketDebuggerUrl);
        if ((await cdp.evaluate("chrome.runtime.getManifest().name").catch(() => null)) === OUR_NAME) return cdp;
        cdp.close();
      }
    }, "the extension service worker");
    await waitFor(() => sw.evaluate('typeof handlers === "object"'), "background.js");
    await sw.evaluate(`chrome.storage.local.set({devModelBase: "http://127.0.0.1:${SERVE_PORT}/models/", settings: {perfMode: "prefetch"}})`);
    await sw.evaluate("chrome.sidePanel.open = async () => {}");
    for (const o of origins) await sw.evaluate(`handlers["am:enable-site"]({origin: ${JSON.stringify(o)}}, {})`);
    await sw.evaluate("ensureOffscreen()");
    const status = await waitFor(async () => {
      const st = await sw.evaluate('chrome.storage.session.get("modelStatus").then((r) => r.modelStatus || null)');
      return st && (st.state === "ready" || st.state === "error") ? st : null;
    }, "the engine", 300000);
    console.log(`engine: ${status.state} ${status.backend || ""} ${status.error || ""}`);

    // Every image request of the offscreen document (where pages are fetched), with its outcome.
    const offT = await waitFor(async () => (await (await fetch(`${base}/json/list`)).json()).find((t) => t.url.includes("/offscreen/offscreen.html")), "the offscreen document");
    off = await Cdp.open(offT.webSocketDebuggerUrl);
    const net = new Map();
    off.on("Network.requestWillBeSent", (p) => net.set(p.requestId, { url: p.request.url, t: Date.now(), referer: p.request.headers.Referer || null }));
    off.on("Network.responseReceived", (p) => { const r = net.get(p.requestId); if (r) Object.assign(r, { status: p.response.status, type: p.response.mimeType }); });
    off.on("Network.loadingFailed", (p) => { const r = net.get(p.requestId); if (r) Object.assign(r, { error: p.errorText, blocked: p.blockedReason || p.corsErrorStatus?.corsError || null }); });
    await off.send("Network.enable");

    for (const site of sites) {
      console.log(`\n== ${site.name}`);
      const t0 = Date.now();
      const res = { name: site.name, start: site.url };
      let tab;
      try {
        const v = await (await fetch(`${base}/json/version`)).json();
        const b = await Cdp.open(v.webSocketDebuggerUrl);
        const { targetId } = await b.send("Target.createTarget", { url: "about:blank", newWindow: true, width: VIEW.w, height: VIEW.h });
        b.close();
        const t = (await (await fetch(`${base}/json/list`)).json()).find((x) => x.id === targetId);
        tab = await Cdp.open(t.webSocketDebuggerUrl);
        await tab.send("Page.enable");
        await tab.send("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false });
        const loaded = () => waitFor(() => tab.evaluate("document.readyState === 'complete'"), "page load", 40000).catch(() => (res.note = "load timeout"));
        await tab.send("Page.navigate", { url: site.url });
        await loaded();
        if (site.follow) {
          await sleep(4000);
          const href = await tab.evaluate(`[...document.querySelectorAll("a[href]")].map((a) => a.href).find((h) => new RegExp(${JSON.stringify(site.follow)}).test(h)) || null`);
          res.followed = href;
          if (href) {
            await tab.send("Page.navigate", { url: href });
            await loaded();
          }
        }
        await sleep(short ? 12000 : 20000);
        res.first = await tab.evaluate(PAGE_FACTS);
        await shot(tab, join(OUT, `${site.name}-1.png`));
        // Move through the chapter: scroll readers scroll, paged (right-to-left) readers take ArrowLeft.
        for (let i = 0; i < 4; i++) {
          await tab.evaluate("window.scrollBy(0, Math.round(innerHeight * 0.9))");
          await sleep(2500);
        }
        for (let i = 0; i < 3; i++) {
          for (const type of ["keyDown", "keyUp"]) await tab.send("Input.dispatchKeyEvent", { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
          await sleep(2500);
        }
        await sleep(short ? 6000 : 12000);
        res.last = await tab.evaluate(PAGE_FACTS);
        await shot(tab, join(OUT, `${site.name}-2.png`));
        const tabs = await sw.evaluate("chrome.tabs.query({}).then((t) => t.map((x) => ({id: x.id, url: x.url})))");
        const tabId = tabs.find((x) => x.url === res.last.url)?.id;
        const ss = await sw.evaluate('chrome.storage.session.get(["pageStatus", "missingHosts", "captureBlocked"])');
        res.panel = { pageStatus: ss.pageStatus?.[tabId] ?? null, missingHosts: ss.missingHosts?.[tabId] ?? [], captureBlocked: !!ss.captureBlocked?.[tabId] };
        res.enabledHere = origins.includes(new URL(res.last.url).origin);
      } catch (e) {
        res.error = String(e.message || e);
      } finally {
        const reqs = [...net.values()].filter((r) => r.t >= t0 && !/^(chrome-extension|data|blob):|127\.0\.0\.1/.test(r.url));
        res.fetches = summarizeFetches(reqs);
        tab?.close();
        // Close the window so the next site's tab is the visible one (screenshots capture the active tab).
        const list = await (await fetch(`${base}/json/list`)).json().catch(() => []);
        for (const t of list.filter((t) => t.type === "page" && !t.url.startsWith("chrome-extension://"))) await fetch(`${base}/json/close/${t.id}`).catch(() => {});
      }
      results.push(res);
      console.log(oneLine(res));
      writeFileSync(join(OUT, "report.json"), JSON.stringify(results, null, 2));
    }
  } finally {
    sw?.close();
    off?.close();
    chrome.kill();
    server.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
    rmSync(extCopy, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, "report.md"), table(results));
  console.log(`\nreport: ${join(OUT, "report.md")}`);
}

async function shot(tab, file) {
  const r = await tab.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
}

function summarizeFetches(reqs) {
  const by = {};
  for (const r of reqs) {
    let host;
    try { host = new URL(r.url).host; } catch { host = r.url.slice(0, 40); }
    const outcome = r.status ? `HTTP ${r.status}` : r.error ? `${r.error}${r.blocked ? ` (${r.blocked})` : ""}` : "pending";
    const k = `${host} → ${outcome}`;
    by[k] = (by[k] || 0) + 1;
  }
  return by;
}

function oneLine(r) {
  if (r.error) return `  ERROR ${r.error}`;
  const l = r.last;
  return `  ${l.url}\n  imgs ${l.mangaImgs} ${JSON.stringify(l.imgHosts)} canvas ${l.canvases} bg ${l.bgImages} svg ${l.svgImages} shadow ${l.shadowHosts} iframes ${JSON.stringify(l.iframes)}\n  bubbles ${l.bubblesRead}/${l.bubbles} layers ${l.layers} badges ${JSON.stringify([...new Set(l.badges)])}\n  panel ${JSON.stringify(r.panel)}\n  fetches ${JSON.stringify(r.fetches)}`;
}

function table(results) {
  const rows = results.map((r) => {
    if (r.error) return `| ${r.name} | error: ${r.error} | | | | |`;
    const l = r.last;
    const kinds = [l.mangaImgs && `img×${l.mangaImgs}`, l.canvases && `canvas×${l.canvases}`, l.bgImages && `bg×${l.bgImages}`, l.svgImages && `svg×${l.svgImages}`, l.shadowHosts && `shadow×${l.shadowHosts}`, l.iframes.length && `iframe×${l.iframes.length}`].filter(Boolean).join(" ");
    return `| ${r.name} | ${kinds || "nothing manga-sized"} | ${l.layers} pages, ${l.bubblesRead}/${l.bubbles} bubbles | ${[...new Set(l.badges)].join("; ")} | ${r.panel ? `${r.panel.missingHosts.join(", ")}${r.panel.captureBlocked ? " +screenshots" : ""}` : ""} | ${Object.entries(r.fetches).map(([k, n]) => `${k} ×${n}`).join("<br>")} |`;
  });
  return `| site | page elements | read | badges | asks for | image fetches |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
