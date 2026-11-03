import test from "node:test";
import assert from "node:assert/strict";
import { startEngine } from "../engine/startup.js";

const file = (name) => ({ name, url: `https://m.example/${name}`, sha256: "0".repeat(64), bytes: 1 });
const set = (p) => ({ det: file(`${p}-det`), enc: file(`${p}-enc`), dec: file(`${p}-dec`), vocab: file(`${p}-vocab`) });
const sets = { webgpu: set("g"), wasm: set("w"), data: {} };

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// A promise with its resolve/reject outside, to hold a stage open.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const KEY_G = `webgpu|${"0".repeat(64)}|${"0".repeat(64)}|${"0".repeat(64)}`;

function harness({ hasGpu = true, failCreate = false, failWarmupOn = null, failWasm = false, cached = false, saved = null, holdWarmup = null, holdMeasure = null } = {}) {
  const log = { ensured: [], created: [], disposed: [], status: [], lines: [], calls: [], warmups: [], measured: 0, saved: [] };
  let t = 0;
  const sessions = [];
  const ort = {
    env: { wasm: {} },
    InferenceSession: {
      create: async (bytes, opts) => {
        sessions.push(opts.executionProviders[0]);
        return { release: async () => {} };
      },
    },
  };
  const deps = {
    ort,
    hasGpu,
    sets,
    ensure: async (files, onProgress) => {
      log.ensured.push(files.det.name.split("-")[0]);
      const total = cached ? 0 : 400;
      const record = { name: files.det.name, source: cached ? "cache" : "network", bytes: 100 };
      onProgress(0, { receivedBytes: 0, totalBytes: total, files: [] });
      t += 2000;
      if (!cached) onProgress(0.5, { receivedBytes: 200, totalBytes: total, files: [] });
      t += 2000;
      onProgress(1, { receivedBytes: total, totalBytes: total, files: [record] });
      return new Map(Object.values(files).map((f) => [f.name, new TextEncoder().encode(f.name).buffer]));
    },
    chooseBackend: async ({ hasGpu, createSession }) => {
      if (!hasGpu) return "wasm";
      await createSession("webgpu");
      return "webgpu";
    },
    createEngine: async (_ort, ep, files) => {
      log.created.push({ ep, det: new TextDecoder().decode(files.det) });
      if ((ep === "webgpu" && failCreate) || (ep === "wasm" && failWasm)) throw new Error(`${ep} create failed`);
      return {
        ep,
        id: log.created.length,
        dispose: async () => log.disposed.push(ep),
        detect: async () => (log.calls.push([ep, "detect"]), [`${ep}-bubbles`]),
        ocr: async () => (log.calls.push([ep, "ocr"]), `${ep}-text`),
      };
    },
    warmUp: async (engine) => {
      log.warmups.push(engine.ep);
      if (holdWarmup && engine.ep === "webgpu") await holdWarmup.promise;
      t += 3000;
      if (engine.ep === failWarmupOn) throw new Error("detect failed");
    },
    measure: async () => {
      log.measured++;
      if (holdMeasure) await holdMeasure.promise;
      t += 1500;
      return { msPerPage: 1234, mode: "prefetch", warmupMs: 0, detectMs: 1000, ocrMs: 20 };
    },
    savedBenchmark: {
      get: async () => saved,
      set: async (b) => void log.saved.push(b),
    },
    benchmarkPage: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    onStatus: (s) => log.status.push(s),
    now: () => (t += 10),
    log: (line) => log.lines.push(line),
  };
  return { deps, log, sessions };
}

const lastReady = (log) => log.status.filter((s) => s.state === "ready").at(-1);

test("with WebGPU: ensures only the webgpu set, reports ready, then warms up and measures once in the background", async () => {
  const { deps, log } = harness();
  const r = await startEngine(deps);
  assert.equal(r.ep, "webgpu");
  assert.equal(r.engine.ep, "webgpu");
  assert.deepEqual(log.ensured, ["g"]);
  assert.deepEqual(log.created, [{ ep: "webgpu", det: "g-det" }]);
  assert.equal(log.status[0].state, "downloading");
  const settled = await r.settled;
  assert.deepEqual(settled.benchmark.mode, "prefetch");
  assert.deepEqual(log.warmups, ["webgpu"]);
  assert.equal(log.measured, 1);
  assert.deepEqual(pick(lastReady(log), ["state", "progress", "ep", "mode"]), { state: "ready", progress: 1, ep: "webgpu", mode: "prefetch" });
});

