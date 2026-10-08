import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  experimentRoot as root,
  experimentSnapshot,
  pathArgument,
} from "./experiment-support.ts";
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L9sAAAAASUVORK5CYII=";
// Deliberately synthetic official-shaped backend; no trained model is loaded.
const syntheticBackend = `
import json, os
from pathlib import Path
calls = 0
def load_release_model(path):
    print('synthetic loading log')
    return object(), object()
def systemone(model, processor, request):
    global calls
    calls += 1
    trace = {'workerPid':os.getpid(), 'state':request['state'], 'questions':request['questions'], 'images':[{'size':list(x.size),'mode':x.mode} for x in request.get('images',[])], 'videos':[[{'size':list(x.size),'mode':x.mode} for x in frames] for frames in request.get('videos',[])], 'media_kwargs':request.get('media_kwargs')}
    with Path(__file__).with_name('traces.jsonl').open('a') as out: out.write(json.dumps(trace)+'\\n')
    if request['state'] == 'missing-id': return {'model':request['model'],'answers':{},'usage':{'input_tokens':calls,'output_tokens':0}}
    if request['state'] == 'exit': os._exit(7)
    answers = {}
    for key,q in request['questions'].items():
        if q['type'] == 'noul': answers[key] = {'type':'noul','noul':0.9}
        elif q['type'] == 'choice':
            keys = list(q['criteria'])
            answers[key] = {'type':'choice','choice':keys[0],'confidence':0.8,'probabilities':{k:0.8 if i == 0 else 0.2 for i,k in enumerate(keys)}}
        else: answers[key] = {'type':'score','score':0.2,'confidence':0.8,'probabilities':{'0':0.8,'1':0.2},'legend':{str(i):x for i,x in enumerate(q['criteria'])}}
    return {'model':request['model'],'answers':answers,'usage':{'input_tokens':calls,'output_tokens':0}}
`;

const snapshot = (entry: string) => experimentSnapshot(entry, import.meta.path);

function output(reply: Awaited<ReturnType<Client["callTool"]>>) {
  assert(!reply.isError, JSON.stringify(reply));
  assert(reply.structuredContent);
  return reply.structuredContent as Record<string, any>;
}

