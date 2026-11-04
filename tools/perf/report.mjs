// Formats the results of tools/perf/run.mjs, and re-analyses saved raw logs:
//   node tools/perf/report.mjs <tools/.cache/perf/name>    (rewrites report.json and report.md from raw-*.json)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeJump } from "./analyze.mjs";

const READER = "http://reader.test";
const keyOf = (n) => `${READER}/p/${n}.png`;

const ms = (x) => (x == null ? "-" : `${Math.round(x)}`);
export function summaryLine(a, finished) {
  return `  page ${a.page}${finished ? "" : " (TIMED OUT)"}: clickable ${ms(a.clickableMs)} overlay ${ms(a.overlayMs)} first text ${ms(a.firstTextMs)} all texts ${ms(a.allTextsMs)} ms; ` +
    `in flight ${a.inFlightAtSend}, detects ahead ${a.detectsAhead} (pages ${JSON.stringify(a.detectAheadPages)})`;
}

export function markdown(r) {
  const e = r.engine || {};
  const out = [`## ${r.variant} images, ${r.pages} pages${r.fling ? ", fling" : ", instant jump"} (ep=${e.ep}, mode=${e.mode}, ${r.headful ? "headful" : "headless"}, server latency ${r.latencyMs} ms, HTTP cache ${r.cache ? "on" : "off"})\n`];
  for (const run of r.runs) {
    out.push(`### ${run.run}\n`, "| measure (ms from the jump) | " + run.jumps.map((j) => `page ${j.page}`).join(" | ") + " |", "|---|" + run.jumps.map(() => "---|").join(""));
    const row = (label, fn) => out.push(`| ${label} | ${run.jumps.map((j) => ms(fn(j)) ).join(" | ")} |`);
    const rowS = (label, fn) => out.push(`| ${label} | ${run.jumps.map((j) => fn(j) ?? "-").join(" | ")} |`);
    row("clickable bubble (DOM poll)", (j) => j.clickableMs);
    row("overlay attached", (j) => j.overlayMs);
    row("first OCR text", (j) => j.firstTextMs);
    if (r.hover) row("hover the first bubble -> its text", (j) => j.hoverTextMs);
    row("all texts", (j) => j.allTextsMs);
    rowS("bubbles", (j) => j.bubbles);
    rowS("finished in time", (j) => j.finished);
    rowS("pages in flight when requested (content)", (j) => j.inFlightAtSend);
    rowS("detects that ran while it waited", (j) => j.detectsAhead);
    rowS("OCR jobs that ran while it waited", (j) => j.ocrAhead);
    rowS("pages whose detect ran first", (j) => JSON.stringify(j.detectAheadPages));
    rowS("detects it overtook (queued earlier, started later)", (j) => j.detectsOvertaken);
    rowS("dropped as deferred", (j) => j.dropped);
    rowS("pages +1, +2 got all their texts after (ms)", (j) => (j.neighboursMs || []).map(ms).join(" / "));
    rowS("served from the cache (no detect)", (j) => j.cached);
    for (const k of Object.keys(run.jumps[0].breakdown).filter((k) => !Array.isArray(run.jumps[0].breakdown[k]))) row(`&nbsp;&nbsp;${k}`, (j) => j.breakdown[k]);
    rowS("&nbsp;&nbsp;ocr run per bubble (ms)", (j) => j.breakdown.ocrMsPerBubble.map(ms).join(" "));
    row("badge shows done", (j) => j.badge.doneMs);
    row("&nbsp;&nbsp;after the last text", (j) => j.badge.afterAllTextsMs);
    row("&nbsp;&nbsp;next report to the worker (after badge)", (j) => j.badge.reportMs);
    row("&nbsp;&nbsp;panel summary counts it (after badge)", (j) => j.badge.panelMs);
    row("&nbsp;&nbsp;panel summary counts it (after the last text)", (j) => j.badge.panelAfterAllTextsMs);
    out.push("");
  }
  return out.join("\n");
}

// Re-runs the analysis on raw-<variant>-<run>.json files (the logs were saved whole, so analyze.mjs can be fixed afterwards).
export function reanalyze(dir) {
  const results = [];
  for (const file of readdirSync(dir).filter((f) => /^raw-.*\.json$/.test(f)).sort()) {
    const rec = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const [, variant, run] = /^raw-(.*)-(cold|revisit)\.json$/.exec(file);
    let r = results.find((x) => x.variant === variant);
    if (!r) {
      const meta = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).find((x) => x.variant === variant) || {};
      r = { ...meta, runs: [] };
      results.push(r);
    }
    const { content, offscreen, panel } = rec.raw;
    const jumps = rec.jumps.map((j) => ({
      ...j,
      ...analyzeJump({ page: j.page, keyOf, tScroll: j.tScroll, tArrive: j.tArrive, content, offscreen, panel,
        clickableAt: j.clickableAt ?? (j.clickableMs == null ? null : j.tArrive + j.clickableMs), hover: j.hover ?? null }),
    }));
    r.runs.push({ ...rec, jumps, raw: undefined });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] || ".");
  const results = reanalyze(dir);
  writeFileSync(join(dir, "report.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(dir, "report.md"), results.map(markdown).join("\n"));
  console.log(`rewrote ${join(dir, "report.md")}`);
}
