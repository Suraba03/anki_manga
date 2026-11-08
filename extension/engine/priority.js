// Which page matters now. The content script reports, per page it is working on, how far the page is from the screen
// (d, in viewports, 0 = visible), a rank (p: d plus a small penalty behind the scroll direction) and a counter n that
// orders its reports. The queues (engine/rank-gate.js) read the rank of a job again at every pick.
import { Gate } from "./rank-gate.js";

export const FAR = 2; // viewports: beyond the 1.5 the content script prefetches, with a margin so the edge doesn't flap
export const MAX_READS = 3; // pages fetched and decoded at once
const MAX_ENTRIES = 2000;
const LIMIT = 1e6;
const MAX_ITEMS = 500; // one report; a content script is not trusted with more
const MAX_KEY = 2000; // a longer URL is not tracked
const MAX_AHEAD_MS = 60000; // n is a clock-based counter: a report claiming to be further ahead than this is clamped
export const UNKNOWN_RANK = FAR + 1; // a key the table does not know (never reported, or evicted): behind every page in the zone

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const keyOf = (url) => {
  const key = typeof url === "string" ? url.split("#")[0] : undefined;
  return key && key.length <= MAX_KEY ? key : undefined;
};

export class Priorities {
  constructor({ max = MAX_ENTRIES, now = Date.now } = {}) {
    this.max = max;
    this.now = now;
    this.byKey = new Map(); // page key -> {d, p, n}
    this.keyOfPage = new Map(); // page id -> page key
  }

  // force: the report that comes with a page request is the truth for that key at that moment, whatever n an earlier
  // report (an earlier tab, an earlier copy of the content script) left behind. Periodic reports only move forward.
  set(key, pr, { force = false } = {}) {
    key = keyOf(key);
    if (!key || !pr || !finite(pr.d) || !finite(pr.p) || !finite(pr.n)) return;
    const n = Math.min(pr.n, this.now() + MAX_AHEAD_MS);
    const had = this.byKey.get(key);
    if (!force && had && had.n > n) return;
    this.byKey.delete(key); // re-inserted last: the oldest go first when the map is trimmed
    this.byKey.set(key, { d: Math.min(Math.max(pr.d, 0), LIMIT), p: Math.min(Math.max(pr.p, 0), LIMIT), n });
    trim(this.byKey, this.max);
  }

  update(items) {
    if (!Array.isArray(items)) return;
    for (const it of items.slice(0, MAX_ITEMS)) if (it) this.set(it.key, it);
  }

  bind(pageId, key) {
    if (!pageId) return;
    this.keyOfPage.delete(pageId);
    this.keyOfPage.set(pageId, keyOf(key) ?? null); // null: no key (a screenshot of the screen), as good as visible
    trim(this.keyOfPage, this.max);
  }

  rankOfKey(key) {
    key = keyOf(key);
    if (!key) return 0;
    const pr = this.byKey.get(key);
    return pr ? pr.p : UNKNOWN_RANK;
  }

  rankOfPage(pageId) {
    return this.keyOfPage.has(pageId) ? this.rankOfKey(this.keyOfPage.get(pageId) ?? undefined) : UNKNOWN_RANK;
  }

  isFar(key) {
    const pr = this.byKey.get(keyOf(key));
    return !!pr && pr.d > FAR;
  }
}

function trim(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// The queues of the page pipeline, in front of the engine: reads (fetch + decode, a few at once) and compute (detect and
// OCR, one at a time, because the ORT sessions are not re-entrant). Both follow the same priorities. The engine's own
// serial chain behind them never holds more than the one job being run.
export function readingQueues() {
  const priorities = new Priorities();
  const reads = new Gate({ concurrency: MAX_READS });
  const compute = new Gate();
  return {
    priorities,
    reads,
    compute,
    // The OCR scheduler's turn in the compute queue (see OcrScheduler); the bubble is chosen when the turn comes.
    slot: (rank, run) => compute.submit("ocr", run, { rank }),
    // msg: an eng:page message. {rank, stale} for the queue jobs of this request.
    request(msg) {
      if (msg.key) priorities.set(msg.key, msg.priority, { force: true });
      return { rank: () => priorities.rankOfKey(msg.key), stale: () => priorities.isFar(msg.key) };
    },
    bind: (pageId, key) => priorities.bind(pageId, key),
    pageRank: (pageId) => priorities.rankOfPage(pageId),
    update(items) {
      priorities.update(items);
      reads.sweep();
      compute.sweep();
    },
  };
}
