#!/usr/bin/env node
// End-to-end harness: launches Chrome for Testing with the unpacked extension and drives its
// service worker over CDP.   node tools/e2e/run.mjs [--probe | --smoke | --first-run]
//   --smoke  end to end: serves the sample pages (ANKI_MANGA_SAMPLES) and the mirrored models (tools/.cache/mirror)
//            on 127.0.0.1:47900, loads the first page in a tab and waits for the overlay to show its texts
//   --first-run  start-up timings: serves the mirrored models (no samples needed), boots the engine on an empty
//            profile (cold), restarts Chrome on the same profile (warm) and prints each stage of both starts
//   --probe  platform probe: offscreen document, WebGPU session, cross-origin fetch, AnkiConnect
//            (the AnkiConnect probe runs only when ANKI_RUNNING=1)
import { FREE_URL } from "../../extension/lib/llm.js";
import { port } from "../ports.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, createReadStream, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { makeBenchmarkPage } from "../../extension/engine/benchmark.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = join(ROOT, "tools/e2e/.cache");
const EXTENSION = join(ROOT, "extension");
const PORT = port(9333);
const SERVE_PORT = port(47900);
const MIRROR = join(ROOT, "tools/.cache/mirror");
const PROBE_FETCH_URL = "https://github.com/microsoft/onnxruntime/releases/download/v1.20.1/onnxruntime-linux-aarch64-1.20.1.tgz";

const OUR_NAME = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).name;
const mode = process.argv.includes("--smoke") ? "smoke" : process.argv.includes("--first-run") ? "first-run" : "probe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installChrome() {
  mkdirSync(CACHE, { recursive: true });
  const out = execFileSync("npx", ["--yes", "@puppeteer/browsers", "install", "chrome@stable", "--path", CACHE], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  // Last line: "chrome@<version> <path to binary>"
  const line = out.trim().split("\n").pop();
  const path = line.slice(line.indexOf(" ") + 1).trim();
  if (!existsSync(path)) throw new Error(`Chrome binary not found from installer output: ${line}`);
  return path;
}

async function waitFor(fn, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method) this.handlers.get(m.method)?.(m.params);
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error(`cannot open ${url}`)));
    });
  }
  on(method, fn) {
    this.handlers.set(method, fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

// Chrome ships its own component extensions with service workers; pick ours by manifest name.
async function connectServiceWorker() {
  return waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of targets.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      const cdp = await Cdp.open(t.webSocketDebuggerUrl);
      const name = await cdp.evaluate("chrome.runtime.getManifest().name").catch(() => null);
      if (name === OUR_NAME) return cdp;
      cdp.close();
    }
  }, "the extension service worker");
}

async function probe(sw) {
  let failed = false;
  const report = (name, ok, text) => {
    console.log(`${name} ${ok ? "ok" : "FAIL"} ${text}`);
    if (!ok) failed = true;
  };
  const engine = (msg) => sw.evaluate(`engineCall(${JSON.stringify(msg)})`);

  // The worker target appears before its module has finished evaluating.
  await waitFor(() => sw.evaluate('typeof ensureOffscreen === "function"'), "background.js to load");
  await sw.evaluate("ensureOffscreen()");
  console.log("offscreen ok");

  const gpu = await engine({ type: "eng:probe-webgpu" });
  report("webgpu", gpu.ok, gpu.ok ? `adapter=${gpu.adapter}` : gpu.error);

  const f = await engine({ type: "eng:probe-fetch", url: PROBE_FETCH_URL });
  report("fetch", f.ok, f.error || `${f.status} bytes=${f.bytes}`);

  if (process.env.ANKI_RUNNING === "1") {
    const a = await engine({ type: "eng:probe-anki" });
    report("anki", a.ok, a.error || String(a.result));
  } else {
    console.log("anki skipped (set ANKI_RUNNING=1 with Anki open)");
  }
  return !failed;
}

// Synthetic pages for timing the first real detects (the benchmark page at different JPEG qualities: different bytes,
// so none is served from the page cache). jpeg-js is a dev dependency of extension/.
function syntheticPages() {
  const jpeg = createRequire(join(EXTENSION, "package.json"))("jpeg-js");
  const page = makeBenchmarkPage();
  const rgba = { data: Buffer.from(page.data.buffer), width: page.width, height: page.height };
  const qualities = { "cold-a": 90, "cold-b": 85, "warm-a": 80, "warm-b": 75 }; // fresh bytes for each start
  return Object.fromEntries(Object.entries(qualities).map(([name, q]) => [`/synthetic-${name}.jpg`, jpeg.encode(rgba, q).data]));
}

