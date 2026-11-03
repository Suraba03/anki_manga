#!/usr/bin/env node
// OCR check of dist/store/demo-page.png with the real extension engine, the way tools/e2e/run.mjs --smoke does it:
// the PNG is served on a local page, opened in Chrome for Testing with the unpacked extension, and the texts of the
// .am-bubble overlays are compared with the intended dialogue (dist/store/demo-page-bubbles.json, written by render-page.mjs).
//   node tools/demo/ocr-check.mjs
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, EXTENSION, OUT, installChrome, launch, startServer, waitFor, sleep } from "./common.mjs";

const PORT = 9335;
const SERVE_PORT = 47902;
const OUR_NAME = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).name;
const intended = JSON.parse(readFileSync(join(OUT, "demo-page-bubbles.json"), "utf8"));
const norm = (t) => t.replace(/[\s　]/g, "").replace(/\.\.\.|…+/g, "…").replace(/[!]/g, "！").replace(/[?]/g, "？");

const server = await startServer(SERVE_PORT, {
  "/": { type: "text/html", body: '<!doctype html><body style="margin:0"><img src="/page.png" style="width:880px;display:block">' },
  "/page.png": { type: "image/png", file: join(OUT, "demo-page.png") },
});
const origin = `http://127.0.0.1:${SERVE_PORT}`;
const profile = mkdtempSync(join(tmpdir(), "anki-manga-demo-"));
const chrome = launch(installChrome(), [
  "--headless=new", `--load-extension=${EXTENSION}`, "--disable-features=DisableLoadExtensionCommandLineSwitch",
  "--enable-unsafe-webgpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank",
]);
let sw, tab, ok = false;
try {
  sw = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of targets.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      const cdp = await Cdp.open(t.webSocketDebuggerUrl);
      if ((await cdp.evaluate("chrome.runtime.getManifest().name").catch(() => null)) === OUR_NAME) return cdp;
      cdp.close();
    }
  }, "the extension service worker");
  await waitFor(() => sw.evaluate('typeof handlers === "object"'), "background.js to load");
  await sw.evaluate(`chrome.storage.local.set({devModelBase: ${JSON.stringify(`${origin}/models/`)}})`);
  await sw.evaluate('chrome.storage.local.set({settings: {perfMode: "prefetch"}})');
  await sw.evaluate(`handlers["am:enable-site"]({origin: ${JSON.stringify(origin)}}, {})`);
  await sw.evaluate("ensureOffscreen()");
  const status = await waitFor(async () => {
    const s = await sw.evaluate('chrome.storage.session.get("modelStatus").then((r) => r.modelStatus || null)');
    return s && (s.state === "ready" || s.state === "error") ? s : null;
  }, "the engine to become ready", 300000);
  if (status.state === "error") throw new Error(`engine failed to start: ${status.error}`);
  console.log(`engine ready ep=${status.ep} mode=${status.mode}`);

  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${origin}/`, { method: "PUT" })).json();
  tab = await Cdp.open(created.webSocketDebuggerUrl);
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 880, height: 1250, deviceScaleFactor: 1, mobile: false });
  const snapshot = `JSON.stringify([...document.querySelectorAll(".am-bubble")].map((b) => { const r = b.getBoundingClientRect(); return {id: Number(b.dataset.amBubble), pending: b.classList.contains("am-pending"), text: b.textContent, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height}; }))`;
  await waitFor(async () => JSON.parse(await tab.evaluate(snapshot)).length > 0, "bubbles to appear", 120000);
  let found;
  await waitFor(async () => {
    found = JSON.parse(await tab.evaluate(snapshot));
    return found.length > 0 && found.every((b) => !b.pending);
  }, "all bubbles to have text", 120000).catch(() => {});
  found = JSON.parse(await tab.evaluate(snapshot));

  // Match each intended bubble to the detected overlay whose centre is nearest to it (inside the ellipse).
  const rows = intended.map((want, i) => {
    let best = null, bestD = Infinity;
    for (const f of found) {
      const dx = (f.x + f.w / 2 - want.cx) / want.rx, dy = (f.y + f.h / 2 - want.cy) / want.ry;
      const d = Math.hypot(dx, dy);
      if (d < bestD) (bestD = d), (best = f);
    }
    const hit = best && bestD < 1;
    const got = hit ? best.text : null;
    return { n: i + 1, want: want.text, detected: !!hit, got, exact: !!hit && norm(got) === norm(want.text) };
  });
  const extra = found.filter((f) => !rows.some((r) => r.detected && r.got === f.text)).map((f) => f.text);
  for (const r of rows) console.log(`${r.n} detected=${r.detected ? "yes" : "NO"} exact=${r.exact ? "yes" : "no"}\n   intended  ${r.want}\n   recognized ${r.got ?? "-"}`);
  console.log(`overlays: ${found.length}; not matched to an intended bubble: ${JSON.stringify(extra)}`);
  writeFileSync(join(OUT, "ocr-check.json"), JSON.stringify({ rows, extra }, null, 1));

  await tab.evaluate('document.documentElement.classList.add("am-show")');
  await sleep(400);
  const shot = await tab.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 880, height: 1250, scale: 1 } });
  writeFileSync(join(OUT, "ocr-check.png"), Buffer.from(shot.data, "base64"));
  console.log(`wrote ${join(OUT, "ocr-check.png")}`);
  ok = rows.every((r) => r.detected) && rows.filter((r) => r.exact).length >= 5;
  console.log(ok ? "PASS" : "FAIL (target: 6 detected, at least 5 exact)");
} finally {
  tab?.close();
  sw?.close();
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
