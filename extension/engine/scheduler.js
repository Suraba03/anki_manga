// OCR queue (port of the helper's scheduler.py): bubbles in reading order, pages in arrival order,
// hovered/clicked bubbles first. One bubble at a time: the ORT sessions are not re-entrant.

import { mark } from "./trace.js";

const NORMAL = 10;
const URGENT = 0;

// runOcr(rgba, bubble) → Promise<string>. onText(pageId, bubbleId, text) is called for every finished bubble
// (the caller tells the tabs and, when `persist` is true, stores it). A rejected runOcr yields onText(..., "", false):
// the bubble counts as done for the tabs, but the empty text must not be cached as if OCR had found nothing.
// clear() drops the queue and the result of the job running at that moment.
export class OcrScheduler {
  constructor(runOcr, onText) {
    this.runOcr = runOcr;
    this.onText = onText;
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

  next() {
    let best = null;
    for (const job of this.jobs.values()) {
      if (!best || job.priority < best.priority || (job.priority === best.priority && job.seq < best.seq)) best = job;
    }
    return best;
  }

  async drain() {
    // Let the caller's synchronous enqueue/prioritize calls land before the first job is picked.
    await Promise.resolve();
    for (let job; (job = this.next()); ) {
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
      if (generation !== this.generation) continue; // cleared meanwhile: the result belongs to a dropped state
      this.jobs.delete(`${pageId}:${bubble.id}`);
      if (![...this.jobs.values()].some((j) => j.pageId === pageId)) this.pages.delete(pageId);
      try {
        await this.onText(pageId, bubble.id, text, persist);
        mark("bubble:sunk", { pageId, bubbleId: bubble.id });
      } catch {
        /* a failing sink must not stop OCR */
      }
    }
    this.running = null;
  }
}
