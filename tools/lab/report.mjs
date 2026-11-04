// The lab report: steps per site, the diff against the previous run of the same lane, and the markdown.
// A step is {ok: true | false | null (not reached), note?}.

export const STEPS = ["open", "found", "bubbles", "text", "furigana", "explanation", "dictionary", "card", "scroll"];

export const mark = (step) => (step?.ok === true ? "✓" : step?.ok === false ? "✗" : "–");

// Changes between two runs, per site present in both. Losing a ✓ (to ✗ or to "not reached") is a regression.
export function diffRuns(prev, cur) {
  if (!prev) return [];
  const before = new Map(prev.sites.map((s) => [s.name, s]));
  const out = [];
  for (const s of cur.sites) {
    const p = before.get(s.name);
    if (!p) continue;
    for (const step of STEPS) {
      const from = mark(p.steps?.[step]);
      const to = mark(s.steps?.[step]);
      if (from !== to) out.push({ site: s.name, step, from, to, regression: from === "✓" });
    }
  }
  return out;
}

export const regressed = (diff) => diff.some((d) => d.regression);

const secs = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(run, diff) {
  const lines = [];
  lines.push(`# Lab run ${run.stamp} (lane ${run.lane})`, "");
  if (run.meta) lines.push(...Object.entries(run.meta).map(([k, v]) => `- ${k}: ${cell(v)}`), "");
  lines.push(`| site | ${STEPS.join(" | ")} | first bubble | first text |`, `|---|${STEPS.map(() => ":-:|").join("")}---:|---:|`);
  for (const s of run.sites) {
    lines.push(`| ${cell(s.name)} | ${STEPS.map((k) => mark(s.steps?.[k])).join(" | ")} | ${secs(s.timings?.firstBubbleMs)} | ${secs(s.timings?.firstTextMs)} |`);
  }
  lines.push("", "## Notes", "");
  for (const s of run.sites) {
    const notes = STEPS.filter((k) => s.steps?.[k]?.note).map((k) => `${k} ${mark(s.steps[k])}: ${cell(s.steps[k].note)}`);
    if (s.error) notes.unshift(`error: ${cell(s.error)}`);
    if (s.facts) notes.push(`page: ${cell(s.facts)}`);
    if (notes.length) lines.push(`- **${cell(s.name)}**`, ...notes.map((n) => `  - ${n}`));
  }
  lines.push("", "## Against the previous run", "");
  if (!diff.length) lines.push("No changes (or no previous run).");
  for (const d of diff) lines.push(`- ${d.site}: ${d.step} ${d.from}→${d.to}${d.regression ? " (regression)" : ""}`);
  return `${lines.join("\n")}\n`;
}

// Several clicks into one step: ✓ if every reached one passed, ✗ (with the first note) if any failed.
export function combine(list) {
  const reached = list.filter((s) => s && s.ok !== null);
  if (!reached.length) return list.find((s) => s?.note) || { ok: null };
  const failed = reached.filter((s) => !s.ok);
  if (!failed.length) return { ok: true, ...(reached.length < list.length && { note: `${reached.length}/${list.length} checked` }) };
  return { ok: false, note: `${failed.length}/${list.length}: ${failed[0].note}` };
}
