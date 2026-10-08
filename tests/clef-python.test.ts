import { afterAll, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClefPythonProvider } from "../src/providers/clef-python.ts";
import {
  ProviderInputError,
  ResponseContractError,
  RequestCancelledError,
  RequestTimeoutError,
  ConnectionError,
} from "../src/failures.ts";

const modelDir = await mkdtemp(join(tmpdir(), "jevs-clef-synthetic-"));
// Synthetic decision backend. Media decoding still uses real Pillow; no weights or model inference.
await writeFile(
  join(modelDir, "joint_schema_model.py"),
  `
import os, time
from pathlib import Path
loads = 0
def load_release_model(path):
    global loads
    loads += 1
    print('synthetic load log must not pollute protocol')
    return object(), object()
def systemone(model, processor, request):
    state = request['state']
    if state == 'slow':
        Path(__file__).with_name('active').write_text('started')
        time.sleep(2)
    if state == 'exit': os._exit(7)
    if state == 'invalid-json':
        os.write(3, b'not-json\\n')
        time.sleep(2)
    if state == 'wrong-correlation':
        os.write(3, b'{"id":"wrong","response":{}}\\n')
        time.sleep(2)
    if state == 'missing-id': return {'model':request['model'], 'answers':{}, 'usage':{'input_tokens':1,'output_tokens':0}}
    if state == 'nonfinite': return {'model':request['model'], 'answers':{'ready':{'type':'noul','noul':float('nan')}}, 'usage':{'input_tokens':1,'output_tokens':0}}
    if state == 'prototype-key': return {'model':request['model'], 'answers':{'ready':{'type':'noul','noul':0.8,'__proto__':{'polluted':True}}}, 'usage':{'input_tokens':1,'output_tokens':0}}
    if isinstance(state, dict) and state.get('media'):
        assert request['images'][0].size == (1,1)
        assert len(request['videos']) == 1 and len(request['videos'][0]) == 2
        assert request['videos'][0][0].mode == 'RGB'
        assert request['media_kwargs'] == {'fps':2, 'nested':{'enabled':True}}
    answers = {}
    for key, q in request['questions'].items():
        if q['type'] == 'noul': answers[key] = {'type':'noul','noul':0.8}
        elif q['type'] == 'choice':
            keys = list(q['criteria'])
            answers[key] = {'type':'choice','choice':keys[0], 'confidence':0.7, 'probabilities':{k:0.7 if i == 0 else 0.3 for i,k in enumerate(keys)}}
        else: answers[key] = {'type':'score','score':0.3,'confidence':0.7,'probabilities':{'0':0.7,'1':0.3},'legend':{'0':q['criteria'][0],'1':q['criteria'][1]}}
    return {'model':request['model'], 'answers':answers, 'usage':{'input_tokens':loads,'output_tokens':0}}
`,
);
afterAll(() => rm(modelDir, { recursive: true, force: true }));
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L9sAAAAASUVORK5CYII=";
const input = {
  content: "ready",
  checks: [{ id: "ready", question: "Ready?" }],
};
const signal = () => new AbortController().signal;
const provider = (timeoutMs = 5000) =>
  createClefPythonProvider({
    kind: "clef-python",
    pythonModelDir: modelDir,
    timeoutMs,
  });

test("Clef Python keeps one loaded worker, maps mixed decisions and decodes image/video frames", async () => {
  const p = provider();
  try {
    expect(p.describe()).toMatchObject({
      protocol: "clef-python",
      availability: "supported",
      capabilitySource: "configuration",
      capabilities: {
        inputs: ["text", "json", "image", "video"],
        mediaOptions: true,
      },
    });
    const result = await p.evaluate(
      {
        ...input,
        content: { media: true },
        images: [png],
        videos: [{ frames: [png, png] }],
        mediaOptions: { fps: 2, nested: { enabled: true } },
        classifications: [
          {
            id: "team",
            question: "Team?",
            options: { technical: "Bug", billing: "Invoice" },
          },
        ],
        scores: [
          { id: "priority", question: "Priority?", levels: ["low", "high"] },
        ],
      },
      signal(),
    );
    expect(result.results.map((x) => x.kind)).toEqual([
      "classification",
      "score",
      "check",
    ]);
    expect(result.usage?.inputTokens).toBe(1);
    expect((await p.evaluate(input, signal())).usage?.inputTokens).toBe(1);
  } finally {
    await p.close?.();
  }
});

