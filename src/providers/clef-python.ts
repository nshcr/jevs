import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import workerSource from "./clef-worker.py" with { type: "text" };
import type {
  DecisionProvider,
  ProviderOptions,
  DecisionCapabilities,
  AssessmentResult,
} from "../decision.ts";
import type { Assessment } from "../tasks.ts";
import { safeJson, outputSchema } from "../contracts.ts";
import { assessmentToolSupport, validateAssessment } from "../capabilities.ts";
import { toWire, normalizeResponse } from "./system-one.ts";
import { rejectPrototypeKeys } from "../json.ts";
import {
  ConnectionError,
  ProviderConfigurationError,
  ProviderInputError,
  ResponseContractError,
  RequestCancelledError,
  RequestTimeoutError,
} from "../failures.ts";

const capabilities: DecisionCapabilities = {
  judgments: ["classification", "score", "check"],
  inputs: ["text", "json", "image", "video"],
  mixedQuestions: true,
  mediaOptions: true,
  confidence: "provider-defined",
};
type Pending = {
  id: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

function dataURL(value: NonNullable<Assessment["images"]>[number]): string {
  const url =
    typeof value === "string"
      ? value
      : `data:${value.content_type};base64,${value.base64}`;
  const match =
    /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (
    !match ||
    match[2]!.length % 4 !== 0 ||
    Buffer.from(match[2]!, "base64").toString("base64") !== match[2]
  )
    throw new ProviderInputError(
      "Clef images must be valid embedded base64 images; remote URLs and paths are unsupported.",
    );
  return url;
}

export function createClefPythonProvider(
  options: ProviderOptions,
): DecisionProvider {
  if (!options.pythonModelDir?.trim())
    throw new ProviderConfigurationError(
      "clef-python requires a trusted local model directory containing the Clef release.",
    );
  const modelDir = resolve(options.pythonModelDir);
  if (!existsSync(join(modelDir, "joint_schema_model.py")))
    throw new ProviderConfigurationError(
      "The Clef release directory must contain joint_schema_model.py.",
    );
  const executable = options.pythonExecutable?.trim() || "python3";
  const defaultModel = options.defaultModel?.trim() || "clef";
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new ProviderConfigurationError(
      "Clef timeout must be a positive duration.",
    );
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending: Pending | undefined;
  let closed = false;
  let queue = Promise.resolve();
  const exiting = new Set<Promise<unknown>>();
  const tickets = new Set<(error: Error) => void>();
  const invalid = () =>
    new ResponseContractError(
      "Clef worker returned an invalid or uncorrelated response; no results were accepted.",
    );

  function stop(error: Error) {
    const current = child;
    child = undefined;
    const active = pending;
    pending = undefined;
    active?.reject(error);
    if (current) {
      current.stdin.destroy();
      current.kill("SIGKILL");
    }
  }

  function start() {
    if (child) return child;
    let current: ChildProcessWithoutNullStreams;
    try {
      current = spawn(executable, ["-u", "-c", workerSource, modelDir], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          PYTHONUNBUFFERED: "1",
        },
      });
    } catch {
      throw new ConnectionError(
        "Could not start the configured Clef Python interpreter.",
      );
    }
    child = current;
    current.stderr.resume();
    current.stdin.on("error", () => {
      if (child === current)
        stop(new ConnectionError("Clef worker input stream failed."));
    });
    const exit = new Promise<void>((done) =>
      current.once("close", () => {
        if (child === current)
          stop(
            new ConnectionError(
              "Clef worker exited before completing the request.",
            ),
          );
        done();
      }),
    );
    exiting.add(exit);
    void exit.finally(() => exiting.delete(exit));
    current.on("error", () => {
      if (child === current)
        stop(
          new ConnectionError(
            "Could not start the configured Clef Python interpreter.",
          ),
        );
    });
    let buffer = "";
    current.stdout.setEncoding("utf8");
    current.stdout.on("data", (chunk: string) => {
      if (child !== current) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let envelope: unknown;
        try {
          envelope = JSON.parse(line);
          rejectPrototypeKeys(envelope);
        } catch {
          stop(invalid());
          return;
        }
        const active = pending;
        if (
          !active ||
          !envelope ||
          typeof envelope !== "object" ||
          !("id" in envelope) ||
          envelope.id !== active.id ||
          "response" in envelope === "error" in envelope
        ) {
          stop(invalid());
          return;
        }
        if ("error" in envelope) {
          const error =
            envelope.error === "media"
              ? new ProviderInputError(
                  "Clef could not decode the embedded media.",
                )
              : envelope.error === "load" || envelope.error === "inference"
                ? new ConnectionError(
                    "Clef model loading or inference failed; verify the trusted release, optional dependencies and runtime hardware.",
                  )
                : invalid();
          stop(error);
          return;
        }
        pending = undefined;
        active.resolve("response" in envelope ? envelope.response : undefined);
      }
    });
    return current;
  }

  function describe(model = defaultModel) {
    const availability =
      model === defaultModel
        ? ("supported" as const)
        : ("unsupported" as const);
    return {
      provider: "clef-python",
      protocol: "clef-python",
      defaultModel,
      model,
      availability,
      capabilitySource: "configuration" as const,
      capabilities: structuredClone(capabilities),
      toolSupport: assessmentToolSupport(capabilities, availability),
      unverifiedModelsAllowed: false,
      reason:
        model === defaultModel
          ? "Bound to the trusted local Clef release; runtime dependency, hardware and model quality checks are not implied."
          : "This Python runtime is bound to its configured model selector; tool input cannot change the model directory or interpreter.",
    };
  }

  function evaluate(
    input: Assessment,
    signal: AbortSignal,
  ): Promise<AssessmentResult> {
    const expiresAt = performance.now() + timeout;
    try {
      if (closed) throw new ConnectionError("Clef Python provider is closed.");
      if (signal.aborted) throw new RequestCancelledError("Request cancelled.");
      if (describe(input.model).availability === "unsupported")
        throw new ProviderInputError(
          "Clef Python only supports the configured model selector.",
        );
      validateAssessment(input, capabilities);
      const wire = toWire(input, defaultModel);
      const request = {
        ...wire,
        ...(input.images ? { images: input.images.map(dataURL) } : {}),
        ...(input.videos
          ? { videos: input.videos.map((video) => video.frames.map(dataURL)) }
          : {}),
        ...(input.mediaOptions !== undefined
          ? { media_kwargs: input.mediaOptions }
          : {}),
      };
      return new Promise<AssessmentResult>((resolveResult, rejectResult) => {
        let settled = false;
        let running = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error, result?: AssessmentResult) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          tickets.delete(fail);
          if (error) rejectResult(error);
          else resolveResult(result!);
        };
        const fail = (error: Error) => finish(error);
        const cancel = () => {
          const error = new RequestCancelledError("Request cancelled.");
          if (running) stop(error);
          finish(error);
        };
        tickets.add(fail);
        // One deadline includes waiting for this provider's serialized worker.
        // A queued ticket may expire without interrupting another request.
        timer = setTimeout(
          () => {
            if (settled) return;
            const error = new RequestTimeoutError("Clef request timed out.");
            if (running) stop(error);
            finish(error);
          },
          Math.max(0, expiresAt - performance.now()),
        );
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        queue = queue.then(async () => {
          if (settled) return;
          if (closed) {
            finish(new ConnectionError("Clef Python provider is closed."));
            return;
          }
          // Timer callbacks may be delayed while promise microtasks advance
          // this queue. Acquiring a slot never extends the original deadline.
          if (performance.now() >= expiresAt) {
            finish(new RequestTimeoutError("Clef request timed out."));
            return;
          }
          running = true;
          try {
            const current = start();
            const raw = await new Promise<unknown>(
              (resolveReply, rejectReply) => {
                const id = randomUUID();
                const payload = JSON.stringify({ id, request }) + "\n";
                if (performance.now() >= expiresAt) {
                  rejectReply(
                    new RequestTimeoutError("Clef request timed out."),
                  );
                  return;
                }
                pending = { id, resolve: resolveReply, reject: rejectReply };
                current.stdin.write(payload);
              },
            );
            const result = normalizeResponse(raw, wire, "clef-python", {
              requiredUsage: true,
              requiredMetrics: true,
            });
            const parsed = safeJson(outputSchema).safeParse({
              ...result,
              protocol: "clef-python",
            });
            if (!parsed.success) throw invalid();
            // Parsing and validation are synchronous; an elapsed timer might
            // not have executed yet even after a response has arrived.
            if (performance.now() >= expiresAt)
              throw new RequestTimeoutError("Clef request timed out.");
            finish(undefined, parsed.data);
          } catch (error) {
            if (
              error instanceof ResponseContractError ||
              error instanceof RequestTimeoutError
            )
              stop(error);
            finish(
              error instanceof Error
                ? error
                : new ConnectionError("Clef execution failed."),
            );
          } finally {
            running = false;
          }
        });
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return {
    describe,
    evaluate,
    async listModels(signal) {
      if (signal.aborted) throw new RequestCancelledError("Request cancelled.");
      const description = describe();
      return {
        ...description,
        source: "configured",
        complete: false,
        models: [
          {
            id: defaultModel,
            protocol: description.protocol,
            availability: description.availability,
            capabilitySource: "configuration",
            capabilities: description.capabilities,
            reason: description.reason,
          },
        ],
      };
    },
    async close() {
      closed = true;
      const error = new ConnectionError("Clef Python provider is closed.");
      stop(error);
      for (const reject of [...tickets]) reject(error);
      await Promise.all([...exiting]);
      await queue;
    },
  };
}
