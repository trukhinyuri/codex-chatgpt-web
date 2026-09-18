import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig } from "../src/config";
import { DRAINING_MESSAGE } from "../src/drain-gate";
import {
  adapterFailureFromMessage,
  classifyError,
  codexStreamError,
  CODEX_TERMINAL_STREAM_ERROR_CODES,
  withCodexRetryAfter,
} from "../src/lib/errors";
import { responseRequest } from "../src/server";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";
import {
  codex0154ResponseFailed,
  codexTryParseRetryAfterMs,
  failedResponse,
  parseSseFrames,
  runCodex0154Turn,
  type CodexErrorVariant,
  type CodexStreamOutcome,
} from "./support/codex-0154";

afterEach(() => {
  setSystemTime();
});

function quietWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

async function streamed(events: AdapterEvent[], options: { responseId?: string } = {}): Promise<string> {
  async function* source(): AsyncGenerator<AdapterEvent> {
    for (const event of events) yield event;
  }
  const stream = bridgeToResponsesSSE(
    source(),
    "chatgpt-web/high",
    undefined,
    undefined,
    undefined,
    undefined,
    60_000,
    options.responseId ? { responseId: options.responseId } : undefined,
  );
  return await new Response(stream).text();
}

async function codexReadsFailure(event: AdapterEvent): Promise<{ error: Record<string, unknown>; outcome: CodexStreamOutcome }> {
  const response = failedResponse(parseSseFrames(await streamed([event])));
  if (!response) throw new Error("the bridge stream carried no response.failed frame");
  return { error: response.error as Record<string, unknown>, outcome: codex0154ResponseFailed(response) };
}

// ---------------------------------------------------------------------------------------------
// The copy of Codex 0.154 reproduces Codex's own test vectors (codex-api/src/sse/responses.rs tests).
// ---------------------------------------------------------------------------------------------

test("the Codex 0.154 copy reproduces Codex's own response.failed vectors", () => {
  const rows: Array<[{ code?: string; message?: string }, CodexErrorVariant, boolean, number | undefined]> = [
    [{ code: "rate_limit_exceeded", message: "Rate limit reached for gpt-5.1 in organization org-AAA on tokens per min (TPM): Limit 30000, Used 22999, Requested 12528. Please try again in 11.054s. Visit https://platform.openai.com/account/rate-limits to learn more." }, "RateLimitExceeded", true, 11_054],
    [{ code: "rate_limit_exceeded", message: "Rate limit reached. Please try again in 28ms." }, "RateLimitExceeded", true, 28],
    [{ code: "rate_limit_exceeded", message: "Please try again in 1.898s." }, "RateLimitExceeded", true, 1_898],
    [{ code: "rate_limit_exceeded", message: "Temporary limit." }, "RateLimitExceeded", true, undefined],
    [{ code: "rate_limit_exceeded", message: "Try again in 5 minutes." }, "RateLimitExceeded", true, undefined],
    [{ code: "context_length_exceeded", message: "Your input exceeds the context window of this model." }, "ContextWindowExceeded", false, undefined],
    [{ code: "insufficient_quota", message: "You exceeded your current quota." }, "QuotaExceeded", false, undefined],
    [{ code: "usage_not_included" }, "UsageNotIncluded", false, undefined],
    [{ code: "cyber_policy", message: "This request was flagged for cyber policy." }, "CyberPolicy", false, undefined],
    [{ code: "misalignment_policy_violation", message: "This request violated the misalignment policy." }, "MisalignmentPolicyViolation", false, undefined],
    [{ code: "invalid_prompt", message: "Invalid prompt: we've limited access to this content for safety reasons." }, "InvalidRequest", false, undefined],
    [{ code: "bio_policy", message: "This content was flagged for possible biological risk." }, "InvalidRequest", false, undefined],
    [{ code: "server_is_overloaded", message: "anything" }, "ServerOverloaded", false, undefined],
    [{ code: "slow_down", message: "Please try again in 10s." }, "ServerOverloaded", false, undefined],
    // Any other code is retried with backoff; a delay in its message is not read.
    [{ code: "upstream_server_error", message: "Please try again in 30s." }, "Stream", true, undefined],
    [{ code: "chatgpt_submission_ambiguous", message: "did not confirm" }, "Stream", true, undefined],
    [{}, "Stream", true, undefined],
  ];
  for (const [error, variant, retryable, delayMs] of rows) {
    const outcome = codex0154ResponseFailed({ error });
    expect({ code: error.code, variant: outcome.variant, retryable: outcome.retryable, delayMs: outcome.delayMs })
      .toEqual({ code: error.code, variant, retryable, delayMs });
  }
  expect(codex0154ResponseFailed({ error: { code: "invalid_prompt", message: "shown as is" } }).shown).toBe("shown as is");
  expect(codex0154ResponseFailed({ error: { code: "server_is_overloaded", message: "lost" } }).shown)
    .toBe("Selected model is at capacity. Please try a different model.");
  // An unknown extra field does not break deserialization (struct Error has no deny_unknown_fields).
  expect(codex0154ResponseFailed({ error: { code: "invalid_prompt", message: "m", bridge_code: "x" } }).variant)
    .toBe("InvalidRequest");
  expect(codexTryParseRetryAfterMs("rate_limit_exceeded", "try again in 2 seconds")).toBe(2_000);
  expect(codexTryParseRetryAfterMs("slow_down", "try again in 2 seconds")).toBeUndefined();
});

