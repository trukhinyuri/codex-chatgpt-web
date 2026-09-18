import {
  classifyError,
  LOCAL_UNAVAILABLE_RETRY_AFTER_SECONDS,
  withCodexRetryAfter,
  type CodexErrorPayload,
  type CodexStreamError,
} from "./lib/errors";
import { formatErrorResponse, responsesStreamFailure } from "./bridge";

/** How long a Codex turn that arrives during a drain waits for the drain to end. */
export const DRAIN_HOLD_MS = 120_000;
/** Pause Codex takes before retrying a turn the drain did not let through. */
export const DRAIN_RETRY_AFTER_SECONDS = LOCAL_UNAVAILABLE_RETRY_AFTER_SECONDS;
export const DRAINING_MESSAGE = "codex-chatgpt-web is draining for a requested service operation";
/** The bridge's own code for a turn a drain turned away; Codex receives a paced-retry code. */
export const SERVICE_DRAINING_CODE = "service_draining";

export type DrainWaitOutcome = "resumed" | "timeout" | "shutdown" | "aborted";

/**
 * Whether the runtime accepts new turns. A drain stops new work so a service operation (restart,
 * update, settings change) can wait for idleness; turns that arrive meanwhile wait here instead of
 * failing at once. Waiting requests are not active turns: counting them would keep the drain from
 * ever proving idleness.
 */
export class DrainGate {
  private draining = false;
  private closed = false;
  private readonly waiters = new Set<(outcome: DrainWaitOutcome) => void>();

  get isDraining(): boolean {
    return this.draining;
  }

  /** Requests currently waiting for the drain to end. */
  get held(): number {
    return this.waiters.size;
  }

  drain(): void {
    this.draining = true;
  }

  /** End the drain and let every waiting request through. A shut-down gate stays closed. */
  resume(): void {
    if (this.closed) return;
    this.draining = false;
    this.settle("resumed");
  }

  /** The runtime is stopping: nothing waits any longer and nothing is let through again. */
  close(): void {
    this.draining = true;
    this.closed = true;
    this.settle("shutdown");
  }

  wait(timeoutMs: number, signal?: AbortSignal): Promise<DrainWaitOutcome> {
    if (this.closed) return Promise.resolve("shutdown");
    if (!this.draining) return Promise.resolve("resumed");
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish("aborted");
      const finish = (outcome: DrainWaitOutcome) => {
        if (!this.waiters.delete(finish)) return;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      this.waiters.add(finish);
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private settle(outcome: DrainWaitOutcome): void {
    for (const finish of [...this.waiters]) finish(outcome);
  }
}

/** The failure a drained turn reports once it stops waiting: Codex pauses, then retries. */
export function drainedTurnError(): CodexErrorPayload {
  return {
    message: withCodexRetryAfter(
      `${DRAINING_MESSAGE}; Codex will send this turn again.`,
      DRAIN_RETRY_AFTER_SECONDS,
    ),
    type: "server_error",
    code: SERVICE_DRAINING_CODE,
  };
}

/** The answer for a waiting request that has no response stream to carry the failure. */
export function drainedHttpResponse(): Response {
  const response = formatErrorResponse(503, "server_error", drainedTurnError().message);
  response.headers.set("retry-after", String(DRAIN_RETRY_AFTER_SECONDS));
  return response;
}

const encoder = new TextEncoder();
const HEARTBEAT_FRAME = encoder.encode('event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n');
const DONE_FRAME = encoder.encode("data: [DONE]\n\n");

function frame(name: string, data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
}

/** A response.failed frame for a waiting turn, journaled like every other streamed failure. */
function heldFailure(httpStatus: number, error: CodexErrorPayload, retryable?: boolean, modelId = "unknown"): Uint8Array {
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const wire: CodexStreamError = responsesStreamFailure({ httpStatus, error }, retryable, { modelId, responseId });
  return frame("response.failed", {
    sequence_number: 0,
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      output: [],
      usage: null,
      error: wire,
      last_error: wire,
    },
  });
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * Codex's reading of an HTTP status it can no longer receive as one: a client error is terminal
 * (Codex maps HTTP 400 to its non-retryable InvalidRequest); anything else keeps Codex's retry.
 */
function retryableForStatus(status: number): boolean | undefined {
  if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) return false;
  return undefined;
}

/**
 * The response frames for a non-stream answer that arrived after the drain ended: the stream
 * headers were already sent while the request waited, so the answer travels as frames.
 */
async function framesForJsonResponse(response: Response): Promise<Uint8Array[]> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const model = typeof record.model === "string" ? record.model : "unknown";
  if (response.ok && record.object === "response" && (record.status === "completed" || record.status === "incomplete")) {
    const output = Array.isArray(record.output) ? record.output : [];
    return [
      ...output.map((item, index) => frame("response.output_item.done", { sequence_number: index, output_index: index, item })),
      frame(`response.${record.status}`, { sequence_number: output.length, response: record }),
    ];
  }
  const rawError = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : {};
  const error: CodexErrorPayload = {
    message: typeof rawError.message === "string" && rawError.message.trim()
      ? rawError.message
      : `codex-chatgpt-web answered HTTP ${response.status}`,
    type: typeof rawError.type === "string" ? rawError.type : "server_error",
    code: typeof rawError.code === "string" ? rawError.code : null,
  };
  const retryable = typeof record.retryable === "boolean" ? record.retryable : retryableForStatus(response.status);
  return [heldFailure(response.ok ? 502 : response.status, error, retryable, model)];
}