test("ready comes right after the sessions: the warm-up has not finished when startEngine resolves", async () => {
  const holdWarmup = deferred();
  const { deps, log } = harness({ holdWarmup });
  const r = await startEngine(deps);
  assert.equal(log.status.at(-1).state, "ready");
  assert.equal(log.status.at(-1).mode, undefined, "no measurement yet");
  assert.equal(log.measured, 0);
  let done = false;
  r.settled.then(() => (done = true));
  await new Promise((res) => setImmediate(res));
  assert.equal(done, false);
  holdWarmup.resolve();
  await r.settled;
  assert.equal(log.measured, 1);
});

test("real calls made during the warm-up wait for it and then run", async () => {
  const holdWarmup = deferred();
  const { deps, log } = harness({ holdWarmup });
  const r = await startEngine(deps);
  const page = r.engine.detect({});
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(log.calls, [], "nothing ran while the warm-up holds");
  holdWarmup.resolve();
  assert.deepEqual(await page, ["webgpu-bubbles"]);
});

test("real calls also wait for the speed measurement, so it times only its own inferences", async () => {
  const holdMeasure = deferred();
  const { deps, log } = harness({ holdMeasure });
  const r = await startEngine(deps);
  const page = r.engine.detect({});
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res));
  assert.equal(log.measured, 1, "measuring");
  assert.deepEqual(log.calls, [], "the real detect has not run");
  holdMeasure.resolve();
  assert.deepEqual(await page, ["webgpu-bubbles"]);
});

test("a webgpu failure during the measurement also switches to wasm", async () => {
  const { deps, log } = harness();
  deps.measure = async (engine) => {
    log.measured++;
    if (engine.ep === "webgpu") throw new Error("detect failed");
    return { msPerPage: 1234, mode: "prefetch" };
  };
  const r = await startEngine(deps);
  const settled = await r.settled;
  assert.equal(settled.ep, "wasm");
  assert.deepEqual(log.disposed, ["webgpu"]);
  assert.deepEqual(await r.engine.detect({}), ["wasm-bubbles"]);
});

test("a saved result for the same backend and models is reused: no measurement, mode known at ready", async () => {
  const saved = { msPerPage: 9000, mode: "on-demand", key: KEY_G };
  const { deps, log } = harness({ saved });
  const r = await startEngine(deps);
  assert.equal(log.status.at(-1).mode, "on-demand");
  assert.deepEqual(r.benchmark, saved);
  await r.settled;
  assert.equal(log.measured, 0);
  assert.deepEqual(log.saved, []);
  assert.deepEqual(log.warmups, ["webgpu"], "the warm-up still runs (it compiles the shaders and checks the backend)");
});

test("a saved result for other models or another backend is measured again and replaced", async () => {
  for (const saved of [
    { msPerPage: 9000, mode: "on-demand", key: KEY_G.replace(/0$/, "1") },
    { msPerPage: 9000, mode: "on-demand", key: KEY_G.replace("webgpu", "wasm") },
    { msPerPage: 9000, mode: "on-demand" },
  ]) {
    const { deps, log } = harness({ saved });
    const r = await startEngine(deps);
    assert.equal(log.status.at(-1).mode, undefined);
    await r.settled;
    assert.equal(log.measured, 1);
    assert.deepEqual(log.saved, [{ msPerPage: 1234, mode: "prefetch", key: KEY_G }]);
  }
});

test("without a GPU: wasm set only", async () => {
  const { deps, log } = harness({ hasGpu: false });
  const r = await startEngine(deps);
  assert.equal(r.ep, "wasm");
  assert.deepEqual(log.ensured, ["w"]);
  await r.settled;
  assert.equal(log.saved[0].key.split("|")[0], "wasm");
});

test("webgpu createEngine rejects: falls back to the wasm set before ready and records ep wasm", async () => {
  const { deps, log } = harness({ failCreate: true });
  const r = await startEngine(deps);
  assert.equal(r.ep, "wasm");
  assert.equal(r.engine.ep, "wasm");
  assert.deepEqual(log.ensured, ["g", "w"]);
  assert.deepEqual(log.created.map((c) => [c.ep, c.det]), [["webgpu", "g-det"], ["wasm", "w-det"]]);
  await r.settled;
  assert.deepEqual(pick(lastReady(log), ["state", "progress", "ep", "mode"]), { state: "ready", progress: 1, ep: "wasm", mode: "prefetch" });
});

