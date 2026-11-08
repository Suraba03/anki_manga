// A priority gate: runs queued jobs `concurrency` at a time (1 for the ORT sessions, which are not re-entrant on
// WebGPU), always picking the job with the lowest rank. The rank is a function read again at every pick, so a page that
// was scrolled closer moves up without anyone touching the queue. A job may say it has become stale (its page left the
// zone): it is then rejected with Deferred before it starts.
// Trace marks (tools/perf): queue:queued / start / end / dropped, each with the job id and kind.
import { mark } from "./trace.js";

// One macrotask, without a timer: timers are throttled in hidden documents (the offscreen one), a message is not.
function nextTask() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== "function") return setTimeout(resolve, 0);
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

export class Deferred extends Error {
  constructor() {
    super("deferred");
    this.code = "deferred";
  }
}

// At equal rank: read, then detect (the page gets its bubbles), then OCR.
let nextId = 0; // across gates, so a trace can tell the jobs apart
const KIND_ORDER = { read: 0, detect: 1, ocr: 2 };

export class Gate {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = concurrency;
    this.queue = [];
    this.active = 0;
    this.scheduled = false;
  }

  // run() → Promise. Resolves or rejects with run()'s outcome (or rejects with Deferred).
  submit(kind, run, { rank = () => 0, stale = () => false } = {}) {
    const id = nextId++;
    mark("queue:queued", { id, kind, ahead: this.queue.length + this.active });
    return new Promise((resolve, reject) => {
      this.queue.push({ id, kind, run, rank, stale, resolve, reject });
      this.schedule();
    });
  }

  // Jobs submitted in the same tick are all queued before the first one is picked.
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  // Rejects the queued jobs that are stale now (the caller knows when priorities changed).
  sweep() {
    this.queue = this.queue.filter((job) => {
      if (!isStale(job)) return true;
      mark("queue:dropped", { id: job.id, kind: job.kind });
      job.reject(new Deferred());
      return false;
    });
  }

  pump() {
    while (this.active < this.concurrency) {
      this.sweep();
      const job = this.best();
      if (!job) return;
      this.queue.splice(this.queue.indexOf(job), 1);
      this.active++;
      this.start(job);
    }
  }

  best() {
    let best = null;
    let bestKey = null;
    for (const job of this.queue) {
      const key = [job.rank(), KIND_ORDER[job.kind] ?? 3, job.id];
      if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        best = job;
        bestKey = key;
      }
    }
    return best;
  }

  async start(job) {
    mark("queue:start", { id: job.id, kind: job.kind, rank: job.rank() });
    try {
      job.resolve(await job.run());
    } catch (e) {
      job.reject(e);
    } finally {
      this.active--;
      mark("queue:end", { id: job.id, kind: job.kind });
      // Not at once: whoever waited for this job may be about to submit the next one (the OCR scheduler takes a new turn per
      // bubble, a page enqueues its bubbles right after its detect), and that one must compete with what already waits.
      nextTask().then(() => this.pump());
    }
  }
}

function isStale(job) {
  try {
    return !!job.stale();
  } catch {
    return false;
  }
}
