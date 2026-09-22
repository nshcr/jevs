import { APIUserAbortError } from "@typesafe-ai/sdk";

export type SchedulerOptions = {
  concurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
};
export const schedulerDefaults: SchedulerOptions = {
  concurrency: 4,
  maxQueue: 32,
  queueTimeoutMs: 1000,
};
export class AdmissionError extends Error {
  constructor(readonly reason: "full" | "timeout") {
    super(reason);
  }
}
function bounded(value: number, min: number, max: number, name: string) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(
      `Invalid ${name}; expected an integer from ${min} to ${max}`,
    );
  return value;
}
export function schedulerOptions(
  env: Record<string, string | undefined>,
): SchedulerOptions {
  const read = (key: string, fallback: number) =>
    env[key]?.trim() ? Number(env[key]) : fallback;
  return {
    concurrency: bounded(
      read("JEVS_MAX_CONCURRENCY", 4),
      1,
      64,
      "JEVS_MAX_CONCURRENCY",
    ),
    maxQueue: bounded(read("JEVS_MAX_QUEUE", 32), 0, 1024, "JEVS_MAX_QUEUE"),
    queueTimeoutMs: bounded(
      read("JEVS_QUEUE_TIMEOUT_MS", 1000),
      1,
      60000,
      "JEVS_QUEUE_TIMEOUT_MS",
    ),
  };
}

// One limiter per MCP server. Only asynchronous I/O occupies a slot; no batching
// delay or eager submission of a whole record set. Waiting work is cancellable.
export class RequestScheduler {
  readonly options: SchedulerOptions;
  private active = 0;
  private readonly queue: Array<{ start: () => void }> = [];
  constructor(options: Partial<SchedulerOptions> = {}) {
    this.options = { ...schedulerDefaults, ...options };
    bounded(this.options.concurrency, 1, 64, "concurrency");
    bounded(this.options.maxQueue, 0, 1024, "maxQueue");
    bounded(this.options.queueTimeoutMs, 1, 60000, "queueTimeoutMs");
  }
  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new APIUserAbortError();
    let deadline: number | undefined;
    if (this.active < this.options.concurrency) this.active++;
    else deadline = await this.wait(signal);
    try {
      if (signal.aborted) throw new APIUserAbortError();
      // A resolved admission promise can itself wait behind other microtasks.
      if (deadline !== undefined && performance.now() >= deadline)
        throw new AdmissionError("timeout");
      return await task();
    } finally {
      this.active--;
      // An expired entry consumes no slot; continue to the next waiting item.
      while (this.active < this.options.concurrency && this.queue.length)
        this.queue.shift()!.start();
    }
  }
  private wait(signal: AbortSignal) {
    if (this.queue.length >= this.options.maxQueue)
      return Promise.reject(new AdmissionError("full"));
    const deadline = performance.now() + this.options.queueTimeoutMs;
    return new Promise<number>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const fail = (error: Error) => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        cleanup();
        reject(error);
      };
      const abort = () => fail(new APIUserAbortError());
      const entry = {
        start: () => {
          cleanup();
          // Timers may be delayed by synchronous work or a microtask backlog.
          if (performance.now() >= deadline) {
            reject(new AdmissionError("timeout"));
            return;
          }
          this.active++;
          resolve(deadline);
        },
      };
      const timer = setTimeout(
        () => fail(new AdmissionError("timeout")),
        this.options.queueTimeoutMs,
      );
      this.queue.push(entry);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
