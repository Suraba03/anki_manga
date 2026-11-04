// Reading-speed harness (backlog E2-1): a 200-page chapter in one vertical scroll, the unpacked extension in Chrome for
// Testing, and per jump (page 100, then page 150) the time until the page on screen has a clickable bubble, its texts,
// and where that time went. Cold run (fresh profile) and revisit run (same profile, reload, the same jumps).
//
//   node tools/perf/run.mjs [--headful] [--pages=200] [--jumps=100,150] [--lazy=on|off|both] [--fling]
//                           [--latency=40] [--top-wait=3000] [--dwell=3000] [--no-cache] [--hover] [--out=name]
//   --hover  also hover the first bubble of the page as soon as it is clickable and time its text (this prioritizes that
//            bubble, so first-text numbers of a --hover run are not comparable with a run without it)
//
// Timing marks come from extension/content/main.js, extension/engine/{runtime,scheduler}.js and
// extension/offscreen/offscreen.js; they record only while this harness has set globalThis.__amTrace (over CDP) in the
// content script's world and in the offscreen document. The panel summary (chrome.storage.session pageStatus) is
// logged from the service worker by a storage listener the harness installs. Nothing in the extension changes.
// Output: tools/.cache/perf/<name>/{report.md,report.json,raw-<variant>-<run>.json}. No explanation is requested and
// AnkiConnect is never called. Fixture hosts are fake (reader.test), the page image is docs/demo/page.png.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, EXTENSION, ROOT, installChrome, launch, startServer, waitFor, sleep } from "../demo/common.mjs";
import { port } from "../ports.mjs";
import { startChapter, PAGE_H, GAP } from "./chapter.mjs";
import { analyzeJump } from "./analyze.mjs";
import { markdown, summaryLine } from "./report.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const headful = args.includes("--headful");
const fling = args.includes("--fling");
const hoverFirst = args.includes("--hover");
const pages = Number(flag("pages", 200));
const jumps = flag("jumps", "100,150").split(",").map(Number);
const lazyArg = flag("lazy", "on");
const latencyMs = Number(flag("latency", 40));
const topWait = Number(flag("top-wait", 3000));
const dwell = Number(flag("dwell", 3000));
const flingPx = Number(flag("fling-px", 2400)); // pixels per frame
const cache = !args.includes("--no-cache");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = join(ROOT, "tools/.cache/perf", flag("out", stamp));
const PORT = port(9361);
const CHAPTER_PORT = port(47961);
const SERVE_PORT = port(47962);
const READER = "http://reader.test";
const VIEW = { w: 1280, h: 900 };
const DONE_TIMEOUT = 120000;
const OUR_NAME = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).name;
mkdirSync(OUT, { recursive: true });

const keyOf = (n) => `${READER}/p/${n}.png`;
const epoch = "performance.timeOrigin + performance.now()";

// In the page: the first moment a bubble of page n is on screen and the topmost element at its centre (a click would hit it).
const watchScript = (n) => `(() => {
  const img = document.getElementById("p${n}");
  window.__perfClickable = null;
  window.__perfBubble = null;
  clearInterval(window.__perfWatch);
  window.__perfWatch = setInterval(() => {
    const r = img.getBoundingClientRect();
    for (const b of document.querySelectorAll(".am-bubble")) {
      const q = b.getBoundingClientRect();
      if (q.width < 4 || q.height < 4) continue;
      const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
      if (cx < r.left || cx > r.right || cy < Math.max(0, r.top) || cy > Math.min(innerHeight, r.bottom)) continue;
      const el = document.elementFromPoint(cx, cy);
      if (el && (el === b || b.contains(el))) { window.__perfClickable = ${epoch}; window.__perfBubble = { x: cx, y: cy, id: Number(b.dataset.amBubble) }; clearInterval(window.__perfWatch); return; }
    }
  }, 25);
})()`;

const instantJump = (n) => `(() => { const t = ${epoch}; document.getElementById("p${n}").scrollIntoView({ block: "start" }); return { tScroll: t, tArrive: t }; })()`;
const flingJump = (n) => `new Promise((resolve) => {
  const target = document.getElementById("p${n}").getBoundingClientRect().top + scrollY;
  const tScroll = ${epoch};
  const step = () => {
    const left = target - scrollY;
    if (left <= ${flingPx}) { scrollTo(0, target); return resolve({ tScroll, tArrive: ${epoch} }); }
    scrollBy(0, ${flingPx});
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})`;