// Serves one sample page (as /page.jpg inside a plain HTML page; none when image is null), the synthetic pages and
// the mirrored model files (/models/<name>).
function startServer(image) {
  const synthetic = syntheticPages();
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0]);
    if (image && path === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><body style="margin:0"><img src="/page.jpg" style="width:900px">');
    } else if (image && path === "/page.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      createReadStream(image).pipe(res);
    } else if (synthetic[path]) {
      res.setHeader("Content-Type", "image/jpeg");
      res.end(synthetic[path]);
    } else if (path.startsWith("/models/") && !path.includes("..") && existsSync(join(MIRROR, path.slice(8)))) {
      const file = join(MIRROR, path.slice(8));
      res.setHeader("Content-Length", statSync(file).size);
      createReadStream(file).pipe(res);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(SERVE_PORT, "127.0.0.1", () => resolve(server)));
}

// A stand-in for AnkiConnect (the real one is Anki's add-on): records the notes it is asked to add. It listens on
// its own port and the panel page is pointed at it, so a running Anki is never touched by the test.
const FAKE_ANKI_PORT = port(8766);
const FREE_TIER_HOST = new URL(FREE_URL).hostname;
const REAL_ANKI_PORT = 8765;
function startFakeAnki() {
  const notes = [];
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
        modelNames: ["Manga Mining (anki_manga)"],
        findNotes: [],
        notesInfo: [],
      };
      if (action === "addNote") notes.push(params.note);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: action === "addNote" ? 1 : (results[action] ?? null), error: null }));
    });
  });
  return new Promise((resolve) => {
    server.on("error", () => resolve(null));
    server.listen(FAKE_ANKI_PORT, "127.0.0.1", () => resolve({ server, notes }));
  });
}

