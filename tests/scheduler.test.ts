import { expect, test } from "bun:test";
import { APIUserAbortError } from "@typesafe-ai/sdk";
import {
  RequestScheduler,
  AdmissionError,
  schedulerOptions,
} from "../src/scheduler.ts";
const signal = () => new AbortController().signal;

test("scheduler caps active work, bounds queue, removes cancellation and recovers slots", async () => {
  const scheduler = new RequestScheduler({
    concurrency: 2,
    maxQueue: 1,
    queueTimeoutMs: 1000,
  });
  const gate = Promise.withResolvers<void>();
  let active = 0,
    peak = 0,
    calls = 0;
  const work = async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await gate.promise;
    active--;
  };
  const first = scheduler.run(work, signal()),
    second = scheduler.run(work, signal());
  const abort = new AbortController();
  const queued = scheduler.run(work, abort.signal).catch((e) => e);
  await expect(scheduler.run(work, signal())).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(calls).toBe(2);
  abort.abort();
  expect(await queued).toBeInstanceOf(APIUserAbortError);
  const replacement = scheduler.run(work, signal());
  gate.resolve();
  await Promise.all([first, second, replacement]);
  expect(calls).toBe(3);
  expect(peak).toBe(2);
  await expect(scheduler.run(async () => 42, signal())).resolves.toBe(42);
});

test("expired queued work is never sent and rejected work does not leak capacity", async () => {
  const scheduler = new RequestScheduler({
    concurrency: 1,
    maxQueue: 1,
    queueTimeoutMs: 10,
  });
  const gate = Promise.withResolvers<void>();
  const first = scheduler.run(() => gate.promise, signal());
  let calls = 0;
  const result = await scheduler
    .run(async () => {
      calls++;
    }, signal())
    .catch((e) => e);
  expect(result).toBeInstanceOf(AdmissionError);
  expect(result.reason).toBe("timeout");
  expect(calls).toBe(0);
  gate.resolve();
  await first;
  await expect(
    scheduler.run(async () => {
      throw Error("failed");
    }, signal()),
  ).rejects.toThrow("failed");
  await expect(scheduler.run(async () => 1, signal())).resolves.toBe(1);
});

test("scheduler settings reject invalid limits without changing globals", () => {
  expect(schedulerOptions({})).toEqual({
    concurrency: 4,
    maxQueue: 32,
    queueTimeoutMs: 1000,
  });
  for (const value of ["-1", "NaN", "1.5", "65"])
    expect(() => schedulerOptions({ JEVS_MAX_CONCURRENCY: value })).toThrow();
  expect(schedulerOptions({ JEVS_MAX_QUEUE: "0" }).maxQueue).toBe(0);
});

function blockEventLoop(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* Deliberately delay timer callbacks. */
  }
}

test("delayed timers cannot admit expired work or strand the next queued item", async () => {
  const scheduler = new RequestScheduler({
    concurrency: 1,
    maxQueue: 2,
    queueTimeoutMs: 10,
  });
  const gate = Promise.withResolvers<void>();
  const first = scheduler.run(() => gate.promise, signal());
  let expiredCalls = 0;
  const expired = scheduler
    .run(async () => {
      expiredCalls++;
    }, signal())
    .catch((e) => e);
  blockEventLoop(25);
  const fresh = scheduler.run(async () => "fresh", signal());
  gate.resolve();
  await first;
  const error = await expired;
  expect(error).toBeInstanceOf(AdmissionError);
  expect(error.reason).toBe("timeout");
  expect(expiredCalls).toBe(0);
  expect(await fresh).toBe("fresh");
});

test("queued deadline is rechecked after handoff before executing task", async () => {
  const scheduler = new RequestScheduler({
    concurrency: 1,
    maxQueue: 1,
    queueTimeoutMs: 10,
  });
  const gate = Promise.withResolvers<void>();
  const first = scheduler.run(() => gate.promise, signal());
  let calls = 0;
  const queued = scheduler
    .run(async () => {
      calls++;
    }, signal())
    .catch((e) => e);
  gate.resolve();
  queueMicrotask(() => blockEventLoop(25));
  await first;
  expect(await queued).toBeInstanceOf(AdmissionError);
  expect(calls).toBe(0);
  expect(await scheduler.run(async () => "recovered", signal())).toBe(
    "recovered",
  );
});