test("the webgpu warm-up throws: the engine is disposed, wasm takes over behind the same engine object", async () => {
  const { deps, log } = harness({ failWarmupOn: "webgpu" });
  const r = await startEngine(deps);
  const page = r.engine.detect({}); // asked while the warm-up is still to fail
  const settled = await r.settled;
  assert.equal(settled.ep, "wasm");
  assert.equal(r.engine.ep, "wasm");
  assert.deepEqual(log.disposed, ["webgpu"]);
  assert.deepEqual(log.ensured, ["g", "w"]);
  assert.deepEqual(await page, ["wasm-bubbles"]);
  assert.equal(lastReady(log).ep, "wasm");
  assert.equal(log.saved[0].key.split("|")[0], "wasm");
});

test("a wasm warm-up failure ends in an error status; calls reject and settled reports it", async () => {
  const { deps, log } = harness({ hasGpu: false, failWarmupOn: "wasm" });
  const r = await startEngine(deps);
  const settled = await r.settled;
  assert.equal(settled.error, "engine_error");
  assert.deepEqual(pick(log.status.at(-1), ["state", "error"]), { state: "error", error: "engine_error" });
  await assert.rejects(r.engine.detect({}));
});

test("a failure creating the wasm engine is not retried and propagates", async () => {
  const { deps } = harness({ hasGpu: false, failWasm: true });
  await assert.rejects(startEngine(deps), /wasm create failed/);
});

test("a download failure on the webgpu set propagates (the model error is the user's problem, not a backend problem)", async () => {
  const { deps, log } = harness();
  deps.ensure = async () => {
    throw Object.assign(new Error("model_download_failed"), { error: "model_download_failed" });
  };
  await assert.rejects(startEngine(deps), (e) => e.error === "model_download_failed");
  assert.deepEqual(log.created, []);
});

test("download status carries bytes and, after the first second, a time-left estimate", async () => {
  const { deps, log } = harness();
  await startEngine(deps);
  const down = log.status.filter((s) => s.state === "downloading" && s.totalBytes);
  assert.deepEqual(pick(down[0], ["receivedBytes", "totalBytes", "etaSec"]), { receivedBytes: 0, totalBytes: 400, etaSec: null });
  const mid = down.find((s) => s.receivedBytes === 200);
  assert.ok(mid.etaSec > 0, `eta ${mid.etaSec}`);
});

test("the first status of a (re)start clears the previous run's bytes, flags, mode and timings", async () => {
  const { deps, log } = harness();
  await startEngine(deps);
  const first = log.status[0];
  assert.equal(first.state, "downloading");
  for (const k of ["receivedBytes", "totalBytes", "etaSec", "firstRun", "timings", "mode"]) {
    assert.ok(k in first && first[k] === undefined, `${k} is reset`);
  }
});

test("loading after a download is the first run; a warm start (nothing downloaded) is not", async () => {
  const cold = harness();
  await startEngine(cold.deps);
  assert.equal(cold.log.status.find((s) => s.state === "loading").firstRun, true);
  const warm = harness({ cached: true });
  await startEngine(warm.deps);
  assert.equal(warm.log.status.find((s) => s.state === "loading").firstRun, false);
});

test("timings: stages until ready, then warm-up and benchmark; one summary line once settled", async () => {
  const { deps, log } = harness();
  const r = await startEngine(deps);
  const atReady = log.status.at(-1).timings;
  for (const k of ["files_webgpu", "probe_webgpu", "create_webgpu", "ready"]) assert.ok(atReady[k] > 0, `${k}: ${atReady[k]}`);
  assert.equal(atReady.warmup_webgpu, undefined);
  assert.equal(log.lines.length, 0);
  await r.settled;
  const { timings } = lastReady(log);
  for (const k of ["warmup_webgpu", "benchmark_webgpu", "total"]) assert.ok(timings[k] > 0, `${k}: ${timings[k]}`);
  assert.ok(timings.total >= timings.ready + timings.warmup_webgpu + timings.benchmark_webgpu);
  assert.deepEqual(timings.files.map((f) => [f.name, f.source]), [["g-det", "network"]]);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /engine ready in [\d.]+ s \(webgpu\), settled in [\d.]+ s/);
  assert.match(log.lines[0], /files_webgpu [\d.]+ s/);
  assert.match(log.lines[0], /warmup_webgpu [\d.]+ s/);
});

test("a WebGPU fallback keeps the timings of both attempts", async () => {
  const { deps, log } = harness({ failCreate: true });
  const r = await startEngine(deps);
  await r.settled;
  const { timings } = lastReady(log);
  assert.ok(timings.files_webgpu > 0 && timings.create_webgpu > 0 && timings.files_wasm > 0 && timings.create_wasm > 0);
  assert.deepEqual(timings.files.map((f) => f.name), ["g-det", "w-det"]);
});
