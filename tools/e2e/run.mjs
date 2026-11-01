#!/usr/bin/env node
// End-to-end harness: launches Chrome for Testing with the unpacked extension and drives its
// service worker over CDP.   node tools/e2e/run.mjs [--probe | --smoke]
//   --probe  platform probe: offscreen document, WebGPU session, cross-origin fetch, AnkiConnect
//            (the AnkiConnect probe runs only when ANKI_RUNNING=1)
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = join(ROOT, "tools/e2e/.cache");
const EXTENSION = join(ROOT, "extension");
const PORT = 9333;
const PROBE_FETCH_URL = "https://github.com/microsoft/onnxruntime/releases/download/v1.20.1/onnxruntime-linux-aarch64-1.20.1.tgz";

const OUR_NAME = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).name;
const mode = process.argv.includes("--smoke") ? "smoke" : "probe";
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
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
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

async function main() {
  const chromePath = installChrome();
  const profile = mkdtempSync(join(tmpdir(), "anki-manga-e2e-"));
  const chrome = spawn(
    chromePath,
    [
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
  let sw;
  try {
    sw = await connectServiceWorker();
    if (mode === "smoke") throw new Error("--smoke is not implemented yet (added with the OCR engine tasks)");
    return (await probe(sw)) ? 0 : 1;
  } finally {
    sw?.close();
    chrome.kill();
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
