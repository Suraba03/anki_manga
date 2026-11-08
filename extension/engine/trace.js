// Opt-in timing marks for the reading-speed harness (tools/perf). Off unless the harness sets globalThis.__amTrace = []
// (over CDP, in this document): then every mark is appended with an epoch-millisecond timestamp, which is comparable
// across the content script, the offscreen document and the harness. Unset, a mark costs one property read.
let seq = 0;

export function mark(name, data) {
  const log = globalThis.__amTrace;
  if (log) log.push({ t: performance.timeOrigin + performance.now(), name, ...data });
}

// One request's marks share an id: const step = begin("page", {len}); step("read"); step("reply").
export function begin(name, data) {
  const rid = ++seq;
  mark(`${name}:begin`, { rid, ...data });
  return (step, more) => mark(`${name}:${step}`, { rid, ...more });
}
