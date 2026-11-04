// Shared helpers for the store-asset scripts (same patterns as tools/e2e/run.mjs).
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, existsSync, createReadStream, statSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXTENSION = join(ROOT, "extension");
export const OUT = join(ROOT, "dist/store");
export const MIRROR = join(ROOT, "tools/.cache/mirror");
const CACHE = join(ROOT, "tools/e2e/.cache");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function installChrome() {
  mkdirSync(CACHE, { recursive: true });
  const out = execFileSync("npx", ["--yes", "@puppeteer/browsers", "install", "chrome@stable", "--path", CACHE], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = out.trim().split("\n").pop();
  const path = line.slice(line.indexOf(" ") + 1).trim();
  if (!existsSync(path)) throw new Error(`Chrome binary not found from installer output: ${line}`);
  return path;
}

export async function waitFor(fn, what, timeoutMs = 20000) {
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

export class Cdp {
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

// Static files: routes maps a URL path to {file, type}; /models/<name> serves the mirrored model files.
export function startServer(port, routes) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const route = routes[path];
    if (route) {
      res.setHeader("Content-Type", route.type);
      if (route.body !== undefined) res.end(route.body);
      else createReadStream(route.file).pipe(res);
    } else if (path.startsWith("/models/") && !path.includes("..") && existsSync(join(MIRROR, path.slice(8)))) {
      const file = join(MIRROR, path.slice(8));
      res.setHeader("Content-Length", statSync(file).size);
      createReadStream(file).pipe(res);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Every fresh profile would otherwise ask for the macOS keychain ("Chrome for Testing Safe Storage"): use a mock one.
export const launch = (chromePath, args) => spawn(chromePath, ["--use-mock-keychain", "--password-store=basic", ...args], { stdio: "ignore" });
export const readText = (p) => readFileSync(p, "utf8");
