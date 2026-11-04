// OCR queue (port of the helper's scheduler.py): bubbles in reading order, pages by rank (the page nearest the screen
// first; arrival order when no rank is given), hovered/clicked bubbles first. One bubble at a time: the ORT sessions
// are not re-entrant. A page far from the screen is not dropped: its bubbles run when nothing nearer is waiting.

import { mark } from "./trace.js";

const NORMAL = 10;
const URGENT = 0;
const HOVER_RANK = -1; // below every page rank (>= 0)

// runOcr(rgba, bubble) → Promise<string>. onText(pageId, bubbleId, text) is called for every finished bubble
// (the caller tells the tabs and, when `persist` is true, stores it). A rejected runOcr yields onText(..., "", false):
// the bubble counts as done for the tabs, but the empty text must not be cached as if OCR had found nothing.
// clear() drops the queue and the result of the job running at that moment.
//
// opts.pageRank(pageId) → number, lower = nearer the screen (read again at every pick).
// opts.slot(rank, run) → Promise: how the bubble is given its turn on the engine. The default runs it at once; the engine
// passes a place in its own priority queue (rank() is the rank of the best waiting bubble, read again at every pick of
// that queue). The bubble is chosen when run() is called, not when the place was taken, so a hover made meanwhile wins.
export class OcrScheduler {
  constructor(runOcr, onText, { pageRank = () => 0, slot = (rank, run) => run() } = {}) {
    this.runOcr = runOcr;
    this.onText = onText;
    this.pageRank = pageRank;
    this.slot = slot;
    this.jobs = new Map(); // `${pageId}:${bubbleId}` → {pageId, bubble, priority, seq}
    this.pages = new Map(); // pageId → rgba, dropped when the page has no jobs left
    this.seq = 0;
    this.generation = 0; // bumped by clear(): results of earlier generations are discarded
    this.running = null;
  }

  // bubbles: [{id, text, ...}]; those with a text (null/undefined means unknown) are skipped.
  enqueuePage(pageId, rgba, bubbles) {
    for (const bubble of [...bubbles].sort((a, b) => a.id - b.id)) {
      const key = `${pageId}:${bubble.id}`;
      if (bubble.text != null || this.jobs.has(key)) continue;
      this.pages.set(pageId, rgba);
      this.jobs.set(key, { pageId, bubble, priority: NORMAL, seq: this.seq++ });
      mark("bubble:queued", { pageId, bubbleId: bubble.id });
    }
    if (this.jobs.size && !this.running) this.running = this.drain();
  }

  prioritize(pageId, bubbleId) {
    const job = this.jobs.get(`${pageId}:${bubbleId}`);
    if (job && job.priority > URGENT) Object.assign(job, { priority: URGENT, seq: this.seq++ });
  }

  clear() {
    this.generation++;
    this.jobs.clear();
    this.pages.clear();
  }

  pending() {
    return this.jobs.size;
  }

  // Resolves when the queue is empty.
  async idle() {
    while (this.running) await this.running;
  }

  rankOf(job) {
    return job.priority === URGENT ? HOVER_RANK : this.pageRank(job.pageId);
  }

  next() {
    let best = null;
    let bestRank = 0;
    for (const job of this.jobs.values()) {
      const rank = this.rankOf(job);
      if (!best || rank < bestRank || (rank === bestRank && job.seq < best.seq)) {
        best = job;
        bestRank = rank;
      }
    }
    return best;
  }

  async drain() {
    // Let the caller's synchronous enqueue/prioritize calls land before the first job is picked.
    await Promise.resolve();
    try {
      while (this.jobs.size) {
        const rank = () => {
          const job = this.next();
          return job ? this.rankOf(job) : Infinity;
        };
        await this.slot(rank, () => this.runNext());
      }
    } catch {
      /* the engine went away: the jobs stay queued for the next enqueue */
    }
    this.running = null;
  }

  async runNext() {
    const job = this.next();
    if (!job) return;
    const { pageId, bubble } = job;
    const generation = this.generation;
    let text;
    let persist = true;
    try {
      mark("bubble:start", { pageId, bubbleId: bubble.id });
      text = await this.runOcr(this.pages.get(pageId), bubble);
      mark("bubble:end", { pageId, bubbleId: bubble.id });
    } catch {
      text = ""; // keep the queue alive; the bubble is done, but nothing is cached
      persist = false;
    }
    if (generation !== this.generation) return; // cleared meanwhile: the result belongs to a dropped state
    this.jobs.delete(`${pageId}:${bubble.id}`);
    if (![...this.jobs.values()].some((j) => j.pageId === pageId)) this.pages.delete(pageId);
    try {
      await this.onText(pageId, bubble.id, text, persist);
      mark("bubble:sunk", { pageId, bubbleId: bubble.id });
    } catch {
      /* a failing sink must not stop OCR */
    }
  }
}
