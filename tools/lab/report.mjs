// The lab report: steps per site, the diff against the previous run of the same lane, and the markdown.
// A step is {ok: true | false | null (not reached), note?}.

export const STEPS = ["open", "found", "bubbles", "text", "furigana", "explanation", "dictionary", "card", "scroll"];

export const mark = (step) => (step?.ok === true ? "✓" : step?.ok === false ? "✗" : "–");

// Changes between two runs, per site present in both. A regression is a step that passed and now fails (✓ → ✗), or
// a site that now ends in an error (a timeout). ✓ → – is listed but is not one: the step did not apply this time
// (a line without kanji), or it was not reached because an earlier step went ✓ → ✗, which already counts.
export function diffRuns(prev, cur) {
  if (!prev) return [];
  const before = new Map(prev.sites.map((s) => [s.name, s]));
  const out = [];
  for (const s of cur.sites) {
    const p = before.get(s.name);
    if (!p) continue;
    if (!!p.error !== !!s.error) out.push({ site: s.name, step: "run", from: p.error ? "error" : "ok", to: s.error ? "error" : "ok", regression: !!s.error });
    for (const step of STEPS) {
      const from = mark(p.steps?.[step]);
      const to = mark(s.steps?.[step]);
      if (from !== to) out.push({ site: s.name, step, from, to, regression: from === "✓" && to === "✗" });
    }
  }
  return out;
}

export const regressed = (diff) => diff.some((d) => d.regression);

// ---- profile state: runs are only comparable in the same one ("fresh" profile, or "kept-reset": kept, with the
// sites' storage cleared before each site; runs from before this field are "unknown").
const LABELS = { fresh: "fresh", "kept-reset": "kept, site data reset" };
export const profileLabel = (state) => LABELS[state] || "unknown";
export const stateOf = (report) => report?.profile?.state || "unknown";

// latest = {report, byState: {state: path}} (or the old {report}). The last run in this state; else the last run of
// any state with fallback: true. `exists` lets the caller skip reports that were deleted.
export function pickPrevious(latest, state, exists = () => true) {
  const same = latest?.byState?.[state];
  if (same && exists(same)) return { file: same, fallback: false };
  if (latest?.report && exists(latest.report)) return { file: latest.report, fallback: true };
  return null;
}

export const updateLatest = (latest, file, state) => ({ report: file, byState: { ...latest?.byState, [state]: file } });

export const stateWarning = (cur, prev) =>
  cur === prev ? null : `Profile state differs: previous run ${profileLabel(prev)}, this run ${profileLabel(cur)}. Steps and timings may differ for that reason.`;

const secs = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

// opts: {prevStamp, prevState} of the run compared with; state of this run (default: from run.profile).
export function renderMarkdown(run, diff, opts = {}) {
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
  if (opts.prevStamp) {
    const warning = stateWarning(opts.state ?? stateOf(run), opts.prevState ?? "unknown");
    if (warning) lines.push(warning, "");
    lines.push(`Compared with the run ${opts.prevStamp} (profile: ${profileLabel(opts.prevState)}).`, "");
  }
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