test("Clef model overrides and unsupported media never dispatch", async () => {
  const p = provider();
  try {
    expect(p.describe("other").availability).toBe("unsupported");
    await expect(
      p.evaluate({ ...input, model: "other" }, signal()),
    ).rejects.toBeInstanceOf(ProviderInputError);
    await expect(
      p.evaluate(
        { ...input, images: ["https://example.com/image.png"] },
        signal(),
      ),
    ).rejects.toBeInstanceOf(ProviderInputError);
    await expect(
      p.evaluate(
        { ...input, images: ["data:image/png;base64,bad!"] },
        signal(),
      ),
    ).rejects.toBeInstanceOf(ProviderInputError);
    await expect(
      p.evaluate(
        { ...input, messages: [{ parts: [{ type: "text", text: "hello" }] }] },
        signal(),
      ),
    ).rejects.toBeInstanceOf(ProviderInputError);
  } finally {
    await p.close?.();
  }
});

test("Clef contract and subprocess failures never return fabricated results and restart", async () => {
  const p = provider();
  try {
    for (const state of [
      "missing-id",
      "nonfinite",
      "prototype-key",
      "invalid-json",
      "wrong-correlation",
      "exit",
    ]) {
      await expect(
        p.evaluate({ ...input, content: state }, signal()),
      ).rejects.toBeInstanceOf(
        state === "exit" ? ConnectionError : ResponseContractError,
      );
      expect((await p.evaluate(input, signal())).results[0]).toMatchObject({
        id: "ready",
        probability: 0.8,
      });
    }
  } finally {
    await p.close?.();
  }
});

test("Clef cancellation rejects active and queued work without poisoning subsequent calls", async () => {
  const p = provider();
  try {
    const active = new AbortController();
    await rm(join(modelDir, "active"), { force: true });
    const pending = p.evaluate({ ...input, content: "slow" }, active.signal);
    const activeCheck = pending.catch((error) => error);
    // Wait for actual model dispatch, so this proves active worker termination.
    for (let i = 0; i < 100; i++) {
      if (await readFile(join(modelDir, "active"), "utf8").catch(() => ""))
        break;
      await Bun.sleep(10);
    }
    expect(await readFile(join(modelDir, "active"), "utf8")).toBe("started");
    const queued = new AbortController();
    const second = p.evaluate(input, queued.signal);
    queued.abort();
    await expect(second).rejects.toBeInstanceOf(RequestCancelledError);
    active.abort();
    expect(await activeCheck).toBeInstanceOf(RequestCancelledError);
    expect((await p.evaluate(input, signal())).results).toHaveLength(1);
  } finally {
    await p.close?.();
  }
});

test("Clef missing dependencies or invalid media surface errors and permit recovery", async () => {
  const brokenDir = await mkdtemp(join(tmpdir(), "jevs-clef-load-failure-"));
  await writeFile(
    join(brokenDir, "joint_schema_model.py"),
    "raise ImportError('synthetic sensitive load failure')",
  );
  const broken = createClefPythonProvider({
    kind: "clef-python",
    pythonModelDir: brokenDir,
  });
  try {
    await expect(broken.evaluate(input, signal())).rejects.toBeInstanceOf(
      ConnectionError,
    );
  } finally {
    await broken.close?.();
    await rm(brokenDir, { recursive: true, force: true });
  }
  const p = provider();
  try {
    await expect(
      p.evaluate(
        { ...input, images: ["data:image/png;base64,YmFk"] },
        signal(),
      ),
    ).rejects.toBeInstanceOf(ProviderInputError);
    expect((await p.evaluate(input, signal())).results).toHaveLength(1);
  } finally {
    await p.close?.();
  }
});

test("Clef timeout terminates active worker and close rejects queued work", async () => {
  const p = provider(1000);
  await expect(
    p.evaluate({ ...input, content: "slow" }, signal()),
  ).rejects.toBeInstanceOf(RequestTimeoutError);
  expect((await p.evaluate(input, signal())).results).toHaveLength(1);
  await rm(join(modelDir, "active"), { force: true });
  const pending = p.evaluate({ ...input, content: "slow" }, signal());
  const queued = p.evaluate(input, signal());
  const pendingCheck = pending.catch((error) => error);
  const queuedCheck = queued.catch((error) => error);
  for (let i = 0; i < 100; i++) {
    if (await readFile(join(modelDir, "active"), "utf8").catch(() => "")) break;
    await Bun.sleep(10);
  }
  expect(await readFile(join(modelDir, "active"), "utf8")).toBe("started");
  await p.close?.();
  expect(await pendingCheck).toBeInstanceOf(ConnectionError);
  expect(await queuedCheck).toBeInstanceOf(ConnectionError);
});

