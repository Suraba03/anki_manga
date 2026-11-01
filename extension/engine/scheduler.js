// OCR queue (port of the helper's scheduler.py): bubbles in reading order, pages in arrival order,
// hovered/clicked bubbles first. One bubble at a time: the ORT sessions are not re-entrant.

const NORMAL = 10;
const URGENT = 0;

// runOcr(rgba, bubble) → Promise<string>. onText(pageId, bubbleId, text) is called for every finished bubble
// (the caller stores it and tells the tabs); a rejected runOcr yields onText(..., "") so the bubble counts as done.
export class OcrScheduler {
  constructor(runOcr, onText) {
    this.runOcr = runOcr;
    this.onText = onText;
    this.jobs = new Map(); // `${pageId}:${bubbleId}` → {pageId, bubble, priority, seq}
    this.pages = new Map(); // pageId → rgba, dropped when the page has no jobs left
    this.seq = 0;
    this.running = null;
  }

  // bubbles: [{id, text, ...}]; those with a text (null/undefined means unknown) are skipped.
  enqueuePage(pageId, rgba, bubbles) {
    for (const bubble of [...bubbles].sort((a, b) => a.id - b.id)) {
      const key = `${pageId}:${bubble.id}`;
      if (bubble.text != null || this.jobs.has(key)) continue;
      this.pages.set(pageId, rgba);
      this.jobs.set(key, { pageId, bubble, priority: NORMAL, seq: this.seq++ });
    }
    if (this.jobs.size && !this.running) this.running = this.drain();
  }

  prioritize(pageId, bubbleId) {
    const job = this.jobs.get(`${pageId}:${bubbleId}`);
    if (job && job.priority > URGENT) Object.assign(job, { priority: URGENT, seq: this.seq++ });
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
      let text;
      try {
        text = await this.runOcr(this.pages.get(pageId), bubble);
      } catch {
        text = ""; // keep the queue alive; an empty text marks the bubble done
      }
      this.jobs.delete(`${pageId}:${bubble.id}`);
      if (![...this.jobs.values()].some((j) => j.pageId === pageId)) this.pages.delete(pageId);
      try {
        await this.onText(pageId, bubble.id, text);
      } catch {
        /* a failing sink must not stop OCR */
      }
    }
    this.running = null;
  }
}
