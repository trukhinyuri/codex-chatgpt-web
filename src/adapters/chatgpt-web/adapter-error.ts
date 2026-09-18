export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

/**
 * Finds a ChatGPT rate limit behind a wrapped failure. Compaction reports its own handoff error,
 * but a throttled handoff must keep the rate-limit code and retry delay so Codex waits it out.
 */
export function chatGptRateLimitCause(error: unknown, depth = 0): ChatGptWebAdapterError | undefined {
  if (depth > 4 || !(error instanceof Error)) return undefined;
  if (error instanceof ChatGptWebAdapterError && error.code === "rate_limit_exceeded") return error;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = chatGptRateLimitCause(inner, depth + 1);
      if (found) return found;
    }
  }
  return chatGptRateLimitCause(error.cause, depth + 1);
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A newer Codex instruction superseded this ChatGPT response.",
    { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}

// An abort says the turn stopped; `signal.reason` says why. Every abort path used to throw a fresh
// AbortError and drop the reason, so a turn retired by the Codex side and a turn ChatGPT really
// abandoned arrived at the reporter identically — and the one message they shared blamed ChatGPT.
const CHATGPT_TURN_RETIRED = Symbol.for("codex-chatgpt-web.chatgpt-turn-retired");

/** Mark the error that ends a turn because its Codex-side binding went away. */
export function chatGptTurnRetiredError(message: string, options?: { cause?: unknown }): Error {
  const error = new Error(message, options?.cause === undefined ? undefined : { cause: options.cause });
  Object.defineProperty(error, CHATGPT_TURN_RETIRED, { value: true });
  return error;
}

/** True when this error, or anything it was caused by, is a Codex-side turn retirement. */
export function isChatGptTurnRetired(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as Record<symbol, unknown>)[CHATGPT_TURN_RETIRED] === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The abort error for a turn, carrying `signal.reason` as its `cause` so the real reason survives
 * to `submittedTurnFailure()` without disturbing the "ChatGPT web turn aborted" message or the
 * AbortError name that the abort contract and existing message-based assertions depend on.
 * DOMException takes no `cause` option, so it is attached separately.
 */
export function chatGptTurnAbortError(signal?: AbortSignal): DOMException {
  const error = new DOMException("ChatGPT web turn aborted", "AbortError");
  const reason: unknown = signal?.reason;
  if (reason !== undefined && reason !== null && reason !== error) {
    Object.defineProperty(error, "cause", { value: reason, configurable: true, writable: true });
  }
  return error;
}