test("Clef request deadline includes time waiting for the serialized worker", async () => {
  const p = provider(600);
  try {
    // Warm interpreter setup so the elapsed check isolates the internal queue.
    await p.evaluate(input, signal());
    const started = performance.now();
    const first = p
      .evaluate({ ...input, content: "slow" }, signal())
      .catch((error) => error);
    const second = p
      .evaluate({ ...input, content: "slow" }, signal())
      .catch((error) => error);
    const [active, queued] = await Promise.all([first, second]);
    expect(active).toBeInstanceOf(RequestTimeoutError);
    expect(queued).toBeInstanceOf(RequestTimeoutError);
    expect(performance.now() - started).toBeLessThan(950);
    expect((await p.evaluate(input, signal())).results).toHaveLength(1);
  } finally {
    await p.close?.();
  }
});

test("Expired queued Clef work never starts or writes when timer callbacks are delayed", async () => {
  const p = provider(120);
  const originalSpawn = childProcess.spawn;
  const writes: string[] = [];
  let starts = 0;
  const interception = spyOn(childProcess, "spawn").mockImplementation(((
    ...args: unknown[]
  ) => {
    const child = Reflect.apply(
      originalSpawn,
      childProcess,
      args,
    ) as childProcess.ChildProcessWithoutNullStreams;
    starts++;
    const originalWrite = child.stdin!.write.bind(child.stdin!);
    spyOn(child.stdin!, "write").mockImplementation((...parts: unknown[]) => {
      writes.push(String(parts[0]));
      return Reflect.apply(originalWrite, child.stdin, parts) as boolean;
    });
    return child;
  }) as typeof childProcess.spawn);
  try {
    await p.evaluate(input, signal());
    const baselineStarts = starts;
    const first = p
      .evaluate({ ...input, content: "slow" }, signal())
      .catch((error) => error);
    const queued = p
      .evaluate({ ...input, content: "expired-queued" }, signal())
      .catch((error) => error);
    // Let the first request take the existing worker, then occupy the event loop
    // past both deadlines. Their timer callbacks must not authorize queued work.
    await Bun.sleep(20);
    const unblock = performance.now() + 180;
    while (performance.now() < unblock) {
      /* Deliberate blocked event loop. */
    }
    const [activeError, queuedError] = await Promise.all([first, queued]);
    expect(activeError).toBeInstanceOf(RequestTimeoutError);
    expect(queuedError).toBeInstanceOf(RequestTimeoutError);
    expect(starts).toBe(baselineStarts);
    expect(writes.map((line) => JSON.parse(line).request.state)).not.toContain(
      "expired-queued",
    );
  } finally {
    await p.close?.();
    interception.mockRestore();
  }
});

test("Clef responses processed past the deadline time out instead of returning success", async () => {
  const p = provider(120);
  let parsing: ReturnType<typeof spyOn> | undefined;
  try {
    await p.evaluate(input, signal());
    const originalParse = JSON.parse;
    parsing = spyOn(JSON, "parse").mockImplementation(
      (...args: Parameters<typeof JSON.parse>) => {
        const value = originalParse(...args);
        if (value?.response?.model === "clef") {
          // Delegate actual parsing of the real Python reply, then simulate busy
          // synchronous response validation while the timer cannot run.
          const unblock = performance.now() + 180;
          while (performance.now() < unblock) {
            /* Deliberate blocked event loop. */
          }
        }
        return value;
      },
    );
    await expect(p.evaluate(input, signal())).rejects.toBeInstanceOf(
      RequestTimeoutError,
    );
    parsing.mockRestore();
    parsing = undefined;
    expect((await p.evaluate(input, signal())).results[0]).toMatchObject({
      id: "ready",
      probability: 0.8,
    });
  } finally {
    parsing?.mockRestore();
    await p.close?.();
  }
});
