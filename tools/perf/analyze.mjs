// Turns the raw trace logs of one jump (content script, offscreen document, panel summary updates) into the numbers of
// the reading-speed report. Pure functions: tested in extension/test/perf-analyze.test.mjs.
//
// Marks (see extension/content/main.js, extension/engine/{trace,rank-gate,scheduler}.js, extension/offscreen/offscreen.js):
//   content:   observed, fetch:start, fetch:headers, fetch:data, send, reply, overlay, badge, text, report
//   offscreen: page:begin/read/hashed/lookup/detect-call/detected/image/reply, queue:queued/start/end/dropped (the
//              priority queues in front of the engine, jobs matched by id; kind read | detect | ocr),
//              bubble:queued/start/end/sunk (the OCR scheduler's per-bubble jobs)
// All timestamps are epoch milliseconds (performance.timeOrigin + performance.now()).

export const pageNumber = (key) => {
  const n = /\/p\/(\d+)\.png/.exec(key || "");
  return n ? Number(n[1]) : null;
};

const round = (x) => (x == null ? null : Math.round(x * 10) / 10);
const diff = (a, b) => (a == null || b == null ? null : round(b - a));
const first = (log, pred, from = -Infinity) => log.find((m) => m.t >= from && pred(m));

// A badge counts as ready when OCR is finished (also "no text").
const badgeDone = (m) => m.phase === "ocr" && m.done >= m.total;

// The priority queues in front of the engine (extension/engine/rank-gate.js) as a list of jobs, matched by id.
function queueJobs(offscreen) {
  const jobs = new Map();
  for (const m of offscreen) {
    if (!/^queue:/.test(m.name)) continue;
    const job = jobs.get(m.id) || { id: m.id, kind: m.kind, queued: null, ahead: null, start: null, end: null, dropped: null, mark: null };
    jobs.set(m.id, job);
    const what = m.name.slice(6);
    if (what === "queued") Object.assign(job, { queued: m.t, ahead: m.ahead, mark: m });
    else job[what] = m.t;
  }
  return jobs;
}

