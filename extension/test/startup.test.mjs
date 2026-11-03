import test from "node:test";
import assert from "node:assert/strict";
import { startEngine } from "../engine/startup.js";

const file = (name) => ({ name, url: `https://m.example/${name}`, sha256: "0".repeat(64), bytes: 1 });
const set = (p) => ({ det: file(`${p}-det`), enc: file(`${p}-enc`), dec: file(`${p}-dec`), vocab: file(`${p}-vocab`) });
const sets = { webgpu: set("g"), wasm: set("w"), data: {} };

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function harness({ hasGpu = true, failCreate = false, failBenchmarkOn = null, failWasm = false, cached = false } = {}) {
  const log = { ensured: [], created: [], disposed: [], status: [], lines: [] };
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
      return { ep, id: log.created.length, dispose: async () => log.disposed.push(ep) };
    },
    runBenchmark: async (engine) => {
      if (engine.ep === failBenchmarkOn) throw new Error("detect failed");
      return { msPerPage: 1234, mode: "prefetch" };
    },
    benchmarkPage: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    onStatus: (s) => log.status.push(s),
    now: () => (t += 10),
    log: (line) => log.lines.push(line),
  };
  return { deps, log, sessions };
}

test("with WebGPU: ensures only the webgpu set, benchmarks once, reports ready", async () => {
  const { deps, log } = harness();
  const r = await startEngine(deps);
  assert.equal(r.ep, "webgpu");
  assert.equal(r.engine.ep, "webgpu");
  assert.deepEqual(r.benchmark, { msPerPage: 1234, mode: "prefetch" });
  assert.deepEqual(log.ensured, ["g"]);
  assert.deepEqual(log.created, [{ ep: "webgpu", det: "g-det" }]);
  assert.equal(log.status[0].state, "downloading");
  assert.deepEqual(pick(log.status.at(-1), ["state", "progress", "ep", "mode"]), { state: "ready", progress: 1, ep: "webgpu", mode: "prefetch" });
});

test("without a GPU: wasm set only", async () => {
  const { deps, log } = harness({ hasGpu: false });
  const r = await startEngine(deps);
  assert.equal(r.ep, "wasm");
  assert.deepEqual(log.ensured, ["w"]);
});

test("webgpu createEngine rejects: falls back to the wasm set and records ep wasm", async () => {
  const { deps, log } = harness({ failCreate: true });
  const r = await startEngine(deps);
  assert.equal(r.ep, "wasm");
  assert.equal(r.engine.ep, "wasm");
  assert.deepEqual(log.ensured, ["g", "w"]);
  assert.deepEqual(log.created.map((c) => [c.ep, c.det]), [["webgpu", "g-det"], ["wasm", "w-det"]]);
  assert.deepEqual(pick(log.status.at(-1), ["state", "progress", "ep", "mode"]), { state: "ready", progress: 1, ep: "wasm", mode: "prefetch" });
});

test("the first detect on webgpu throws: the engine is disposed and wasm takes over", async () => {
  const { deps, log } = harness({ failBenchmarkOn: "webgpu" });
  const r = await startEngine(deps);
  assert.equal(r.ep, "wasm");
  assert.deepEqual(log.disposed, ["webgpu"]);
  assert.deepEqual(log.ensured, ["g", "w"]);
  assert.equal(log.status.at(-1).ep, "wasm");
});

test("a failure on the wasm backend is not retried and propagates", async () => {
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

test("the first status of a (re)start clears the previous run's bytes, flags and timings", async () => {
  const { deps, log } = harness();
  await startEngine(deps);
  const first = log.status[0];
  assert.equal(first.state, "downloading");
  for (const k of ["receivedBytes", "totalBytes", "etaSec", "firstRun", "timings"]) {
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

test("ready carries stage timings and the per-file records; one summary line is logged", async () => {
  const { deps, log } = harness();
  await startEngine(deps);
  const { timings } = log.status.at(-1);
  for (const k of ["files_webgpu", "probe_webgpu", "create_webgpu", "benchmark_webgpu", "total"]) {
    assert.ok(timings[k] > 0, `${k}: ${timings[k]}`);
  }
  assert.ok(timings.total >= timings.files_webgpu + timings.create_webgpu + timings.benchmark_webgpu);
  assert.deepEqual(timings.files.map((f) => [f.name, f.source]), [["g-det", "network"]]);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /engine ready in [\d.]+ s \(webgpu\)/);
  assert.match(log.lines[0], /files_webgpu [\d.]+ s/);
});

test("a WebGPU fallback keeps the timings of both attempts", async () => {
  const { deps, log } = harness({ failCreate: true });
  await startEngine(deps);
  const { timings } = log.status.at(-1);
  assert.ok(timings.files_webgpu > 0 && timings.create_webgpu > 0 && timings.files_wasm > 0 && timings.create_wasm > 0);
  assert.deepEqual(timings.files.map((f) => f.name), ["g-det", "w-det"]);
});