// The side panel page itself: model status, a selected bubble (as the content script's click sends it), the free-tier
// message (the free server is not deployed, so "unavailable" is the expected answer), and a dictionary entry on a word click.
async function panelCheck(sw, ref) {
  const id = await sw.evaluate("chrome.runtime.id");
  // A tab is not the side panel: the service worker refuses "am:engine" from a tab sender, so here the page sends
  // the engine message straight to the offscreen document (the worker only forwards it).
  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const panel = await Cdp.open(created.webSocketDebuggerUrl);
  const anki = await startFakeAnki();
  let redirected = 0;
  let freeTierFaked = 0;
  if (!anki) throw new Error(`port ${FAKE_ANKI_PORT} is busy`);
  try {
    await panel.send("Page.enable");
    await panel.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `{ const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (m, ...rest) => send(m && m.type === "am:engine" ? { target: "offscreen", ...m.msg } : m, ...rest); }`,
    });
    // Fail-safe guard for the real AnkiConnect: every request of the panel page passes through here, and one aimed
    // at port 8765 (whatever the host spelling) goes to the fake instead; if that cannot be done it is failed.
    panel.on("Fetch.requestPaused", (ev) => {
      let target = null;
      try {
        const u = new URL(ev.request.url);
        if ((u.port || (u.protocol === "https:" ? "443" : "80")) === String(REAL_ANKI_PORT)) {
          target = new URL(ev.request.url);
          target.protocol = "http:";
          target.hostname = "127.0.0.1";
          target.port = String(FAKE_ANKI_PORT);
        }
      } catch {
        // an unparseable URL cannot be aimed at Anki; it is not network traffic of ours
      }
      // The real free-tier server is never called from the smoke (it would spend the owner's quota): it answers 503.
      const toFreeTier = (() => {
        try {
          return new URL(ev.request.url).hostname === FREE_TIER_HOST;
        } catch {
          return false;
        }
      })();
      const reply = toFreeTier
        ? panel.send("Fetch.fulfillRequest", {
            requestId: ev.requestId,
            responseCode: 503,
            responseHeaders: [{ name: "Content-Type", value: "application/json" }],
            body: Buffer.from(JSON.stringify({ error: "free_unavailable" })).toString("base64"),
          })
        : /:8765\b/.test(ev.request.url) && !target
          ? panel.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" })
          : panel.send("Fetch.continueRequest", { requestId: ev.requestId, ...(target && { url: target.href }) });
      if (toFreeTier) freeTierFaked++;
      reply.catch(() => {});
      if (target) redirected++;
    });
    await panel.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await panel.send("Page.navigate", { url: `chrome-extension://${id}/panel/panel.html` });
    const text = (sel) => panel.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`);
    await waitFor(async () => (await text("#status")).startsWith("Ready"), "the panel to show the model status", 20000);
    console.log(`panel status: ${await text("#status")}`);
    await sw.evaluate(`handlers["am:select"](${JSON.stringify({ type: "am:select", ...ref, pageUrl: "http://example.invalid/ch1", pageTitle: "Chapter 1" })}, {})`);
    await waitFor(async () => (await panel.evaluate('document.querySelectorAll(".entry .tok").length')) > 0, "the clickable sentence", 20000);
    await waitFor(async () => (await text(".entry .msg")) !== "", "the explanation answer", 20000);
    const msg = await text(".entry .msg");
    console.log(`panel message: ${msg}`);
    await panel.evaluate('document.querySelector(".entry .tok").click()');
    await waitFor(async () => (await panel.evaluate('document.querySelectorAll(".entry .dict-entry").length')) > 0, "the dictionary entry", 20000);
    console.log(`panel dictionary: ${(await text(".entry .dict-entry")).replace(/\s+/g, " ").slice(0, 120)}`);
    await panel.evaluate('document.querySelector(".entry .dict-entry button").click()');
    await waitFor(async () => (await panel.evaluate('document.querySelector(".entry .dict-entry button").textContent')) === "✓ added", "the card to be added", 20000);
    const note = anki.notes[0];
    const pic = note.picture?.[0];
    console.log(`panel card: deck=${note.deckName} Word=${note.fields.Word} Reading=${note.fields.Reading} picture=${pic?.filename} (${pic?.data.length} base64 chars)`);
    const cardOk = note.deckName === "manga mining" && !!note.fields.Word && /^anki_manga_[0-9a-f]{12}_\d+\.jpg$/.test(pic?.filename) && pic.data.length > 1000;
    console.log(`panel requests redirected from port ${REAL_ANKI_PORT} to the fake: ${redirected}`);
    console.log(`panel free-tier requests answered by the fake: ${freeTierFaked}`);
    return cardOk && redirected > 0 && freeTierFaked > 0 && msg.includes("free explanation service is unavailable");
  } finally {
    anki.server.close();
    panel.close();
  }
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// Creates the offscreen document and waits for modelStatus to settle; prints each status change on the way.
async function bootEngine(sw) {
  const t0 = Date.now();
  let lastLine = "";
  await waitFor(() => sw.evaluate('typeof ensureOffscreen === "function"'), "background.js to load");
  await sw.evaluate("ensureOffscreen()");
  const status = await waitFor(async () => {
    const s = await sw.evaluate('chrome.storage.session.get("modelStatus").then((r) => r.modelStatus || null)');
    const bytes = s && s.totalBytes ? ` ${mb(s.receivedBytes)}/${mb(s.totalBytes)}${s.etaSec != null ? ` eta ${Math.round(s.etaSec)}s` : ""}` : "";
    const line = s && `${s.state} ${Math.round((s.progress || 0) * 100)}%${bytes}${s.ep ? ` ep=${s.ep}` : ""}${s.firstRun ? " firstRun" : ""}`;
    if (line !== lastLine) console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s model status: ${(lastLine = line)}`);
    return s && (s.state === "ready" || s.state === "error") ? s : null; // waitFor swallows exceptions
  }, "the engine to become ready", 600000);
  if (status.state === "error") throw new Error(`engine failed to start: ${status.error}`);
  console.log(`engine ready in ${((Date.now() - t0) / 1000).toFixed(1)}s  ep=${status.ep} mode=${status.mode}`);
  return status;
}

// Stage names in start-up order (chrome.storage hands the keys back sorted, so the order is restored here).
const STAGE_ORDER = ["files", "probe", "create", "ready", "warmup", "benchmark", "total"];
const stagesOf = (timings) =>
  Object.keys(timings || {})
    .filter((k) => k !== "files")
    .sort((a, b) => STAGE_ORDER.indexOf(a.split("_")[0]) - STAGE_ORDER.indexOf(b.split("_")[0]) || a.localeCompare(b));

// The stage breakdown the engine reports with "ready" (engine/startup.js): stages, then one row per file.
function printTimings(status) {
  const t = status.timings;
  if (!t) return console.log("  (no timings in modelStatus)");
  for (const stage of stagesOf(t)) console.log(`  ${stage.padEnd(18)} ${secs(t[stage]).padStart(8)}`);
  for (const f of t.files) {
    const parts = f.source === "cache" ? `read ${secs(f.readMs)}, hash ${secs(f.hashMs)}` : `download ${secs(f.downloadMs)}, hash ${secs(f.hashMs)}, cache write ${secs(f.putMs)}`;
    console.log(`  ${f.source.padEnd(7)} ${f.name.padEnd(34)} ${mb(f.bytes).padStart(9)}  ${parts}`);
  }
}