export async function runClefExperiment(
  entry = join(root, "src/index.ts"),
  report = join(root, ".local", `clef-python-experiment-${randomUUID()}.json`),
) {
  const before = await snapshot(entry);
  const modelDir = await mkdtemp(join(tmpdir(), "jevs-clef-mcp-synthetic-"));
  await Bun.write(join(modelDir, "joint_schema_model.py"), syntheticBackend);
  const python = Bun.which("python3");
  assert(python, "Python 3 is required for the Clef bridge experiment.");
  const probe = Bun.spawnSync([python, "-c", "from PIL import Image"], {
    stderr: "pipe",
  });
  assert.equal(
    probe.exitCode,
    0,
    "Pillow is required for the Clef bridge media experiment.",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-env-file", entry],
    cwd: tmpdir(),
    env: {
      JEVS_PROVIDER: "clef-python",
      JEVS_PYTHON_EXECUTABLE: python,
      JEVS_PYTHON_MODEL_DIR: modelDir,
      JEVS_DEFAULT_MODEL: "synthetic-clef",
      JEVS_REQUEST_TIMEOUT_MS: "5000",
      JEVS_ALLOW_UNVERIFIED_MODELS: "false",
      JEVS_PROTOCOL: "",
      JEVS_API_KEY: "",
      JEVS_BASE_URL: "",
      JEVS_MAX_CONCURRENCY: "2",
      JEVS_MAX_QUEUE: "8",
      JEVS_QUEUE_TIMEOUT_MS: "1000",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({
    name: "jevs-clef-python-experiment",
    version: "1",
  });
  const scenarios: { name: string; verdict: "passed" }[] = [];
  let failure: unknown;
  let traces: unknown[] = [];
  try {
    await client.connect(transport);
    const info = output(
      await client.callTool({ name: "provider_info", arguments: {} }),
    );
    assert.equal(info.protocol, "clef-python");
    assert.equal(info.capabilitySource, "configuration");
    assert(info.capabilities.inputs.includes("video"));
    const catalog = output(
      await client.callTool({ name: "list_models", arguments: {} }),
    );
    assert.equal(catalog.models[0].id, "synthetic-clef");
    scenarios.push({
      name: "configured-catalog-and-runtime-capabilities",
      verdict: "passed",
    });
    const result = output(
      await client.callTool({
        name: "assess_structure",
        arguments: {
          content: { synthetic: true },
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
          checks: [{ id: "ready", question: "Ready?" }],
        },
      }),
    );
    assert.equal(result.protocol, "clef-python");
    assert.deepEqual(
      result.results.map((r: { kind: string }) => r.kind),
      ["classification", "score", "check"],
    );
    assert.equal(result.usage.inputTokens, 1);
    scenarios.push({
      name: "mixed-judgments-pillow-images-video-and-processor-options",
      verdict: "passed",
    });
    const check = (content: string, model?: string) =>
      client.callTool({
        name: "check",
        arguments: {
          content,
          items: [{ id: "ready", question: "Ready?" }],
          ...(model ? { model } : {}),
        },
      });
    assert.equal(output(await check("ready")).usage.inputTokens, 2);
    scenarios.push({
      name: "worker-reuse-without-model-reload",
      verdict: "passed",
    });
    assert.equal((await check("never-dispatch", "other-model")).isError, true);
    scenarios.push({
      name: "fixed-selector-rejects-tool-runtime-override",
      verdict: "passed",
    });
    for (const state of ["missing-id", "exit"]) {
      assert.equal((await check(state)).isError, true);
      assert.equal(
        output(await check("recovered")).results[0].probability,
        0.9,
      );
    }
    scenarios.push({
      name: "invalid-answer-and-child-exit-recovery-without-false-results",
      verdict: "passed",
    });
  } catch (error) {
    failure = error;
  } finally {
    await client.close();
    const traceFile = Bun.file(join(modelDir, "traces.jsonl"));
    if (await traceFile.exists())
      traces = (await traceFile.text())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    await rm(modelDir, { recursive: true, force: true });
  }
  const after = await snapshot(entry);
  if (!failure) {
    try {
      const wire = traces as Record<string, any>[];
      assert.deepEqual(wire[0]?.images, [{ size: [1, 1], mode: "RGB" }]);
      assert.deepEqual(wire[0]?.videos, [
        [
          { size: [1, 1], mode: "RGB" },
          { size: [1, 1], mode: "RGB" },
        ],
      ]);
      assert.deepEqual(wire[0]?.media_kwargs, {
        fps: 2,
        nested: { enabled: true },
      });
      assert(!wire.some((trace) => trace.state === "never-dispatch"));
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      };
      const pids = [...new Set(wire.map((trace) => trace.workerPid as number))];
      for (let i = 0; i < 100 && pids.some(alive); i++) await Bun.sleep(10);
      assert(
        !pids.some(alive),
        "MCP shutdown left a Clef Python worker alive.",
      );
      scenarios.push({
        name: "MCP-shutdown-disposes-all-python-workers",
        verdict: "passed",
      });
    } catch (error) {
      failure = error;
    }
  }
  const stable = JSON.stringify(before) === JSON.stringify(after);
  if (!stable)
    failure ??= new Error("Source or entry changed during the experiment.");
  await mkdir(dirname(report), { recursive: true });
  await Bun.write(
    report,
    JSON.stringify(
      {
        evidence: "local-synthetic-python-backend",
        verdict: failure ? "failed" : "passed",
        generatedAt: new Date().toISOString(),
        reproduction: [
          "bun",
          "--no-env-file",
          "scripts/clef-python-experiment.ts",
          "--entry",
          relative(root, entry),
          "--output",
          relative(root, report),
        ],
        limitations: [
          "No trained Clef weights, GPU inference, model quality or production dependencies were validated.",
          "Real Python, Pillow, JSONL lifecycle, MCP stdio and packaged entry were exercised against an explicitly synthetic official-shaped backend.",
        ],
        before,
        after,
        snapshotStable: stable,
        scenarios,
        traces,
        ...(failure
          ? {
              failure:
                failure instanceof Error ? failure.message : String(failure),
            }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
  if (failure) throw failure;
  console.log(
    `Clef Python experiment passed: ${scenarios.length} scenarios. Report: ${report}`,
  );
}

if (import.meta.main) {
  await runClefExperiment(pathArgument("--entry"), pathArgument("--output"));
}
