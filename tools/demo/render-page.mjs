#!/usr/bin/env node
// Renders tools/demo/page.html to dist/store/demo-page.png (880x1250) with headless Chrome.
//   node tools/demo/render-page.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, OUT, ROOT, installChrome, launch, startServer, waitFor, sleep } from "./common.mjs";
import { port } from "../ports.mjs";

const PORT = port(9334);
const SERVE_PORT = port(47901);
const W = 880, H = 1250;

mkdirSync(OUT, { recursive: true });
const server = await startServer(SERVE_PORT, { "/": { file: join(ROOT, "tools/demo/page.html"), type: "text/html; charset=utf-8" } });
const profile = mkdtempSync(join(tmpdir(), "anki-manga-demo-"));
const chrome = launch(installChrome(), ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"]);
try {
  const targets = await waitFor(async () => {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return t.find((x) => x.type === "page");
  }, "the browser");
  const cdp = await Cdp.open(targets.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${SERVE_PORT}/` });
  await waitFor(() => cdp.evaluate("!!window.__bubbles && document.fonts.status === 'loaded'"), "the page to draw");
  await sleep(300);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  writeFileSync(join(OUT, "demo-page.png"), Buffer.from(shot.data, "base64"));
  const bubbles = await cdp.evaluate("JSON.stringify(window.__bubbles)");
  writeFileSync(join(OUT, "demo-page-bubbles.json"), bubbles);
  console.log(`wrote ${join(OUT, "demo-page.png")}`);
  cdp.close();
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