/**
 * A streamed Codex turn that arrived during a drain. The response stream opens at once and carries
 * heartbeats while the request waits, up to `holdMs`. When the drain ends, the real turn runs and
 * its stream continues on the same connection. When the drain outlasts the hold, or the runtime
 * shuts down, Codex receives a failure it waits out (DRAIN_RETRY_AFTER_SECONDS) before it retries,
 * normally against the restarted runtime. Never "Selected model is at capacity".
 */
export function heldStreamingResponse(options: {
  gate: DrainGate;
  signal: AbortSignal;
  holdMs: number;
  heartbeatMs: number;
  run: () => Promise<Response>;
}): Response {
  const { gate, holdMs, heartbeatMs, run } = options;
  const waitAbort = new AbortController();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let upstream: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  // Push-driven with polled backpressure, like the bridge's own stream on Windows: Bun serving a
  // JS stream whose pull() returns a Promise crashes there (Bun#32111).
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        stopHeartbeat();
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      };
      const waitForCapacity = async () => {
        while (!closed && (controller.desiredSize ?? 1) <= 0) {
          await new Promise<void>(resolve => setTimeout(resolve, 5));
        }
      };
      // Send the headers and a first frame now; heartbeats show the turn is alive while it waits.
      enqueue(HEARTBEAT_FRAME);
      heartbeat = setInterval(() => enqueue(HEARTBEAT_FRAME), heartbeatMs);
      void (async () => {
        const outcome = await gate.wait(holdMs, AbortSignal.any([options.signal, waitAbort.signal]));
        stopHeartbeat();
        if (closed || outcome === "aborted") {
          finish();
          return;
        }
        if (outcome !== "resumed") {
          enqueue(heldFailure(503, drainedTurnError()));
          enqueue(DONE_FRAME);
          finish();
          return;
        }
        const response = await run();
        if (closed) {
          await response.body?.cancel().catch(() => {});
          return;
        }
        if (!isEventStream(response) || !response.body) {
          for (const chunk of await framesForJsonResponse(response)) enqueue(chunk);
          enqueue(DONE_FRAME);
          finish();
          return;
        }
        upstream = response.body.getReader();
        for (;;) {
          await waitForCapacity();
          if (closed) {
            await upstream.cancel().catch(() => {});
            return;
          }
          const chunk = await upstream.read();
          if (chunk.done) break;
          enqueue(chunk.value);
        }
        finish();
      })().catch(error => {
        enqueue(heldFailure(500, classifyError(500, "proxy_error", error instanceof Error ? error.message : String(error))));
        enqueue(DONE_FRAME);
        finish();
      });
    },
    cancel(reason) {
      closed = true;
      stopHeartbeat();
      waitAbort.abort(reason);
      void upstream?.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
