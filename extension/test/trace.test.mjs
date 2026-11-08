import test from "node:test";
import assert from "node:assert/strict";
import { mark, begin } from "../engine/trace.js";

const withLog = async (fn) => {
  globalThis.__amTrace = [];
  try {
    await fn(globalThis.__amTrace);
  } finally {
    delete globalThis.__amTrace;
  }
};

test("mark: nothing happens, and nothing is created, unless the harness set globalThis.__amTrace", () => {
  assert.equal(globalThis.__amTrace, undefined);
  mark("x", { a: 1 });
  assert.equal(globalThis.__amTrace, undefined);
});

test("mark: appends {t, name, ...data} with an epoch-millisecond timestamp", () =>
  withLog((log) => {
    const before = Date.now();
    mark("detect:start", { n: 2 });
    assert.equal(log.length, 1);
    assert.equal(log[0].name, "detect:start");
    assert.equal(log[0].n, 2);
    assert.ok(Math.abs(log[0].t - before) < 1000, "t is on the Date.now() clock");
  }));

test("begin: marks '<name>:begin' and returns a step function that tags marks with the same request id", () =>
  withLog((log) => {
    const a = begin("page", { len: 10 });
    const b = begin("page", { len: 20 });
    a("read");
    b("read", { cached: true });
    assert.deepEqual(log.map((m) => m.name), ["page:begin", "page:begin", "page:read", "page:read"]);
    assert.equal(log[0].len, 10);
    assert.equal(log[2].rid, log[0].rid);
    assert.equal(log[3].rid, log[1].rid);
    assert.notEqual(log[0].rid, log[1].rid);
    assert.equal(log[3].cached, true);
  }));

test("begin: without a log it still returns a callable step function", () => {
  const step = begin("page", {});
  assert.equal(typeof step, "function");
  step("read");
  assert.equal(globalThis.__amTrace, undefined);
});
