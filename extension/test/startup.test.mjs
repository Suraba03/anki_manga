import test from "node:test";
import assert from "node:assert/strict";
import { startEngine } from "../engine/startup.js";

const file = (name) => ({ name, url: `https://m.example/${name}`, sha256: "0".repeat(64), bytes: 1 });
const set = (p) => ({ det: file(`${p}-det`), enc: file(`${p}-enc`), dec: file(`${p}-dec`), vocab: file(`${p}-vocab`) });
const sets = { webgpu: set("g"), wasm: set("w"), data: {} };

function harness({ hasGpu = true, failCreate = false, failBenchmarkOn = null, failWasm = false } = {}) {
  const log = { ensured: [], created: [], disposed: [], status: [] };
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
      onProgress(0.5);
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
  assert.deepEqual(log.status.at(-1), { state: "ready", progress: 1, ep: "webgpu", mode: "prefetch" });
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
  assert.deepEqual(log.status.at(-1), { state: "ready", progress: 1, ep: "wasm", mode: "prefetch" });
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