test("the bridge's terminal code list is exactly Codex 0.154's non-retried codes that keep the turn's meaning", () => {
  for (const code of CODEX_TERMINAL_STREAM_ERROR_CODES) {
    expect(codex0154ResponseFailed({ error: { code, message: "m" } }).retryable).toBe(false);
  }
  // Also non-retried, but with a fixed text that drops the bridge's message: never a terminal target.
  expect(CODEX_TERMINAL_STREAM_ERROR_CODES.has("server_is_overloaded")).toBe(false);
  expect(CODEX_TERMINAL_STREAM_ERROR_CODES.has("slow_down")).toBe(false);
});

// ---------------------------------------------------------------------------------------------
// Bridge failure -> what Codex 0.154 does with the response.failed frame the bridge streams.
// ---------------------------------------------------------------------------------------------

const DID_NOT_CONFIRM = "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing.";

interface ContractRow {
  name: string;
  event: AdapterEvent;
  variant: CodexErrorVariant;
  delayMs?: number;
  /** The message Codex shows, when it must be the bridge's own text. */
  shown?: string;
  /** The bridge code the frame must keep when the wire code differs. */
  bridgeCode?: string | null;
}

const contractRows: ContractRow[] = [
  {
    name: "a submission ChatGPT did not confirm ends once with the bridge's text",
    event: { type: "error", message: DID_NOT_CONFIRM, status: 502, errorType: "server_error", code: "chatgpt_submission_ambiguous", retryable: false },
    variant: "InvalidRequest",
    shown: DID_NOT_CONFIRM,
    bridgeCode: "chatgpt_submission_ambiguous",
  },
  {
    name: "a submitted turn that stopped responding ends once",
    event: { type: "error", message: "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.", status: 502, errorType: "server_error", code: "chatgpt_submitted_turn_failed", retryable: false },
    variant: "InvalidRequest",
    bridgeCode: "chatgpt_submitted_turn_failed",
  },
  {
    name: "a missing connector ends once instead of five replayed reconnects",
    event: { type: "error", message: "ChatGPT did not list the Codex Native2 connector.", status: 424, errorType: "invalid_request_error", code: "connector_not_found", retryable: false },
    variant: "InvalidRequest",
    bridgeCode: "connector_not_found",
  },
  {
    name: "a spent retry budget ends once even though its last cause was a rate limit",
    event: { type: "error", message: "ChatGPT rate limit: too many requests. Please try again in 60s. ChatGPT remained unavailable after several attempts.", status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false },
    variant: "InvalidRequest",
    bridgeCode: "rate_limit_exceeded",
  },
  {
    name: "a terminal failure worded like capacity keeps its own message",
    event: { type: "error", message: "The ChatGPT browser helper stopped reporting progress.", status: 503, errorType: "server_error", code: "server_is_overloaded", retryable: false },
    variant: "InvalidRequest",
    shown: "The ChatGPT browser helper stopped reporting progress.",
    bridgeCode: "server_is_overloaded",
  },
  {
    name: "a context overflow keeps Codex's own context handling",
    event: { type: "error", message: "This task exceeds the context window.", status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    variant: "ContextWindowExceeded",
  },
  {
    name: "a ChatGPT rate limit with a stated delay is waited out",
    event: { type: "error", message: "ChatGPT rate limit: too many requests. Please try again in 42s.", status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
    variant: "RateLimitExceeded",
    delayMs: 42_000,
  },
  {
    name: "'Something went wrong' before Send keeps Codex's retry",
    event: { type: "error", message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.", status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
    variant: "Stream",
  },
  {
    name: "a retryable ChatGPT page that is briefly unavailable pauses before the retry",
    event: { type: "error", message: "ChatGPT did not show the subscription. Reload ChatGPT and retry.", status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
    variant: "RateLimitExceeded",
    delayMs: 10_000,
    bridgeCode: "chatgpt_subscription_unavailable",
  },
  {
    name: "a retryable capacity code never ends the turn with 'try a different model'",
    event: { type: "error", message: "Selected model is at capacity. Please try a different model.", status: 503, errorType: "server_error", code: "server_is_overloaded", retryable: true },
    variant: "RateLimitExceeded",
    delayMs: 10_000,
    bridgeCode: "server_is_overloaded",
  },
  {
    name: "the launcher's browser host being unavailable pauses before the retry",
    event: { type: "error", message: "Launcher browser host is unavailable: descriptor is missing" },
    variant: "RateLimitExceeded",
    delayMs: 10_000,
    bridgeCode: "service_unavailable",
  },
  {
    name: "ChatGPT model controls that are not loaded yet pause before the retry",
    event: { type: "error", message: "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task." },
    variant: "RateLimitExceeded",
    delayMs: 10_000,
    bridgeCode: "service_unavailable",
  },
  {
    name: "the local turn broker being unavailable pauses before the retry",
    event: { type: "error", message: "ChatGPT web turn broker unavailable: connect ENOENT" },
    variant: "RateLimitExceeded",
    delayMs: 10_000,
  },
  {
    name: "a stated delay in an unavailable message is kept",
    event: { type: "error", message: "The service is temporarily unavailable, retry after 25 seconds" },
    variant: "RateLimitExceeded",
    delayMs: 25_000,
  },
  {
    name: "an unclassified bridge error keeps Codex's quick retry",
    event: { type: "error", message: "ChatGPT tool bridge returned an empty batch" },
    variant: "Stream",
  },
];

for (const row of contractRows) {
  test(`Codex 0.154 contract: ${row.name}`, async () => {
    const warnings = quietWarnings();
    try {
      const { error, outcome } = await codexReadsFailure(row.event);
      expect(outcome.variant).toBe(row.variant);
      expect(outcome.variant).not.toBe("ServerOverloaded");
      if (row.delayMs !== undefined) expect(outcome.delayMs).toBe(row.delayMs);
      if (row.shown !== undefined) expect(outcome.shown).toBe(row.shown);
      if (row.bridgeCode !== undefined) expect(error.bridge_code).toBe(row.bridgeCode);
      if (row.event.type === "error" && row.event.retryable === false) expect(outcome.retryable).toBe(false);
      if (row.event.type === "error" && row.event.retryable === true) expect(outcome.retryable).toBe(true);
    } finally {
      warnings.restore();
    }
  });
}

test("local unavailability and a drain never classify as server_is_overloaded", () => {
  for (const message of [
    "Launcher browser host is unavailable: descriptor is missing",
    "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.",
    "ChatGPT web login is expired or the Temporary Chat surface is unavailable",
    "ChatGPT web turn broker unavailable: connect ENOENT",
  ]) {
    const inferred = adapterFailureFromMessage(message);
    expect(inferred.httpStatus).toBe(503);
    expect(inferred.error.code).toBe("service_unavailable");
    const wire = codexStreamError(inferred.error, { httpStatus: inferred.httpStatus });
    expect(wire.code).toBe("rate_limit_exceeded");
    expect(codex0154ResponseFailed({ error: wire })).toMatchObject({ variant: "RateLimitExceeded", delayMs: 10_000 });
  }
  expect(classifyError(503, "server_error", DRAINING_MESSAGE).code).toBe("service_unavailable");
  // A provider's own capacity wording still names capacity in the bridge's classification.
  expect(classifyError(502, "upstream_error", "upstream model is overloaded").code).toBe("server_is_overloaded");
});

test("a delay is appended once in the form Codex reads", () => {
  expect(withCodexRetryAfter("Busy.", 10)).toBe("Busy. Please try again in 10s.");
  expect(withCodexRetryAfter("Busy", 10)).toBe("Busy. Please try again in 10s.");
  expect(withCodexRetryAfter("Busy. Please try again in 3s.", 10)).toBe("Busy. Please try again in 3s.");
  expect(withCodexRetryAfter("Busy, retry after 7 seconds", 10)).toBe("Busy, retry after 7 seconds. Please try again in 7s.");
});

// ---------------------------------------------------------------------------------------------
// SSE snapshot and journal.
// ---------------------------------------------------------------------------------------------

test("SSE snapshot: a bridge-terminal failure streams invalid_prompt and keeps the bridge code", async () => {
  setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
  const warnings = quietWarnings();
  let text: string;
  try {
    text = await streamed([{
      type: "error",
      message: DID_NOT_CONFIRM,
      status: 502,
      errorType: "server_error",
      code: "chatgpt_submission_ambiguous",
      retryable: false,
    }], { responseId: "resp_snapshot" });
  } finally {
    warnings.restore();
  }
  const error = `{"message":"${DID_NOT_CONFIRM}","type":"server_error","code":"invalid_prompt","bridge_code":"chatgpt_submission_ambiguous"}`;
  expect(text).toBe(
    'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_snapshot","object":"response","created_at":1789732800,"status":"in_progress","model":"chatgpt-web/high","output":[],"usage":null}}\n\n'
    + `event: response.failed\ndata: {"type":"response.failed","sequence_number":1,"response":{"id":"resp_snapshot","object":"response","created_at":1789732800,"status":"failed","model":"chatgpt-web/high","output":[],"usage":null,"error":${error},"last_error":${error},"retryable":false}}\n\n`
    + "data: [DONE]\n\n",
  );
  // The journal names both codes and never the message text.
  expect(warnings.lines).toEqual([
    '[bridge] response_failed {"model":"chatgpt-web/high","response":"resp_snapshot","status":502,"code":"invalid_prompt","bridge_code":"chatgpt_submission_ambiguous","retryable":false}',
  ]);
});

test("SSE snapshot: a paced retry names the delay Codex reads and the bridge's code", async () => {
  setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
  const warnings = quietWarnings();
  let text: string;
  try {
    text = await streamed([{ type: "error", message: "Launcher browser host is unavailable: descriptor is missing" }], { responseId: "resp_paced" });
  } finally {
    warnings.restore();
  }
  const failed = parseSseFrames(text).find(frame => frame.event === "response.failed")!;
  expect(failed.data).toBe(
    '{"type":"response.failed","sequence_number":1,"response":{"id":"resp_paced","object":"response","created_at":1789732800,"status":"failed","model":"chatgpt-web/high","output":[],"usage":null,'
    + '"error":{"message":"Launcher browser host is unavailable: descriptor is missing. Please try again in 10s.","type":"server_error","code":"rate_limit_exceeded","bridge_code":"service_unavailable"},'
    + '"last_error":{"message":"Launcher browser host is unavailable: descriptor is missing. Please try again in 10s.","type":"server_error","code":"rate_limit_exceeded","bridge_code":"service_unavailable"}}}',
  );
  expect(warnings.lines).toEqual([
    '[bridge] response_failed {"model":"chatgpt-web/high","response":"resp_paced","status":503,"code":"rate_limit_exceeded","bridge_code":"service_unavailable"}',
  ]);
});

// ---------------------------------------------------------------------------------------------
// A stored terminal failure: one answer for Codex, no new browser turn.
// ---------------------------------------------------------------------------------------------

test("after 'did not confirm' Codex receives one terminal answer and no new browser turn opens", async () => {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://codex-contract-did-not-confirm-${nonce}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    turn.onSendActivated?.();
    throw new Error("submission evidence disappeared after Send activation");
  };
  const threadId = `thread_contract_${nonce}`;
  const turnId = `turn_contract_${nonce}`;
  const body = JSON.stringify({
    model: "chatgpt-web/high",
    stream: true,
    prompt_cache_key: threadId,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Inspect the project" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }],
  });
  const send = () => responseRequest(
    new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body,
    }),
    defaultConfig("browser-only"),
    () => createChatGptWebAdapter(provider),
    { rememberState: false },
  );
  const warnings = quietWarnings();
  try {
    const turn = await runCodex0154Turn(send);
    expect(turn.requests).toBe(1);
    expect(turn.completed).toBe(false);
    expect(turn.final).toEqual({ variant: "InvalidRequest", retryable: false, shown: DID_NOT_CONFIRM });
    expect(browserStarts).toBe(1);

    // A reconnect of the same request replays the stored failure: the same terminal frame, still
    // without another browser turn.
    const replayed = failedResponse(parseSseFrames(await (await send()).text()));
    expect(replayed?.error).toEqual({
      message: DID_NOT_CONFIRM,
      type: "server_error",
      code: "invalid_prompt",
      bridge_code: "chatgpt_submission_ambiguous",
    });
    expect(browserStarts).toBe(1);
    expect(warnings.lines.filter(line => line.startsWith("[bridge] response_failed")).length).toBe(2);
  } finally {
    warnings.restore();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
  }
});
