// Local reader fixtures: one page per technique real readers use to show manga pages, served on two fake hosts
// (reader.test = the site the user enables, cdn.test = a separate image host). Runs survey.mjs over them.
//
//   node tools/compat/fixtures.mjs [--grant-all] [--only=name,name]
//
// The page image is the project's own demo page (docs/demo/page.png, an original drawing).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../demo/common.mjs";
import { port } from "../ports.mjs";

const PORT = port(47950);
const PAGE = readFileSync(join(ROOT, "docs/demo/page.png"));
const READER = "http://reader.test";
const CDN = "http://cdn.test";
const H = 860; // displayed page height: fits the 900 px viewport

const shell = (body, script = "") => `<!doctype html><meta charset="utf-8"><title>fixture</title>
<body style="margin:0;background:#2b2b2e;display:flex;flex-direction:column;align-items:center;gap:40px;padding:10px 0">${body}
<script>${script}</script>`;
const img = (src, extra = "") => `<img src="${src}" style="height:${H}px;display:block" ${extra}>`;

// name → [description, html]
const PAGES = {
  plain: ["same-origin <img>", shell(img("/img/page.png"))],
  cdn: ["<img> from another host", shell(img(`${CDN}/img/page.png`))],
  referer: ["same-origin image that needs the page's Referer (hotlink protection)", shell(img("/guarded/page.png"))],
  "cdn-referer": ["CDN image that needs the page's Referer", shell(img(`${CDN}/guarded/page.png`))],
  cookie: ["same-origin image that needs the site's session cookie", shell(img("/private/page.png"))],
  "fetch-dest": ["image served only to image loads (an <img> sends Accept: image/…, a fetch() sends */*; Sec-Fetch-Dest is not sent over plain http)", shell(img("/dest/page.png"))],
  lazy: ["lazy <img data-src> with a placeholder", shell(`<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/page.png?lazy" class="lazy" style="height:${H}px;width:605px;display:block">`,
    `new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setTimeout(() => (e.target.src = e.target.dataset.src), 600); })).observe(document.querySelector(".lazy"));`)],
  srcset: ["<img srcset> (1x/2x)", shell(`<img src="/img/page.png?s=1" srcset="/img/page.png?s=1 1x, /img/page.png?s=2 2x" style="height:${H}px;display:block">`)],
  blob: ["<img> with a blob: URL", shell(`<img id="p" style="height:${H}px;display:block">`, `fetch("/img/page.png").then((r) => r.blob()).then((b) => (document.getElementById("p").src = URL.createObjectURL(b)));`)],
  "blob-cdn": ["<img> with a blob: URL of a CDN image", shell(`<img id="p" style="height:${H}px;display:block">`, `fetch("${CDN}/cors/page.png").then((r) => r.blob()).then((b) => (document.getElementById("p").src = URL.createObjectURL(b)));`)],
  canvas: ["page drawn on a <canvas>", shell(`<canvas id="c" width="880" height="1250" style="height:${H}px"></canvas>`, drawCanvas("/img/page.png"))],
  "canvas-tall": ["canvas taller than the window (fit-to-width reader)", shell(`<canvas id="c" width="880" height="1250" style="width:1000px"></canvas>`, drawCanvas("/img/page.png"))],
  tiles: ["canvas assembled from shuffled tiles", shell(`<canvas id="c" width="880" height="1250" style="height:${H}px"></canvas>`, drawTiles())],
  background: ["CSS background-image", shell(`<div style="width:605px;height:${H}px;background:url(/img/page.png) center/contain no-repeat"></div>`)],
  svg: ["<svg><image>", shell(`<svg width="605" height="${H}" viewBox="0 0 880 1250"><image href="/img/page.png" width="880" height="1250"/></svg>`)],
  "iframe-same": ["reader in a same-origin iframe", shell(`<iframe src="/inner" style="width:700px;height:${H + 20}px;border:0"></iframe>`)],
  "iframe-cdn": ["reader in an iframe from another host", shell(`<iframe src="${CDN}/inner" style="width:700px;height:${H + 20}px;border:0"></iframe>`)],
  shadow: ["<img> inside a shadow root", shell(`<manga-page></manga-page>`,
    `customElements.define("manga-page", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<img src="/img/page.png?shadow" style="height:${H}px;display:block">'; } });`)],
  swap: ["one <img> whose src the reader swaps to the next page", shell(img("/img/page.png?p=1", 'id="p"'), `setTimeout(() => (document.getElementById("p").src = "/img/page.png?p=2"), 9000);`)],
  "two-pages": ["two pages side by side", shell(`<div style="display:flex;gap:4px">${img("/img/page.png?l", 'style="height:700px"')}${img("/img/page.png?r", 'style="height:700px"')}</div>`)],
  scroll: ["a chapter of 6 pages in a long scroll", shell([1, 2, 3, 4, 5, 6].map((i) => img(`/img/page.png?n=${i}`, 'loading="lazy"')).join(""))],
};

