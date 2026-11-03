// Smoothed time-left estimate for the model download. Feed it (receivedBytes, totalBytes) on every progress report;
// it answers seconds left, or null while there is too little to go on (the first second).
const WARMUP_MS = 1000;
const SAMPLE_MS = 500;
const ALPHA = 0.3; // weight of the newest rate sample

export function createEta({ now = () => performance.now() } = {}) {
  let start = null;
  let last = null; // {t, bytes} of the last rate sample
  let rate = null; // bytes per ms, exponentially smoothed
  return (received, total) => {
    const t = now();
    if (received >= total) return 0;
    if (start === null) {
      start = t;
      last = { t, bytes: received };
      return null;
    }
    if (t - last.t >= SAMPLE_MS) {
      const sample = (received - last.bytes) / (t - last.t);
      rate = rate === null ? sample : ALPHA * sample + (1 - ALPHA) * rate;
      last = { t, bytes: received };
    }
    if (t - start < WARMUP_MS || !(rate > 0)) return null;
    return (total - received) / rate / 1000;
  };
}
