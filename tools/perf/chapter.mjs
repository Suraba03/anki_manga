// A long-chapter fixture for the reading-speed harness: N pages in one vertical scroll, every page its own PNG.
// The image is the project's own demo page (docs/demo/page.png); page i gets a tEXt chunk of 3*i filler bytes, so every
// page has different bytes (different page id) and a different length (the data URL length then identifies a page in
// the traces: base64 grows in steps of 3 bytes). Generated in memory, nothing is written to disk.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { ROOT } from "../demo/common.mjs";

export const PAGE_H = 860;
export const PAGE_W = 605;
export const GAP = 40;
const PNG_HEAD = 8 + 25; // signature + the IHDR chunk

export function distinctPng(base, i) {
  const data = Buffer.from(`Comment\0page ${i} ${"x".repeat(3 * i)}`, "latin1");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return Buffer.concat([base.subarray(0, PNG_HEAD), chunk, base.subarray(PNG_HEAD)]);
}

export function chapterHtml({ pages, lazy }) {
  const imgs = Array.from({ length: pages }, (_, i) =>
    `<img id="p${i}" src="/p/${i}.png" width="${PAGE_W}" height="${PAGE_H}" ${lazy ? 'loading="lazy" ' : ""}style="display:block">`).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>chapter</title>
<body style="margin:0;background:#2b2b2e;display:flex;flex-direction:column;align-items:center;gap:${GAP}px;padding:10px 0">
${imgs}`;
}

// Resolves {server, requests}: requests logs every page image request {t, page, ms} (when it arrived, how long it was held).
export async function startChapter({ port, pages = 200, lazy = true, latencyMs = 40, cache = true }) {
  const base = readFileSync(join(ROOT, "docs/demo/page.png"));
  const png = Array.from({ length: pages }, (_, i) => distinctPng(base, i));
  const html = chapterHtml({ pages, lazy });
  const requests = [];
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    const m = /^\/p\/(\d+)\.png$/.exec(path);
    if (path === "/chapter") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (!m || Number(m[1]) >= pages) {
      res.writeHead(404);
      return res.end();
    }
    const page = Number(m[1]);
    requests.push({ t: Date.now(), page, cors: !!req.headers.origin, dest: req.headers["sec-fetch-dest"] || null });
    setTimeout(() => {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png[page].length,
        "Cache-Control": cache ? "private, max-age=3600" : "no-store",
      });
      res.end(png[page]);
    }, latencyMs);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, requests, pageCount: pages, bytes: png.map((b) => b.length) };
}