function drawCanvas(src) {
  return `const i = new Image(); i.onload = () => document.getElementById("c").getContext("2d").drawImage(i, 0, 0); i.src = "${src}";`;
}
function drawTiles() {
  // The source is fetched whole here; real readers fetch a scrambled image and put the tiles back in place.
  return `const i = new Image(); i.onload = () => { const c = document.getElementById("c").getContext("2d"); const n = 4, w = 220, h = 312.5;
    const order = [...Array(n * n).keys()].sort((a, b) => ((a * 7) % 16) - ((b * 7) % 16));
    order.forEach((k, j) => { const sx = (k % n) * w, sy = Math.floor(k / n) * h, dx = (k % n) * w, dy = Math.floor(k / n) * h; c.drawImage(i, sx, sy, w, h, dx, dy, w, h); }); };
    i.src = "/img/page.png?tiles";`;
}

const server = createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  const path = req.url.split("?")[0];
  const send = (code, type, body, headers = {}) => { res.writeHead(code, { "Content-Type": type, ...headers }); res.end(body); };
  const png = (headers = {}) => send(200, "image/png", PAGE, { "Cache-Control": "no-store", ...headers });
  if (host === "reader.test" && path.startsWith("/f/")) {
    const page = PAGES[path.slice(3)];
    return page ? send(200, "text/html; charset=utf-8", page[1], { "Set-Cookie": "sess=ok; Path=/; SameSite=Lax" }) : send(404, "text/plain", "");
  }
  if (path === "/inner") return send(200, "text/html; charset=utf-8", shell(img("/img/page.png?inner")));
  if (path === "/img/page.png") return png();
  if (path === "/cors/page.png") return png({ "Access-Control-Allow-Origin": "*" });
  if (path === "/guarded/page.png") return (req.headers.referer || "").startsWith(READER) ? png() : send(403, "text/plain", "hotlink");
  if (path === "/private/page.png") return /(^|; )sess=ok/.test(req.headers.cookie || "") ? png() : send(403, "text/plain", "no session");
  if (path === "/dest/page.png") return /^image\//.test(req.headers.accept || "") ? png() : send(403, "text/plain", "not an image load");
  send(404, "text/plain", "");
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const dir = join(ROOT, "tools/.cache/compat");
mkdirSync(dir, { recursive: true });
const sitesFile = join(dir, "fixtures.json");
writeFileSync(sitesFile, JSON.stringify(Object.entries(PAGES).filter(([n]) => !only || only.includes(n)).map(([name, [what]]) => ({ name, what, url: `${READER}/f/${name}` })), null, 2));
// spawn, not spawnSync: the fixture server above runs in this process and must keep answering.
const child = spawn("node", [join(ROOT, "tools/compat/survey.mjs"), sitesFile, "--port-offset=20", "--out=fixtures", "--wait=short",
  `--resolve=MAP reader.test:80 127.0.0.1:${PORT}, MAP cdn.test:80 127.0.0.1:${PORT}`, ...args.filter((a) => a === "--grant-all" || a === "--headful")], { stdio: "inherit" });
child.on("exit", (code) => {
  server.close();
  process.exit(code ?? 1);
});