// tScroll: when the jump started (marks are looked up from here); tArrive (a fling): when it stopped, which the
// numbers count from. Both default to the same instant.
export function analyzeJump({ page, keyOf, tScroll, tArrive = tScroll, content, offscreen, panel, clickableAt = null, hover = null }) {
  const key = keyOf(page);
  const mine = (name) => first(content, (m) => m.name === name && m.key === key, tScroll - 5);
  const observed = mine("observed");
  const fetchStart = mine("fetch:start");
  const fetchHeaders = mine("fetch:headers");
  const fetchData = mine("fetch:data");
  const send = mine("send");
  const reply = send && first(content, (m) => m.name === "reply" && m.key === key, send.t);
  const overlay = mine("overlay");
  const bubbles = overlay ? overlay.bubbles : null;

  // when each bubble of this page had its text: from the overlay (cached texts) or the content script's text mark
  const when = new Map((overlay ? overlay.known || [] : []).map((id) => [id, overlay.t]));
  if (overlay) for (const m of content) if (m.name === "text" && m.pageId === overlay.pageId && m.t >= overlay.t && !when.has(m.bubbleId)) when.set(m.bubbleId, m.t);
  const times = [...when.values()].sort((a, b) => a - b);
  const firstText = times.length ? times[0] : null;
  const allTexts = bubbles === 0 ? overlay.t : bubbles != null && times.length >= bubbles ? times[bubbles - 1] : null;

  // content side: requests sent and not yet answered when this page was requested
  const inFlightAtSend = send
    ? content.filter((m) => m.name === "send" && m.key !== key && m.t <= send.t &&
        !content.some((r) => r.name === "reply" && r.key === m.key && r.t >= m.t && r.t <= send.t)).length
    : null;

  // offscreen side: this page's request, its detect job, and what ran or waited ahead of it
  // The clocks of the two processes differ by a few ms, so: the same data URL length, nearest in time.
  const begin = send && offscreen.filter((m) => m.name === "page:begin" && m.len === send.len).sort((a, b) => Math.abs(a.t - send.t) - Math.abs(b.t - send.t))[0];
  const rid = begin && begin.rid;
  const step = (name) => (rid != null ? first(offscreen, (m) => m.name === `page:${name}` && m.rid === rid) : null);
  const lookup = step("lookup");
  const detectCall = step("detect-call");
  const queue = queueJobs(offscreen);
  // a job's queued mark comes right after the mark of the code that submitted it
  const jobAfter = (m) => {
    const next = m && offscreen[offscreen.indexOf(m) + 1];
    return next && next.name === "queue:queued" ? queue.get(next.id) : null;
  };
  const jobBefore = (job) => {
    const prev = job.mark && offscreen[offscreen.indexOf(job.mark) - 1];
    return prev || null;
  };
  const myJob = jobAfter(detectCall);
  const myRead = jobAfter(begin);
  const keyOfRid = (r) => {
    const b = offscreen.find((m) => m.name === "page:begin" && m.rid === r);
    const sent = b && content.find((m) => m.name === "send" && m.len === b.len);
    return sent ? sent.key : null;
  };
  // Jobs that ran while this one waited (they were running at its queued time, or started before its own start), and jobs
  // that were queued before it but started after it (the priority queue let it overtake them).
  const ranAhead = myJob && myJob.start != null
    ? [...queue.values()].filter((j) => j !== myJob && j.start != null && j.start < myJob.start && (j.end == null || j.end > myJob.queued))
    : [];
  const detectAhead = ranAhead.filter((j) => j.kind === "detect");
  const overtaken = myJob && myJob.start != null
    ? [...queue.values()].filter((j) => j !== myJob && j.kind === "detect" && j.queued < myJob.queued && (j.start == null || j.start > myJob.start))
    : [];
  const pagesOf = (jobs) =>
    jobs.map((j) => {
      const prev = jobBefore(j);
      return pageNumber(prev && prev.name === "page:detect-call" ? keyOfRid(prev.rid) : null);
    });

  const detected = step("detected");
  const imageDone = step("image");
  const pageReply = step("reply");

  // OCR of this page's bubbles: the wait in the OCR queue (queued -> start) and the run (start -> end)
  const ocr = overlay
    ? [...new Set(offscreen.filter((m) => m.name === "bubble:queued" && m.pageId === overlay.pageId).map((m) => m.bubbleId))].map((id) => {
        const f = (name) => first(offscreen, (m) => m.name === `bubble:${name}` && m.pageId === overlay.pageId && m.bubbleId === id);
        return { id, queued: f("queued"), start: f("start"), end: f("end") };
      })
    : [];
  const ocrRuns = ocr.map((o) => diff(o.start && o.start.t, o.end && o.end.t));

  const badges = content.filter((m) => m.name === "badge" && m.key === key && m.t >= tScroll - 5);
  const done = badges.find(badgeDone);
  let badge = { doneMs: null, afterAllTextsMs: null, reportMs: null, panelMs: null, panelAfterAllTextsMs: null };
  if (done) {
    const ready = new Map();
    for (const m of content) if (m.name === "badge" && m.key && m.t <= done.t) ready.set(m.key, m.phase ? badgeDone(m) : false);
    const readyCount = [...ready.values()].filter(Boolean).length;
    const report = first(content, (m) => m.name === "report", done.t);
    const seenByPanel = first(panel, (p) => p.v && p.v.ready >= readyCount, done.t);
    badge = {
      doneMs: diff(tArrive, done.t),
      afterAllTextsMs: allTexts ? diff(allTexts, done.t) : null,
      reportMs: diff(done.t, report && report.t),
      panelMs: diff(done.t, seenByPanel && seenByPanel.t),
      panelAfterAllTextsMs: allTexts && seenByPanel ? diff(allTexts, seenByPanel.t) : null,
    };
  }

  // the next two pages (prefetch still has to read them eventually)
  const neighboursMs = [1, 2].map((k) => {
    const b = first(content, (m) => m.name === "badge" && m.key === keyOf(page + k) && badgeDone(m), tScroll - 5);
    return b ? diff(tArrive, b.t) : null;
  });

  const cached = lookup ? lookup.cached : null;
  const detectMarks = myJob && !cached ? { queueWait: diff(myJob.queued, myJob.start), run: diff(myJob.start, myJob.end) } : { queueWait: null, run: null };
  const afterDetect = detectMarks.run != null && myJob.end != null ? myJob.end : null;
  const dropped = myJob && myJob.dropped != null;
  return {
    page,
    key,
    bubbles,
    cached,
    hoverTextMs: hover && when.has(hover.bubbleId) ? Math.max(0, diff(hover.t, when.get(hover.bubbleId))) : null,
    clickableMs: clickableAt == null ? null : diff(tArrive, clickableAt),
    overlayMs: diff(tArrive, overlay && overlay.t),
    firstTextMs: diff(tArrive, firstText),
    allTextsMs: diff(tArrive, allTexts),
    inFlightAtSend,
    detectsAhead: myJob ? detectAhead.length : null,
    ocrAhead: myJob ? ranAhead.length - detectAhead.length : null,
    detectAheadPages: myJob ? pagesOf(detectAhead) : null,
    detectsOvertaken: myJob ? overtaken.length : null,
    dropped,
    neighboursMs,
    breakdown: {
      scrollToObserved: diff(tArrive, observed && observed.t),
      observedToFetch: diff(observed && observed.t, fetchStart && fetchStart.t),
      fetch: diff(fetchStart && fetchStart.t, fetchHeaders && fetchHeaders.t),
      toDataUrl: diff(fetchHeaders && fetchHeaders.t, fetchData && fetchData.t),
      workerHop: diff(send && send.t, begin && begin.t),
      readQueueWait: myRead ? diff(myRead.queued, myRead.start) : null,
      read: diff(myRead && myRead.start != null ? myRead.start : begin && begin.t, step("read") && step("read").t),
      hash: diff(step("read") && step("read").t, step("hashed") && step("hashed").t),
      lookup: diff(step("hashed") && step("hashed").t, lookup && lookup.t),
      detectQueueWait: detectMarks.queueWait,
      detect: detectMarks.run,
      storePage: afterDetect != null && detected ? diff(afterDetect, detected.t) : null,
      storeImage: imageDone ? diff(detected && !cached ? detected.t : lookup && lookup.t, imageDone.t) : null,
      replyHop: diff(pageReply && pageReply.t, reply && reply.t),
      layout: diff(reply && reply.t, overlay && overlay.t),
      ocrQueueWaitFirst: ocr[0] ? diff(ocr[0].queued && ocr[0].queued.t, ocr[0].start && ocr[0].start.t) : null,
      ocrFirstBubble: ocrRuns.length ? ocrRuns[0] : null,
      ocrMsPerBubble: ocrRuns,
    },
    badge,
  };
}