// Cold start (empty profile, models from the local mirror) and warm start (same profile after a browser restart).
// Network time from the real model host is not part of this: the mirror is on 127.0.0.1.
async function firstRun(launch) {
  const server = await startServer(null);
  try {
    const runs = [];
    for (const kind of ["cold", "warm"]) {
      const { sw, stop } = await launch();
      try {
        await waitFor(() => sw.evaluate('typeof handlers === "object"'), "background.js to load");
        await sw.evaluate(`chrome.storage.local.set({devModelBase: ${JSON.stringify(`http://127.0.0.1:${SERVE_PORT}/models/`)}})`);
        console.log(`--- ${kind} start`);
        await bootEngine(sw);
        // "ready" comes before the warm-up: how long does a page asked for right then take, and the next one?
        const origin = `http://127.0.0.1:${SERVE_PORT}`;
        await sw.evaluate(`handlers["am:enable-site"]({origin: ${JSON.stringify(origin)}}, {})`);
        for (const name of ["a", "b"]) {
          const t = Date.now();
          const r = await sw.evaluate(`engineCall(${JSON.stringify({ type: "eng:page", source: { url: `${origin}/synthetic-${kind}-${name}.jpg` }, ocr: "none" })})`);
          console.log(`  ${name === "a" ? "first" : "second"} page after ready: ${secs(Date.now() - t)} (${r.ok ? `${r.page.bubbles.length} bubbles` : r.error})`);
        }
        const status = await waitFor(async () => {
          const s = await sw.evaluate('chrome.storage.session.get("modelStatus").then((r) => r.modelStatus || null)');
          return s && s.timings && s.timings.total != null ? s : null;
        }, "the engine to settle", 120000);
        console.log(`  settled: ep=${status.ep} mode=${status.mode}`);
        printTimings(status);
        runs.push([kind, status]);
      } finally {
        await stop();
      }
    }
    const stages = stagesOf(Object.assign({}, ...runs.map(([, s]) => s.timings)));
    console.log(`\n| stage | ${runs.map(([k, s]) => `${k} (${s.ep})`).join(" | ")} |\n|---|${runs.map(() => "---:|").join("")}`);
    for (const stage of stages) console.log(`| ${stage} | ${runs.map(([, s]) => (s.timings?.[stage] != null ? secs(s.timings[stage]) : "—")).join(" | ")} |`);
    return runs.every(([, s]) => s.state === "ready");
  } finally {
    server.close();
  }
}

async function smoke(sw) {
  const samples = process.env.ANKI_MANGA_SAMPLES;
  if (!samples) throw new Error("set ANKI_MANGA_SAMPLES to the folder with the sample pages and reference/*.json");
  const image = readdirSync(samples).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort()[0];
  if (!image) throw new Error(`no sample page in ${samples}`);
  const refFile = join(samples, "reference", `${image.replace(/\.[^.]+$/, "")}.json`);
  const reference = existsSync(refFile) ? JSON.parse(readFileSync(refFile, "utf8")) : null;
  const server = await startServer(join(samples, image));
  const origin = `http://127.0.0.1:${SERVE_PORT}`;
  let tab;
  try {
    await waitFor(() => sw.evaluate('typeof handlers === "object"'), "background.js to load");
    await sw.evaluate(`chrome.storage.local.set({devModelBase: ${JSON.stringify(`${origin}/models/`)}})`);
    // Force prefetch: the benchmark may pick on-demand OCR (e.g. software WebGPU in headless Chrome).
    await sw.evaluate('chrome.storage.local.set({settings: {perfMode: "prefetch"}})');
    await sw.evaluate(`handlers["am:enable-site"]({origin: ${JSON.stringify(origin)}}, {})`);

    // Content scripts do not retry "models_*" yet, so wait until the engine is ready before opening the page.
    const status = await bootEngine(sw);
    printTimings(status);

    const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${origin}/`, { method: "PUT" })).json();
    tab = await Cdp.open(created.webSocketDebuggerUrl);
    const t1 = Date.now();
    const snapshot = `JSON.stringify([...document.querySelectorAll(".am-bubble")].map((b) => [Number(b.dataset.amBubble), b.classList.contains("am-pending"), b.textContent]))`;
    await waitFor(async () => JSON.parse(await tab.evaluate(snapshot)).length > 0, "bubbles to appear", 120000);
    let bubbles;
    await waitFor(async () => {
      bubbles = JSON.parse(await tab.evaluate(snapshot));
      return bubbles.filter((b) => !b[1]).length >= Math.ceil(bubbles.length * 0.8);
    }, "80% of the bubbles to have text", 120000);
    const done = bubbles.filter((b) => !b[1]);
    console.log(`bubbles ${bubbles.length}, with text ${done.length}, in ${((Date.now() - t1) / 1000).toFixed(1)}s after the page opened`);
    const want = new Map((reference?.bubbles || []).map((b) => [b.id, b.text_greedy]));
    let same = 0;
    for (const [id, , text] of done) if (want.get(id) === text) same++;
    for (const [id, , text] of done.slice(0, 3)) console.log(`  #${id} ${JSON.stringify(text)}  reference ${JSON.stringify(want.get(id) ?? null)}`);
    if (reference) console.log(`matching the reference text_greedy: ${same}/${done.length}`);
    // Furigana and the panel picture for one bubble, asked the way the side panel will (through the service worker).
    const engine = (msg) => sw.evaluate(`engineCall(${JSON.stringify(msg)})`);
    const known = await engine({ type: "eng:page", source: { url: `${origin}/page.jpg` }, ocr: "none" });
    const target = known.ok && known.page.bubbles.find((b) => b.text);
    let extras = !!target;
    if (target) {
      const ref = { pageId: known.page.page_id, bubbleId: target.id };
      const bub = await engine({ type: "eng:bubble", ...ref });
      console.log(`eng:bubble #${target.id} ok=${bub.ok} tokens=${bub.tokens?.length} ${bub.rubyHtml ?? bub.error}`);
      const crop = await engine({ type: "eng:crop", ...ref });
      const bytes = crop.ok ? Buffer.from(crop.jpegBase64, "base64") : null;
      console.log(`eng:crop #${target.id} ok=${crop.ok} bytes=${bytes?.length ?? crop.error}`);
      extras = bub.ok && bub.tokens.length > 0 && bub.rubyHtml.length > 0 && !!bytes && bytes[0] === 0xff && bytes[1] === 0xd8;
      // Dictionary: the first token with an entry (the first lookup downloads and parses the dictionary).
      const t2 = Date.now();
      let found = null;
      for (const t of bub.tokens.filter((t) => t.pos !== "記号")) {
        const look = await engine({ type: "eng:lookup", surface: t.surface, lemma: t.lemma, reading: t.reading });
        if (!look.ok) {
          console.log(`eng:lookup ${t.surface} failed: ${look.error}`);
          break;
        }
        if (look.entries.length) {
          found = { token: t, entry: look.entries[0] };
          break;
        }
      }
      console.log(
        found
          ? `eng:lookup ${found.token.surface} (${found.token.lemma}) -> ${found.entry.kanji[0] ?? found.entry.kana[0]}: ${found.entry.senses[0].glosses[0]}  (${((Date.now() - t2) / 1000).toFixed(1)}s)`
          : "eng:lookup found no entry",
      );
      extras &&= !!found;
      extras &&= await panelCheck(sw, ref);
    } else console.log("eng:bubble / eng:crop not checked: no bubble with text");
    return extras && done.length >= Math.ceil(bubbles.length * 0.8) && (!reference || same >= Math.ceil(done.length * 0.8));
  } finally {
    tab?.close();
    server.close();
  }
}

// Starts Chrome for Testing with the unpacked extension on `profile`; stop() leaves the profile in place.
async function launchChrome(chromePath, profile) {
  const chrome = spawn(
    chromePath,
    [
      "--use-mock-keychain", // no macOS keychain prompt for a fresh profile (same flags as tools/demo/common.mjs launch())
      "--password-store=basic",
      "--headless=new",
      `--load-extension=${EXTENSION}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--enable-unsafe-webgpu",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((r) => chrome.once("exit", r));
  const stop = async () => {
    sw?.close();
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
  };
  let sw;
  try {
    sw = await connectServiceWorker();
  } catch (e) {
    await stop();
    throw e;
  }
  return { sw, stop };
}

async function main() {
  const chromePath = installChrome();
  const profile = mkdtempSync(join(tmpdir(), "anki-manga-e2e-"));
  try {
    if (mode === "first-run") return (await firstRun(() => launchChrome(chromePath, profile))) ? 0 : 1;
    const { sw, stop } = await launchChrome(chromePath, profile);
    try {
      if (mode === "smoke") return (await smoke(sw)) ? 0 : 1;
      return (await probe(sw)) ? 0 : 1;
    } finally {
      await stop();
    }
  } finally {
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`e2e failed: ${e.message}`);
    process.exit(1);
  },
);