async function main() {
  const variants = lazyArg === "both" ? [true, false] : [lazyArg !== "off"];
  const chromePath = installChrome();
  const mirror = await startServer(SERVE_PORT, {});
  const all = [];
  try {
    for (const lazy of variants) all.push(await variant(chromePath, lazy));
  } finally {
    mirror.close();
  }
  writeFileSync(join(OUT, "report.json"), JSON.stringify(all, null, 2));
  writeFileSync(join(OUT, "report.md"), all.map(markdown).join("\n"));
  console.log(`\nreport: ${join(OUT, "report.md")}`);
}

async function variant(chromePath, lazy) {
  const name = lazy ? "lazy" : "eager";
  console.log(`\n=== ${name} images, ${pages} pages${fling ? ", fling" : ""}`);
  const chapter = await startChapter({ port: CHAPTER_PORT, pages, lazy, latencyMs, cache });
  const profile = mkdtempSync(join(tmpdir(), "anki-manga-perf-"));
  const extCopy = mkdtempSync(join(tmpdir(), "anki-manga-perf-ext-"));
  cpSync(EXTENSION, extCopy, { recursive: true, filter: (p) => !/\/(node_modules|test)(\/|$)/.test(p.slice(EXTENSION.length)) });
  const manifestFile = join(extCopy, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.host_permissions.push(`${READER}/*`); // same as clicking "Enable on this site", without a user gesture
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const chrome = launch(chromePath, [
    ...(headful ? [] : ["--headless=new"]),
    `--load-extension=${extCopy}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--enable-unsafe-webgpu",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "--lang=ja", `--window-size=${VIEW.w},${VIEW.h}`,
    `--host-resolver-rules=MAP reader.test:80 127.0.0.1:${CHAPTER_PORT}`,
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank",
  ]);
  const base = `http://127.0.0.1:${PORT}`;
  let sw, off, tab;
  const result = { variant: name, pages, latencyMs, cache, fling, headful, hover: hoverFirst, engine: null, runs: [] };
  try {
    sw = await waitFor(async () => {
      for (const t of (await (await fetch(`${base}/json/list`)).json()).filter((t) => t.type === "service_worker")) {
        const cdp = await Cdp.open(t.webSocketDebuggerUrl);
        if ((await cdp.evaluate("chrome.runtime.getManifest().name").catch(() => null)) === OUR_NAME) return cdp;
        cdp.close();
      }
    }, "the extension service worker");
    await waitFor(() => sw.evaluate('typeof handlers === "object"'), "background.js");
    // prefetch mode regardless of the benchmark (the owner's reported case); models from the local mirror (SHA-256 still checked)
    await sw.evaluate(`chrome.storage.local.set({devModelBase: "http://127.0.0.1:${SERVE_PORT}/models/", settings: {perfMode: "prefetch"}})`);
    await sw.evaluate("chrome.sidePanel.open = async () => {}");
    await sw.evaluate(`handlers["am:enable-site"]({origin: ${JSON.stringify(READER)}}, {})`);
    await sw.evaluate("ensureOffscreen()");
    const status = await waitFor(async () => {
      const st = await sw.evaluate('chrome.storage.session.get("modelStatus").then((r) => r.modelStatus || null)');
      return st && (st.state === "ready" || st.state === "error") ? st : null;
    }, "the engine", 300000);
    const bench = await sw.evaluate('chrome.storage.local.get("benchmark").then((r) => r.benchmark || null)');
    result.engine = { state: status.state, ep: status.ep || null, mode: status.mode || null, benchmark: bench, userAgent: await sw.evaluate("navigator.userAgent") };
    console.log(`engine: ${status.state} ep=${status.ep} mode=${status.mode}${bench ? ` benchmark=${JSON.stringify(bench)}` : ""}`);
    if (status.state !== "ready") throw new Error(`engine ${status.state}: ${status.error}`);

    const offT = await waitFor(async () => (await (await fetch(`${base}/json/list`)).json()).find((t) => t.url.includes("/offscreen/offscreen.html")), "the offscreen document");
    off = await Cdp.open(offT.webSocketDebuggerUrl);
    const extOrigin = `chrome-extension://${new URL(offT.url).host}`;

    // The service worker logs every change of the panel summary.
    await sw.evaluate(`globalThis.__panelLog = [];
      chrome.storage.onChanged.addListener((ch, area) => { if (area === "session" && ch.pageStatus) globalThis.__panelLog.push({ t: ${epoch}, v: ch.pageStatus.newValue }); });`);

    const v = await (await fetch(`${base}/json/version`)).json();
    const b = await Cdp.open(v.webSocketDebuggerUrl);
    const { targetId } = await b.send("Target.createTarget", { url: "about:blank", newWindow: true, width: VIEW.w, height: VIEW.h });
    b.close();
    const t = (await (await fetch(`${base}/json/list`)).json()).find((x) => x.id === targetId);
    tab = await Cdp.open(t.webSocketDebuggerUrl);
    await tab.send("Page.enable");
    await tab.send("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false });
    // The content script's isolated world: switch the trace on in it as soon as it exists.
    let world = null;
    tab.on("Runtime.executionContextCreated", ({ context: c }) => {
      if (c.origin !== extOrigin) return;
      world = c.id;
      tab.send("Runtime.evaluate", { contextId: c.id, expression: "globalThis.__amTrace = globalThis.__amTrace || []" }).catch(() => {});
    });
    await tab.send("Runtime.enable");
    const inWorld = async (expression) => {
      const r = await tab.send("Runtime.evaluate", { contextId: world, expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    for (const run of ["cold", "revisit"]) {
      console.log(`\n-- ${run}`);
      world = null;
      await off.evaluate("globalThis.__amTrace = []");
      await sw.evaluate("globalThis.__panelLog = []");
      chapter.requests.length = 0;
      const t0 = Date.now();
      if (run === "cold") await tab.send("Page.navigate", { url: `${READER}/chapter` });
      else {
        await tab.evaluate("scrollTo(0, 0)"); // a reload would restore the scroll position, and the jumps would start on a processed page
        await sleep(500);
        await tab.send("Page.reload");
      }
      await waitFor(() => tab.evaluate("document.readyState === 'complete'"), "page load", 60000);
      await waitFor(() => world !== null, "the content script");
      await sleep(topWait);

      const rec = { run, jumps: [], loadMs: Date.now() - t0 };
      for (const page of jumps) {
        await tab.evaluate(watchScript(page));
        const { tScroll, tArrive } = await tab.evaluate(fling ? flingJump(page) : instantJump(page));
        const key = keyOf(page);
        let hover = null;
        const hovering = hoverFirst && (async () => {
          const end = Date.now() + DONE_TIMEOUT;
          for (let b; Date.now() < end; await sleep(25)) {
            if (!(b = await tab.evaluate("window.__perfBubble"))) continue;
            const t = await tab.evaluate(epoch);
            await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
            return (hover = { t, bubbleId: b.id });
          }
        })();
        const done = await waitFor(() => inWorld(`(() => {
          const L = globalThis.__amTrace || [];
          return L.some((m) => m.name === "badge" && m.key === ${JSON.stringify(key)} && m.phase === "ocr" && m.done >= m.total && m.t >= ${tScroll} - 5);
        })()`), `page ${page} to finish`, DONE_TIMEOUT).catch(() => false);
        await hovering;
        // let the panel summary and the last relays arrive
        await sleep(1500);
        if (hoverFirst) await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
        const clickableAt = await tab.evaluate("window.__perfClickable");
        const content = JSON.parse(await inWorld("JSON.stringify(globalThis.__amTrace || [])"));
        const offscreen = JSON.parse(await off.evaluate("JSON.stringify(globalThis.__amTrace || [])"));
        const tabId = await sw.evaluate(`chrome.tabs.query({url: "${READER}/*"}).then((x) => x[0] && x[0].id)`);
        const panelLog = JSON.parse(await sw.evaluate("JSON.stringify(globalThis.__panelLog)"));
        const panel = panelLog.map((p) => ({ t: p.t, v: p.v && p.v[tabId] })).filter((p) => p.v);
        const a = analyzeJump({ page, keyOf, tScroll, tArrive, content, offscreen, panel, clickableAt, hover });
        rec.jumps.push({ ...a, finished: !!done, tScroll, tArrive, clickableAt, hover, requestsServed: chapter.requests.length });
        rec.raw = { content, offscreen, panel };
        console.log(summaryLine(a, !!done));
        await sleep(dwell);
      }
      rec.requests = chapter.requests.map((r) => ({ ...r, t: r.t - t0 }));
      writeFileSync(join(OUT, `raw-${name}-${run}.json`), JSON.stringify(rec));
      delete rec.raw;
      result.runs.push(rec);
    }
  } finally {
    tab?.close();
    sw?.close();
    off?.close();
    chrome.kill();
    chapter.server.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
    rmSync(extCopy, { recursive: true, force: true });
  }
  return result;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
