/**
 * A copy of how Codex 0.154 (openai/codex tag rust-v0.154.0) reads a streamed `response.failed`
 * and decides whether to retry it. Keep it a literal port; when Codex changes, update it from:
 * - codex-rs/codex-api/src/sse/responses.rs: the `"response.failed"` arm of process_responses_event,
 *   try_parse_retry_after, rate_limit_regex, is_*_error, struct Error (no deny_unknown_fields);
 * - codex-rs/codex-api/src/api_bridge.rs: map_api_error (ApiError -> CodexErr);
 * - codex-rs/protocol/src/error.rs: CodexErrorDetails Display strings and is_retryable;
 * - codex-rs/core/src/session/turn.rs + responses_retry.rs: a non-retryable error ends the turn, a
 *   retryable one is retried up to stream_max_retries (default 5, model-provider-info) after
 *   `err.retry_delay()` or backoff(n) = 200 ms · 2^(n-1) ±10% (core/src/util.rs).
 * 0.155.0-alpha.9 differs in one place: slow_down joins rate_limit_exceeded (retryable, delay read).
 */

export type CodexErrorVariant =
  | "ContextWindowExceeded"
  | "QuotaExceeded"
  | "UsageNotIncluded"
  | "CyberPolicy"
  | "MisalignmentPolicyViolation"
  | "InvalidRequest"
  | "ServerOverloaded"
  | "RateLimitExceeded"
  | "Stream";

export interface CodexStreamOutcome {
  variant: CodexErrorVariant;
  /** CodexErr::is_retryable. */
  retryable: boolean;
  /** CodexErr::retry_delay, in milliseconds. */
  delayMs?: number;
  /** What Codex shows (Display of the CodexErr). */
  shown: string;
}

export const CODEX_STREAM_MAX_RETRIES = 5;

const RATE_LIMIT_REGEX = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i;

/** try_parse_retry_after: only rate_limit_exceeded carries a delay Codex 0.154 reads. */
export function codexTryParseRetryAfterMs(code: string | undefined, message: string | undefined): number | undefined {
  if (code !== "rate_limit_exceeded") return undefined;
  const captures = message === undefined ? null : RATE_LIMIT_REGEX.exec(message);
  if (!captures) return undefined;
  const value = Number.parseFloat(captures[1]!);
  if (!Number.isFinite(value)) return undefined;
  const unit = captures[2]!.toLowerCase();
  if (unit === "s" || unit.startsWith("second")) return value * 1_000;
  if (unit === "ms") return Math.trunc(value);
  return undefined;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : null;
}

/** The `"response.failed"` arm plus map_api_error, is_retryable and Display. */
export function codex0154ResponseFailed(response: unknown): CodexStreamOutcome {
  const streamFailure = (message: string, delayMs?: number): CodexStreamOutcome => ({
    variant: "Stream",
    retryable: true,
    ...(delayMs !== undefined ? { delayMs } : {}),
    shown: `stream disconnected before completion: ${message}`,
  });
  const raw = response && typeof response === "object" ? (response as { error?: unknown }).error : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return streamFailure("response.failed event received");
  const fields = raw as Record<string, unknown>;
  const code = optionalString(fields.code);
  const message = optionalString(fields.message);
  const type = optionalString(fields.type);
  // serde_json::from_value::<Error> fails on a wrongly typed field; Codex then keeps the generic error.
  if (code === null || message === null || type === null) return streamFailure("response.failed event received");

  if (code === "context_length_exceeded") {
    return {
      variant: "ContextWindowExceeded",
      retryable: false,
      shown: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    };
  }
  if (code === "insufficient_quota") {
    return { variant: "QuotaExceeded", retryable: false, shown: "Quota exceeded. Check your plan and billing details." };
  }
  if (code === "usage_not_included") {
    return {
      variant: "UsageNotIncluded",
      retryable: false,
      shown: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
    };
  }
  if (code === "cyber_policy") {
    return {
      variant: "CyberPolicy",
      retryable: false,
      shown: message && message.trim() ? message : "This request has been flagged for possible cybersecurity risk.",
    };
  }
  if (code === "misalignment_policy_violation") {
    return {
      variant: "MisalignmentPolicyViolation",
      retryable: false,
      shown: message && message.trim() ? message : "This request was blocked due to a misalignment policy violation.",
    };
  }
  if (code === "invalid_prompt" || code === "bio_policy") {
    return { variant: "InvalidRequest", retryable: false, shown: message ?? "Invalid request." };
  }
  if (code === "server_is_overloaded" || code === "slow_down") {
    return { variant: "ServerOverloaded", retryable: false, shown: "Selected model is at capacity. Please try a different model." };
  }
  const delayMs = codexTryParseRetryAfterMs(code, message);
  if (code === "rate_limit_exceeded") {
    return {
      variant: "RateLimitExceeded",
      retryable: true,
      ...(delayMs !== undefined ? { delayMs } : {}),
      shown: `rate limit exceeded: ${message ?? ""}`,
    };
  }
  return streamFailure(message ?? "", delayMs);
}

/** backoff(n) without its ±10% jitter. */
export function codexBackoffMs(attempt: number): number {
  return 200 * 2 ** Math.max(0, attempt - 1);
}

export interface SseFrame {
  event?: string;
  data: string;
}

export function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data.push(line.slice("data: ".length));
    }
    frames.push({ ...(event !== undefined ? { event } : {}), data: data.join("\n") });
  }
  return frames;
}

/** The `response` of the stream's response.failed frame, if it has one. */
export function failedResponse(frames: SseFrame[]): Record<string, unknown> | undefined {
  const failed = frames.find(frame => frame.event === "response.failed");
  if (!failed) return undefined;
  return (JSON.parse(failed.data) as { response: Record<string, unknown> }).response;
}

export interface CodexTurnResult {
  requests: number;
  completed: boolean;
  final?: CodexStreamOutcome;
  delaysMs: number[];
}

/**
 * Codex 0.154's sampling loop around one turn: send, read the stream, and retry a retryable
 * failure up to CODEX_STREAM_MAX_RETRIES times. Delays are recorded, not slept.
 */
export async function runCodex0154Turn(send: () => Promise<Response>): Promise<CodexTurnResult> {
  const delaysMs: number[] = [];
  let retries = 0;
  for (let requests = 1; ; requests += 1) {
    const frames = parseSseFrames(await (await send()).text());
    if (frames.some(frame => frame.event === "response.completed")) return { requests, completed: true, delaysMs };
    const failed = failedResponse(frames);
    // Without response.failed the stream ended early ("stream closed before response.completed")
    // or incomplete; both are ApiError::Stream, retried with backoff.
    const outcome: CodexStreamOutcome = failed
      ? codex0154ResponseFailed(failed)
      : { variant: "Stream", retryable: true, shown: "stream disconnected before completion: stream closed before response.completed" };
    if (!outcome.retryable || retries >= CODEX_STREAM_MAX_RETRIES) {
      return { requests, completed: false, final: outcome, delaysMs };
    }
    retries += 1;
    delaysMs.push(outcome.delayMs ?? codexBackoffMs(retries));
  }
}
