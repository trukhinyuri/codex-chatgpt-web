import { chatGptWebTraceId, createChatGptWebAdapter } from "./adapters/chatgpt-web";
import { closeChatGptBrowserWorkers, validateChatGptWebInputImage } from "./adapters/chatgpt-web/browser-worker";
import { chatGptWebAttachedInputImages } from "./adapters/chatgpt-web/prompt";
import { closeTurnBrokers, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { timingSafeEqual } from "node:crypto";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import {
  cancelAllStructuredCompactions,
  cancelStructuredCompactionNativeTurn,
  cancelStructuredCompactionTrace,
} from "./adapters/chatgpt-web/compaction-handoff";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "./adapters/chatgpt-web/adapter-error";
import {
  CHATGPT_TURN_REVISION_CONFLICT_MESSAGE,
  extractChatGptTurnIdentity,
  extractCodexTurnIdentityFromBody,
  extractChatGptCompactionSourceRevision,
  chatGptTurnUserRevisionHistory,
} from "./adapters/chatgpt-web/environment";
import { bindCompactionContinuationStore, ChatGptCompactionContinuationStore, rememberCompactionContinuation } from "./adapters/chatgpt-web/compaction-continuation";
import { rememberRetryableTurnFailure } from "./adapters/chatgpt-web/retry-continuation";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { defaultCompactionContinuationStatePath, providerConfig } from "./config";
import {
  DRAIN_HOLD_MS,
  DRAINING_MESSAGE,
  DrainGate,
  drainedHttpResponse,
  heldStreamingResponse,
} from "./drain-gate";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { httpStatusFromTerminalError } from "./lib/errors";
import { createHash } from "node:crypto";
import { augmentNativeModelCatalog } from "./model-catalog";
import {
  readCodexModelContextOverride,
  readCodexSubagentProtocol,
  type CodexModelContextOverride,
} from "./codex-integration";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import {
  forwardNativeCodexRequest,
  nativeModelsClientVersion,
  type NativeFetch,
  type NativeImageEndpoint,
} from "./native-passthrough";
import { fetchNativeCodex, nativeFailureOrigin, type NativeFailureOrigin } from "./native-network";
import { NativeModelCatalogLastGood, nativeModelCatalogKey } from "./model-catalog-cache";
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  decodeCompactionSummary,
  extractCompactUserMessages,
} from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import type { CodexProviderConfig } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { VERSION } from "./version";
import {
  augmentCatalogWithCliProxy,
  cliProxyRouteFor,
  compactViaCliProxy,
  compactionTurnViaCliProxy,
  forwardCliProxyResponses,
  type CliProxyConnection,
  type CliProxyFetch,
} from "./cliproxy";

type HttpTrackedEndpoint = "models" | "responses" | "compact" | "search" | "unspecified" | NativeImageEndpoint;

export interface NativeCodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export interface HttpStreamFailureEvidence {
  httpTurnId: number;
  endpoint: HttpTrackedEndpoint;
  reader: "client" | "windows_lifecycle";
  platform: NodeJS.Platform;
  chunks: number;
  bytes: number;
  errorName: string;
  errorCode: string;
}

type HttpStreamFailureReporter = (evidence: HttpStreamFailureEvidence) => void;

function safeStreamErrorField(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : fallback;
}

function streamFailureEvidence(
  error: unknown,
  httpTurnId: number,
  endpoint: HttpTrackedEndpoint,
  reader: HttpStreamFailureEvidence["reader"],
  platform: NodeJS.Platform,
  chunks: number,
  bytes: number,
): HttpStreamFailureEvidence {
  const candidate = error !== null && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : {};
  return {
    httpTurnId,
    endpoint,
    reader,
    platform,
    chunks,
    bytes,
    errorName: safeStreamErrorField(candidate.name, "Error"),
    errorCode: safeStreamErrorField(candidate.code, "unknown"),
  };
}

const reportHttpStreamFailure: HttpStreamFailureReporter = evidence => {
  console.warn(`[codex-chatgpt-web] http_stream_failed ${JSON.stringify(evidence)}`);
};

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Grace for held turns' last frames to leave before shutdown closes their connections. */
const HELD_TURN_SHUTDOWN_FLUSH_MS = 250;

/** Codex asks for every Responses turn as a stream (codex-api endpoint/responses.rs sets Accept). */
function acceptsEventStream(req: Request): boolean {
  return (req.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * Reject a request whose Host header does not name this loopback bridge, and, for a browser
 * request, whose Origin does not match it either. A hostile web page can point a hostname it
 * controls at 127.0.0.1 after the browser's initial DNS lookup (DNS rebinding); the Host header
 * still names that hostname, and the Origin header still names the page's real origin, so both are
 * checked against the loopback set and the port this server actually bound. Codex CLI/Desktop send
 * no Origin header at all and are accepted on Host alone. A Host header with no port (never sent by
 * a real HTTP client talking to a non-default port, only ever seen from a hand-built request) is
 * accepted on hostname alone rather than compared to a default port that would never match.
 */
function isLoopbackRequest(url: URL, req: Request, boundPort: number): boolean {
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
  if (url.port !== "" && Number(url.port) !== boundPort) return false;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    const parsedOrigin = new URL(origin);
    const originPort = parsedOrigin.port === "" ? 80 : Number(parsedOrigin.port);
    return parsedOrigin.protocol === "http:"
      && LOOPBACK_HOSTNAMES.has(parsedOrigin.hostname)
      && originPort === boundPort;
  } catch {
    return false;
  }
}

function emitHttpStreamFailure(
  reporter: HttpStreamFailureReporter,
  evidence: HttpStreamFailureEvidence,
): void {
  try {
    reporter(evidence);
  } catch {
    // Diagnostics are a side channel: they must never replace the source stream error or retain
    // HTTP turn ownership after the client has already observed that failure.
  }
}

export class HttpTurnCounter {
  private readonly active = new Map<number, {
    abort: AbortController;
    done: Promise<void>;
    finish: () => void;
    identity?: NativeCodexTurnIdentity;
  }>();
  private readonly interrupted = new Map<string, unknown>();
  private nextId = 1;

  private identityKey(identity: NativeCodexTurnIdentity): string {
    return `${identity.threadId}\u0000${identity.turnId}`;
  }

  private rememberInterrupted(identity: NativeCodexTurnIdentity, reason: unknown): void {
    const key = this.identityKey(identity);
    this.interrupted.delete(key);
    this.interrupted.set(key, reason);
    while (this.interrupted.size > 1_024) {
      const oldest = this.interrupted.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.interrupted.delete(oldest);
    }
  }

  constructor(private readonly reportStreamFailure: HttpStreamFailureReporter = reportHttpStreamFailure) {}

  count(): number {
    return this.active.size;
  }

  async cancelAll(reason: unknown = new Error("Active HTTP turns cancelled")): Promise<number> {
    const turns = [...this.active.values()];
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    await Promise.all(turns.map(turn => turn.done));
    return turns.length;
  }

  async cancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): Promise<number> {
    const cancellation = this.beginCancelTurn(identity, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  beginCancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): { cancelled: number; settlement: Promise<void> } {
    this.rememberInterrupted(identity, reason);
    const turns = [...this.active.values()].filter(turn => (
      turn.identity?.threadId === identity.threadId && turn.identity.turnId === identity.turnId
    ));
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    return {
      cancelled: turns.length,
      settlement: Promise.all(turns.map(turn => turn.done)).then(() => undefined),
    };
  }

  async track(
    run: (
      signal: AbortSignal,
      bindIdentity: (identity: NativeCodexTurnIdentity) => void,
    ) => Promise<Response>,
    clientSignal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
    endpoint: HttpTrackedEndpoint = "unspecified",
  ): Promise<Response> {
    const id = this.nextId++;
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const tracked: {
      abort: AbortController;
      done: Promise<void>;
      finish: () => void;
      identity?: NativeCodexTurnIdentity;
    } = { abort, done, finish };
    this.active.set(id, tracked);
    let released = false;
    let clientAbortListener: (() => void) | undefined;
    let streamAbortListener: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active.delete(id);
      if (clientSignal && clientAbortListener) {
        clientSignal.removeEventListener("abort", clientAbortListener);
        clientAbortListener = undefined;
      }
      if (streamAbortListener) abort.signal.removeEventListener("abort", streamAbortListener);
      finish();
    };
    clientAbortListener = () => abort.abort(clientSignal?.reason);
    if (clientSignal?.aborted) abort.abort(clientSignal.reason);
    else clientSignal?.addEventListener("abort", clientAbortListener, { once: true });

    try {
      const response = await run(abort.signal, identity => {
        if (!identity.threadId.trim() || !identity.turnId.trim()) {
          throw new Error("Native Codex turn identity must contain a threadId and turnId");
        }
        if (tracked.identity
          && (tracked.identity.threadId !== identity.threadId || tracked.identity.turnId !== identity.turnId)) {
          throw new Error("An HTTP request cannot change its native Codex turn identity");
        }
        tracked.identity = identity;
        const interruptedReason = this.interrupted.get(this.identityKey(identity));
        if (interruptedReason !== undefined && !abort.signal.aborted) abort.abort(interruptedReason);
      });
      if (!response.body) {
        release();
        return response;
      }
      if (abort.signal.aborted) {
        await response.body.cancel(abort.signal.reason).catch(() => {});
        release();
        return new Response(null, { status: 499, statusText: "Client Closed Request" });
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        const reportStreamFailure = this.reportStreamFailure;
        let chunks = 0;
        let bytes = 0;
        streamAbortListener = () => {
          void reader.cancel(abort.signal.reason).catch(() => {}).finally(release);
        };
        abort.signal.addEventListener("abort", streamAbortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              chunks += 1;
              bytes += chunk.value.byteLength;
              controller.enqueue(chunk.value);
            } catch (error) {
              if (!abort.signal.aborted) {
                emitHttpStreamFailure(reportStreamFailure, streamFailureEvidence(
                  error,
                  id,
                  endpoint,
                  "client",
                  platform,
                  chunks,
                  bytes,
                ));
              }
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Windows-safe Bun#32111 shape: the client gets a native tee branch,
      // never a JS ReadableStream with async pull(). The second branch is consumed only
      // to observe completion. The request signal releases lifecycle ownership immediately
      // when the client disconnects and cancels the observer branch.
      const [clientBody, lifecycleBody] = response.body.tee();
      const reader = lifecycleBody.getReader();
      let chunks = 0;
      let bytes = 0;
      streamAbortListener = () => {
        void Promise.allSettled([
          reader.cancel(abort.signal.reason),
          clientBody.cancel(abort.signal.reason),
        ]).finally(release);
      };
      abort.signal.addEventListener("abort", streamAbortListener, { once: true });
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            chunks += 1;
            bytes += chunk.value.byteLength;
            // Consume eagerly so the lifecycle branch never backpressures the client branch.
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            emitHttpStreamFailure(this.reportStreamFailure, streamFailureEvidence(
              error,
              id,
              endpoint,
              "windows_lifecycle",
              platform,
              chunks,
              bytes,
            ));
          }
          // Stream failure is delivered to the client branch; lifecycle cleanup stays best-effort.
        } finally {
          release();
        }
      })();
      return new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export interface ResponseRequestOptions {
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent) => void;
  /** Bind the physical HTTP stream to the exact native Codex turn that owns it. */
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
  /** Route CLIProxyAPI models; the running server passes its home, direct callers opt in explicitly. */
  cliProxy?: CliProxyWiring;
}

export interface CliProxyWiring {
  home: string;
  fetchImpl?: CliProxyFetch;
}

export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebModelRoute(parsed.modelId, config);
  parsed.modelId = route.backendModel;
  // Zero Risk preserves a distinct backend identity. Its immutable Codex effort is only a
  // protocol/catalog value; the manual adapter must never reinterpret it as a ChatGPT selection.
  parsed.options.reasoning = route.interactionMode === "automatic"
    ? route.adapterEffort
    : route.codexEffort;
  return route;
}

export interface ModelCatalogFailure {
  stage: "config" | "request" | "transport" | "upstream" | "catalog" | "client_aborted";
  code?: string;
  /** The error's own name (AbortError, TimeoutError, TypeError, SyntaxError, Error). */
  name?: string;
  /** Where a transport or catalog failure happened; see NativeFailureOrigin. */
  origin?: NativeFailureOrigin;
  /** The upstream HTTP status of an `upstream` failure. */
  status?: number;
}

const SAFE_FAILURE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_FAILURE_NAME = /^[A-Za-z]{1,40}$/;

/** The innermost error of a wrapped failure: its name says more than the wrapper's. */
function rootError(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const cause = current instanceof Error ? current.cause : undefined;
    if (cause === undefined || cause === null) break;
    current = cause;
  }
  return current;
}

function modelCatalogFailure(
  stage: ModelCatalogFailure["stage"],
  error: unknown,
  origin?: NativeFailureOrigin,
): ModelCatalogFailure {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const root = rootError(error);
  const name = root instanceof Error || root instanceof DOMException
    ? root.name
    : root && typeof root === "object" ? root.constructor?.name : undefined;
  return {
    stage,
    ...(typeof code === "string" && SAFE_FAILURE_CODE.test(code) ? { code } : {}),
    ...(error === undefined ? {} : { name: typeof name === "string" && SAFE_FAILURE_NAME.test(name) ? name : "Error" }),
    ...(origin ? { origin } : {}),
  };
}

/** Codex's whole model refresh, retries included, has a 5-second budget (models_endpoint.rs). */
const MODEL_CATALOG_RETRY_WINDOW_MS = 2_000;
export const MODEL_CATALOG_RETRY_DELAY_MS = 250;
export const MODEL_CATALOG_STALE_HEADER = "x-codex-chatgpt-web-catalog";

export interface ModelCatalogStaleServe {
  failure: ModelCatalogFailure;
  ageSec: number;
  fetchedAtMs: number;
}

export interface ModelCatalogRequestOptions {
  /** The last successful native catalog; without it a failure is returned as before. */
  lastGood?: NativeModelCatalogLastGood;
  onStale?: (stale: ModelCatalogStaleServe) => void;
  /** A failure that the single retry recovered from. */
  onRecovered?: (failure: ModelCatalogFailure) => void;
  retryDelayMs?: number;
}

type NativeCatalogAttempt =
  | { kind: "ok"; raw: Record<string, unknown>; catalog: Record<string, unknown>; upstream: Response }
  | { kind: "status"; upstream: Response; failure: ModelCatalogFailure }
  | { kind: "failure"; failure: ModelCatalogFailure; error: unknown };

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

async function fetchNativeCatalogOnce(
  req: Request,
  config: AppConfig,
  fetchUpstream: NativeFetch | undefined,
  contextOverride: (() => CodexModelContextOverride | undefined) | undefined,
): Promise<NativeCatalogAttempt> {
  let upstream: Response;
  let sent = false;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", input => {
      sent = true;
      return (fetchUpstream ?? fetchNativeCodex)(input);
    });
  } catch (error) {
    return sent
      ? { kind: "failure", failure: modelCatalogFailure("transport", error, nativeFailureOrigin(error) ?? "upstream_fetch"), error }
      : { kind: "failure", failure: modelCatalogFailure("request", error), error };
  }
  if (!upstream.ok) {
    return { kind: "status", upstream, failure: { stage: "upstream", status: upstream.status } };
  }
  let raw: unknown;
  try {
    raw = await upstream.json();
  } catch (error) {
    return { kind: "failure", failure: modelCatalogFailure("catalog", error, "body"), error };
  }
  try {
    const catalog = augmentNativeModelCatalog(raw, config, contextOverride?.());
    return { kind: "ok", raw: raw as Record<string, unknown>, catalog, upstream };
  } catch (error) {
    return { kind: "failure", failure: modelCatalogFailure("catalog", error, "body"), error };
  }
}

/**
 * One quick retry for a failure that may be transient: a transport error, an upstream 5xx, or a
 * catalog body that could not be read. Never for 401/403 (Codex must refresh its own login), 429
 * (the account is being throttled) or any other 4xx, and never once the client has gone.
 */
function retryableAttempt(
  attempt: NativeCatalogAttempt,
): attempt is Exclude<NativeCatalogAttempt, { kind: "ok" }> {
  if (attempt.kind === "ok") return false;
  if (attempt.kind === "status") return attempt.upstream.status >= 500;
  return attempt.failure.stage === "transport" || attempt.failure.stage === "catalog";
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolveSleep => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveSleep();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function catalogResponseHeaders(source: Headers | undefined, body: string): Headers {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  // The upstream load-balancer cookie belongs to chatgpt.com, never to this loopback catalog.
  headers.delete("set-cookie");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return headers;
}

function withoutUpstreamCookies(upstream: Response): Response {
  if (!upstream.headers.has("set-cookie")) return upstream;
  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
  onFailure?: (failure: ModelCatalogFailure) => void,
  cliProxy?: CliProxyWiring,
  options: ModelCatalogRequestOptions = {},
): Promise<Response> {
  const started = Date.now();
  const key = options.lastGood
    ? nativeModelCatalogKey(req.headers, nativeModelsClientVersion(req))
    : undefined;
  const attemptOnce = async (): Promise<NativeCatalogAttempt> => {
    const result = await fetchNativeCatalogOnce(req, config, fetchUpstream, contextOverride);
    // A good catalog is worth keeping even when the client that asked for it has already left.
    if (result.kind === "ok" && key) {
      try {
        options.lastGood!.remember(key, result.raw, result.upstream.headers.get("etag") ?? undefined);
      } catch { /* The fallback is best effort; keeping it never fails a catalog request. */ }
    }
    return result;
  };
  // Only the client's own signal decides that it left: a server-side timeout also surfaces as an
  // abort-like error, and that one is a real failure.
  const clientAborted = (): Response => {
    onFailure?.({ stage: "client_aborted" });
    return formatErrorResponse(499, "client_closed_request", "The client closed the model catalog request");
  };
  let attempt = await attemptOnce();
  if (req.signal.aborted) {
    if (attempt.kind !== "failure") await discardBody(attempt.upstream);
    return clientAborted();
  }
  if (retryableAttempt(attempt) && Date.now() - started < MODEL_CATALOG_RETRY_WINDOW_MS) {
    const first = attempt;
    if (first.kind === "status") await discardBody(first.upstream);
    await sleepUnlessAborted(options.retryDelayMs ?? MODEL_CATALOG_RETRY_DELAY_MS, req.signal);
    if (req.signal.aborted) return clientAborted();
    attempt = await attemptOnce();
    if (req.signal.aborted) {
      if (attempt.kind !== "failure") await discardBody(attempt.upstream);
      return clientAborted();
    }
    if (attempt.kind === "ok") options.onRecovered?.(first.failure);
  }

  if (attempt.kind === "ok") {
    let catalog = attempt.catalog;
    // CLIProxyAPI models join after the native and ChatGPT Web rows; a proxy failure never costs Codex its catalog.
    if (cliProxy) catalog = await augmentCatalogWithCliProxy(catalog, req, cliProxy);
    const body = JSON.stringify(catalog);
    return new Response(body, {
      status: attempt.upstream.status,
      statusText: attempt.upstream.statusText,
      headers: catalogResponseHeaders(attempt.upstream.headers, body),
    });
  }
  const failure = attempt.failure;
  const authDenied = attempt.kind === "status"
    && (attempt.upstream.status === 401 || attempt.upstream.status === 403);
  // A request without Codex authorization and an upstream 401/403 are answered as they are: an
  // older catalog must never hide that Codex has to sign in again.
  const stale = !authDenied && failure.stage !== "request" && key ? options.lastGood!.lookup(key) : undefined;
  if (stale) {
    try {
      let catalog = augmentNativeModelCatalog(stale.catalog, config, contextOverride?.());
      if (cliProxy) catalog = await augmentCatalogWithCliProxy(catalog, req, cliProxy);
      if (attempt.kind === "status") await discardBody(attempt.upstream);
      const body = JSON.stringify(catalog);
      const headers = catalogResponseHeaders(undefined, body);
      headers.set(MODEL_CATALOG_STALE_HEADER, "stale");
      headers.set("age", String(stale.ageSec));
      options.onStale?.({ failure, ageSec: stale.ageSec, fetchedAtMs: stale.fetchedAtMs });
      return new Response(body, { status: 200, headers });
    } catch {
      // The last-good catalog no longer fits the current configuration; report the real failure.
    }
  }
  onFailure?.(failure);
  if (attempt.kind === "status") return withoutUpstreamCookies(attempt.upstream);
  const error = attempt.error;
  return failure.stage === "catalog"
    ? formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error))
    : formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
}

export async function nativeSearchRequest(
  req: Request,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

async function nativeImagesRequest(
  req: Request,
  endpoint: NativeImageEndpoint,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    return formatErrorResponse(401, "authentication_error", "Native image requests require incoming Codex Bearer authorization");
  }
  try {
    return await forwardNativeCodexRequest(req, endpoint, fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Fail fast at the HTTP boundary: an image ChatGPT Web will actually attach to this turn must
 * already satisfy the browser worker's format constraint (chatGptImageFilePayloads in
 * browser-worker.ts), otherwise the turn dies mid-flight -- browser tab opened, quota spent --
 * with an adapter error instead of an immediate, retryable 400. Only checks images
 * chatGptWebAttachedInputImages proves will actually be attached (the compiler's own
 * one-pixel-placeholder and oldest-overflow-drop rules), so a historical image the compiler will
 * correctly omit from this turn's attachments is never rejected. Compaction requests further trim
 * history by a JSON byte budget this does not replicate; they are left to the deep validation in
 * chatGptImageFilePayloads instead of this early check.
 */
function findInvalidChatGptWebInputImage(parsed: CodexParsedRequest): string | undefined {
  if (parsed._compactionRequest) return undefined;
  for (const [index, image] of chatGptWebAttachedInputImages(parsed.context.messages).entries()) {
    const invalid = validateChatGptWebInputImage(image.imageUrl);
    if (invalid) {
      return `ChatGPT web input image ${index + 1} (${image.role} message) ${invalid}. `
        + "Inline the image bytes as a base64 data URL (png, jpeg, gif, or webp) before retrying.";
    }
  }
  return undefined;
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

/** The CLIProxyAPI connection for a proxy model, null for any other model, or an error response. */
function cliProxyConnectionFor(model: string, wiring: CliProxyWiring | undefined): CliProxyConnection | null | Response {
  if (!wiring) return null;
  try {
    return cliProxyRouteFor(model, wiring.home);
  } catch (error) {
    return formatErrorResponse(
      500,
      "server_error",
      `The CLIProxyAPI connection is misconfigured: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cliProxyResponse(
  model: string,
  raw: unknown,
  request: Request,
  wiring: CliProxyWiring | undefined,
): Promise<Response | null> {
  const proxy = cliProxyConnectionFor(model, wiring);
  const fetchImpl = wiring?.fetchImpl;
  if (proxy instanceof Response) return proxy;
  if (!proxy || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  try {
    const tail = Array.isArray(body.input) ? body.input.at(-1) : undefined;
    if (tail && typeof tail === "object" && (tail as { type?: unknown }).type === "compaction_trigger") {
      return await compactionTurnViaCliProxy(request, body, proxy, fetchImpl);
    }
    return await forwardCliProxyResponses(request, body, proxy, fetchImpl);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", `CLIProxyAPI: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: ResponseRequestOptions = {},
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
    const proxied = await cliProxyResponse(requestedModel, raw, nativeRequest, options.cliProxy);
    if (proxied) return proxied;
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  let route: ChatGptWebModelRoute;
  try {
    parsed = parseRequest(expanded);
    // A restart must not lose evidence of a compaction handoff this daemon already completed for
    // a still-open native turn. Resolved fresh per request (matching ChatGptThreadEnvironmentStore
    // and ChatGptLunaCheckpointStore in index.ts) rather than cached at module scope, so it always
    // reflects the config this request is actually running under. Bind before any later call can
    // consult isAcceptedCompactionContinuation for this exact `parsed` object (see
    // extractChatGptTurnUserRevision/isChatGptCompactionContinuation in environment.ts, reached
    // deep inside the adapter's own turn processing below).
    bindCompactionContinuationStore(parsed, new ChatGptCompactionContinuationStore(defaultCompactionContinuationStatePath()));
    route = routeChatGptWebRequest(parsed, config);
    const identity = extractChatGptTurnIdentity(parsed);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (parsed._opaqueMultiAgentV2Payload) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT Web cannot read this encrypted cross-backend subagent payload. "
        + "Start a new Compatibility V1 task, or delegate from a Web model whose collaboration call uses the plaintext-delivery marker.",
    );
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; refusing to run ChatGPT Web with partial Codex context. Compact the Codex task or start a new task before retrying.",
    );
  }
  const invalidWebImage = findInvalidChatGptWebInputImage(parsed);
  if (invalidWebImage) {
    return formatErrorResponse(400, "invalid_request_error", invalidWebImage);
  }

  const compaction = parsed._compactionRequest === true;
  const rememberCompletedResponse = (response: Record<string, unknown>): void => {
    if (!compaction) {
      if (options.rememberState !== false) rememberResponseState(parsed._rawBody, response, { force: true });
      return;
    }
    if (response.status !== "completed") return;
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId || !Array.isArray(response.output) || response.output.length !== 1) return;
    const item = response.output[0];
    if (item?.type !== "compaction" || typeof item.encrypted_content !== "string") return;
    const summary = decodeCompactionSummary(item.encrypted_content);
    if (!summary) return;
    const source = extractChatGptCompactionSourceRevision(parsed);
    const body = parsed._rawBody as { input?: unknown[] };
    // v1 installs the bounded user-message output, whereas v2 retains the original source.
    // Authenticate both exact producer-defined representations, never arbitrary rewrites.
    const v1Source = extractChatGptCompactionSourceRevision({
      ...parsed,
      _rawBody: { ...body, input: buildCompactV1Output(extractCompactUserMessages(body.input), summary) },
    });
    rememberCompactionContinuation(parsed, identity, [source, v1Source], summary);
  };
  if (compaction && route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  if (compaction) {
    // History compaction is a dedicated summarization turn. It must never bind the active Codex
    // tool bridge or continue an in-flight MCP round; the returned summary becomes the next turn's
    // replacement history through the Responses compaction contract.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const provider = providerConfig(config);
  let traceId: string | undefined;
  try {
    traceId = chatGptWebTraceId(provider, parsed);
  } catch (error) {
    // A cancelled browser session can only exist after the adapter accepted canonical native
    // turn identity and user-revision metadata. Requests without that identity have no matching
    // trace tombstone; preserve the adapter's existing strict validation/error path below.
    const message = error instanceof Error ? error.message : String(error);
    if (message === CHATGPT_TURN_REVISION_CONFLICT_MESSAGE) {
      // Codex can reopen an interrupted task with only refreshed developer/skill context under a
      // new turn_id. Its last human prompt still belongs to the stopped turn and must not be
      // replayed as new work. HTTP 400 makes that malformed recovery request terminal instead of
      // allowing Codex to retry it as an upstream 502.
      return formatErrorResponse(400, "invalid_request_error", message);
    }
    if (!message.includes("requires native Codex turn_id metadata")
      && !message.includes("requires a current-turn user message")) throw error;
  }
  const cancelledError = traceId ? chatGptTurnSessions.cancelledError(traceId) : undefined;
  if (cancelledError) {
    // Codex retries unknown streamed response.failed codes. A replay after the user explicitly
    // closed the only browser document is instead a terminal client state: repeating that exact
    // request is invalid and must not recreate the DOM. Codex maps HTTP 400 to its non-retryable
    // InvalidRequest category while the body preserves the real client_cancelled classification.
    return new Response(JSON.stringify({
      error: {
        type: "client_closed_request",
        code: "client_cancelled",
        message: cancelledError.message,
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const adapter = adapterFactory(provider);
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  const rememberRetryableFailure = (event: AdapterEvent): void => {
    if (event.type !== "error" || event.retryable !== true || event.status !== 503) return;
    const identity = extractChatGptTurnIdentity(parsed);
    const source = chatGptTurnUserRevisionHistory(parsed).at(-1);
    if (source) rememberRetryableTurnFailure(parsed, identity, source);
  };
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, { headers: req.headers, abortSignal: abort.signal }, event => {
        options.onAdapterEvent?.(event);
        rememberRetryableFailure(event);
        queue.push(event);
      });
    } catch (error) {
      const event: AdapterEvent = { type: "error", message: error instanceof Error ? error.message : String(error) };
      options.onAdapterEvent?.(event);
      queue.push(event);
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(provider.chatgptWeb?.stallTimeoutSec !== undefined
          ? { stallTimeoutSec: provider.chatgptWeb.stallTimeoutSec }
          : {}),
        ...(compaction ? { compaction: true } : {}),
        onCompletedResponse: rememberCompletedResponse,
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compaction ? { compaction: true } : {}),
  });
  rememberCompletedResponse(json);
  return Response.json(json);
}

export async function compactRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: Pick<ResponseRequestOptions, "onTurnIdentity" | "cliProxy"> = {},
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        // `/responses/compact` carries native turn authority in this canonical Codex header,
        // unlike ordinary `/responses` payloads where the same value also appears in the body.
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    const proxy = cliProxyConnectionFor(raw.model, options.cliProxy);
    if (proxy instanceof Response) return proxy;
    if (proxy) {
      try {
        return await compactViaCliProxy(nativeRequest, raw, proxy, options.cliProxy?.fetchImpl);
      } catch (error) {
        return formatErrorResponse(502, "upstream_error", `CLIProxyAPI compaction failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  let route: ChatGptWebModelRoute;
  try {
    route = requireChatGptWebModelRoute(raw.model, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory, options);
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json(
      { error },
      { status: httpStatusFromTerminalError(error) },
    );
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(input), summary) });
}

export function startServer(
  config: AppConfig,
  dependencies: {
    fetchUpstream?: NativeFetch;
    adapterFactory?: ChatGptWebAdapterFactory;
    cliProxy?: CliProxyWiring;
    /** Test seam: how long a turn that arrives during a drain waits for it to end. */
    drainHoldMs?: number;
    /** Test seam: heartbeat interval of a waiting turn's response stream. */
    drainHeartbeatMs?: number;
    /** The service entry point persists it under its home; embedded servers keep it in memory. */
    modelCatalogLastGood?: NativeModelCatalogLastGood;
    modelCatalogRetryDelayMs?: number;
  } = {},
): ReturnType<typeof Bun.serve> {
  if (config.purpose === "dev-harness") {
    throw new Error("DEV harness configuration cannot start a Responses listener");
  }
  // The service entry point wires CLIProxyAPI routing to its home; embedded servers opt in.
  const cliProxy = dependencies.cliProxy ?? undefined;
  const startedAt = Date.now();
  const turnBroker = config.mode === "full" ? TurnBroker.forSocket(config.brokerSocketPath) : undefined;
  if (config.mode === "full") {
    void turnBroker!.listen().catch(error => {
      console.error(
        `[chatgpt-web] turn broker endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  const drainGate = new DrainGate();
  const drainHoldMs = dependencies.drainHoldMs ?? DRAIN_HOLD_MS;
  const drainHeartbeatMs = dependencies.drainHeartbeatMs ?? 2_000;
  let shutdownPromise: Promise<void> | undefined;
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  let modelCatalogRequests = 0;
  let lastModelCatalogResult: {
    request: number; at: string; status: number; failure?: ModelCatalogFailure; stale?: true;
  } | null = null;
  let clientAbortedModelCatalogRequests = 0;
  let staleModelCatalogResponses = 0;
  // When the newest catalog answer came from the last-good fallback, when that catalog was fetched.
  let staleModelCatalogFetchedAtMs: number | null = null;
  const modelCatalogLastGood = dependencies.modelCatalogLastGood ?? new NativeModelCatalogLastGood();
  const httpTurns = new HttpTurnCounter();
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount() + (turnBroker?.externalOwnerActiveCount() ?? 0),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const boundPort = server.port;
      if (boundPort === undefined || !isLoopbackRequest(url, req, boundPort)) {
        console.warn(`[codex-chatgpt-web] rejected request with a non-loopback Host or Origin: ${JSON.stringify({
          host: req.headers.get("host"),
          origin: req.headers.get("origin"),
        })}`);
        return formatErrorResponse(403, "invalid_request_error", "Request Host or Origin is not allowed");
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web",
          version: VERSION,
          mode: config.mode,
          pid: process.pid,
          port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          accepting_turns: !drainGate.isDraining,
          drain_held_requests: drainGate.held,
          successful_model_catalog_requests: successfulModelCatalogRequests,
          last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
          model_catalog_requests: modelCatalogRequests,
          last_model_catalog_result: lastModelCatalogResult,
          client_aborted_model_catalog_requests: clientAbortedModelCatalogRequests,
          stale_model_catalog_responses: staleModelCatalogResponses,
          catalog_stale_age_sec: staleModelCatalogFetchedAtMs === null
            ? null
            : Math.max(0, Math.floor((Date.now() - staleModelCatalogFetchedAtMs) / 1_000)),
          ...activity(),
        });
      }
      if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        if (url.pathname === "/admin/drain") drainGate.drain();
        else drainGate.resume();
        turnBroker?.setExternalOwnersAccepted(!drainGate.isDraining);
        return Response.json({ status: "ok", accepting_turns: !drainGate.isDraining, ...activity() });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-turn") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let traceId: string;
        let leaseFailure: "browser_surface_bootstrap_timeout" | "helper_heartbeat_expired" | undefined;
        try {
          const body = await req.json() as { traceId?: unknown; reason?: unknown };
          traceId = typeof body?.traceId === "string" ? body.traceId : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("traceId is invalid");
          if (body.reason !== undefined) {
            if (body.reason !== "browser_surface_bootstrap_timeout" && body.reason !== "helper_heartbeat_expired") {
              throw new Error("Browser turn cancellation reason is invalid");
            }
            leaseFailure = body.reason;
          }
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        const reason = leaseFailure
          ? new ChatGptWebAdapterError(
            leaseFailure === "browser_surface_bootstrap_timeout"
              ? "The ChatGPT browser turn did not finish browser setup before its lease expired. The turn was stopped."
              : "The ChatGPT browser helper stopped reporting progress and its lease expired. The turn was stopped.",
            { status: 504, errorType: "server_error", code: leaseFailure, retryable: false },
          )
          : chatGptBrowserTabClosedError();
        // Revoke the owner first. This prevents a compaction callback that observes its retained
        // source being cancelled below from starting a fresh fallback during operator shutdown.
        const compactionCancellation = cancelStructuredCompactionTrace(traceId, reason);
        const browserCancellation = chatGptTurnSessions.cancelTrace(traceId, reason);
        const [cancelledBrowserTurns, cancelledCompactionRuns] = await Promise.all([
          browserCancellation,
          compactionCancellation,
        ]);
        const cancelledBrokerTurns = turnBroker?.revokeTrace(traceId, reason) ?? 0;
        return Response.json({
          status: "ok",
          trace_id: traceId,
          cancelled_browser_turns: cancelledBrowserTurns,
          cancelled_broker_turns: cancelledBrokerTurns,
          cancelled_compaction_runs: cancelledCompactionRuns,
          ...activity(),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/interrupt-turn") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let identity: NativeCodexTurnIdentity;
        try {
          const body = await req.json() as { threadId?: unknown; turnId?: unknown };
          const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
          const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
            throw new Error("native Codex threadId or turnId is invalid");
          }
          identity = { threadId, turnId };
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        const reason = new DOMException("Codex turn interrupted", "AbortError");
        const browserCancellation = chatGptTurnSessions.cancelNativeTurn(
          identity.threadId,
          identity.turnId,
          reason,
        );
        const compactionCancellation = cancelStructuredCompactionNativeTurn(
          identity.threadId,
          identity.turnId,
          reason,
        );
        const httpCancellation = httpTurns.beginCancelTurn(identity, reason);
        const settlement = Promise.allSettled([
          browserCancellation.settlement,
          compactionCancellation.settlement,
          httpCancellation.settlement,
        ]);
        void settlement.then(results => {
          for (const result of results) {
            if (result.status === "rejected") {
              console.error(
                `[chatgpt-web] interrupted turn cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              );
            }
          }
        });
        return Response.json({
          status: "ok",
          cancelled_http_turns: httpCancellation.cancelled,
          cancelled_browser_turns: browserCancellation.cancelled,
          cancelled_compaction_runs: compactionCancellation.cancelled,
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-turns") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const reason = new Error("Active turn cancelled by launcher");
        // Abort shared compaction owners before clearing their retained source sessions. The
        // owner signal is the only cancellation boundary for a fresh fallback not in the session
        // registry.
        const compactionCancellation = cancelAllStructuredCompactions(reason);
        const cancelledBrowserTurns = chatGptTurnSessions.clear() + (turnBroker?.revokeExternalOwners() ?? 0);
        const [cancelledHttpTurns, cancelledCompactionRuns] = await Promise.all([
          httpTurns.cancelAll(reason),
          compactionCancellation,
        ]);
        return Response.json({
          status: "ok",
          cancelled_http_turns: cancelledHttpTurns,
          cancelled_browser_turns: cancelledBrowserTurns,
          cancelled_compaction_runs: cancelledCompactionRuns,
          ...activity(),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const current = activity();
        if (!drainGate.isDraining || current.active_http_turns > 0 || current.active_browser_turns > 0) {
          return Response.json(
            {
              status: "refused",
              accepting_turns: !drainGate.isDraining,
              ...current,
            },
            { status: 409 },
          );
        }
        setTimeout(shutdown, 0);
        return Response.json({ status: "ok", accepting_turns: false, ...current });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (drainGate.isDraining) return formatErrorResponse(503, "server_error", DRAINING_MESSAGE);
        return httpTurns.track(async signal => {
          const request = ++modelCatalogRequests;
          const started = Date.now();
          const log = (level: "debug" | "info" | "warn", event: string, detail: Record<string, unknown>) => {
            try {
              const line = `[codex-chatgpt-web] ${level === "debug" ? "debug " : ""}${event} ${JSON.stringify({
                request,
                ...detail,
                elapsedMs: Date.now() - started,
              })}`;
              if (level === "debug") console.debug(line);
              else if (level === "info") console.info(line);
              else console.warn(line);
            } catch { /* Logging must not replace the catalog result. */ }
          };
          let stale: ModelCatalogStaleServe | undefined;
          const recordResult = (response: Response, failure?: ModelCatalogFailure): Response => {
            if (failure?.stage === "client_aborted") {
              // Codex already left: nobody receives this answer, so it is neither a catalog
              // failure nor a newer result than the last one Codex actually got.
              clientAbortedModelCatalogRequests += 1;
              log("debug", "model_catalog_client_aborted", { clientAborted: clientAbortedModelCatalogRequests });
              return response;
            }
            const recordedFailure = stale?.failure ?? failure;
            const result = {
              request,
              at: new Date().toISOString(),
              status: response.status,
              ...(recordedFailure ? { failure: recordedFailure } : {}),
              ...(stale ? { stale: true as const } : {}),
            };
            // An older, slower request must not replace a newer completed result.
            if (!lastModelCatalogResult || request > lastModelCatalogResult.request) {
              lastModelCatalogResult = result;
              if (response.ok) staleModelCatalogFetchedAtMs = stale ? stale.fetchedAtMs : null;
            }
            if (stale) {
              log("warn", "model_catalog_served_stale", { failure: stale.failure, ageSec: stale.ageSec });
            } else if (!response.ok) {
              log("warn", "model_catalog_failed", { at: result.at, status: result.status, ...(failure ? { failure } : {}) });
            }
            return response;
          };
          let catalogConfig: AppConfig;
          try {
            catalogConfig = {
              ...config,
              subagentProtocol: readCodexSubagentProtocol(config.subagentProtocol),
            };
          } catch (error) {
            return recordResult(formatErrorResponse(
              500,
              "server_error",
              `Could not resolve the installed subagent protocol: ${error instanceof Error ? error.message : String(error)}`,
            ), modelCatalogFailure("config", error));
          }
          let failure: ModelCatalogFailure | undefined;
          const response = await modelsRequest(
            new Request(req, { signal }),
            catalogConfig,
            dependencies.fetchUpstream,
            readCodexModelContextOverride,
            value => { failure = value; },
            cliProxy,
            {
              lastGood: modelCatalogLastGood,
              ...(dependencies.modelCatalogRetryDelayMs === undefined
                ? {}
                : { retryDelayMs: dependencies.modelCatalogRetryDelayMs }),
              onStale: value => {
                stale = value;
                staleModelCatalogResponses += 1;
              },
              onRecovered: value => log("info", "model_catalog_retry_recovered", { failure: value }),
            },
          );
          if (response.ok) {
            successfulModelCatalogRequests += 1;
            lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
          }
          return recordResult(response, failure);
        }, req.signal, process.platform, "models");
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const runTurn = () => httpTurns.track(
          (signal, bindIdentity) => responseRequest(
            new Request(req, { signal }),
            config,
            dependencies.adapterFactory,
            { onTurnIdentity: bindIdentity, cliProxy },
          ),
          req.signal,
          process.platform,
          "responses",
        );
        if (drainGate.isDraining) {
          // Codex streams every turn (Accept: text/event-stream). Such a turn waits for the drain
          // with heartbeats instead of failing; the wait is not an active turn, so the drain can
          // still prove idleness. A client without a stream has nothing to wait on and is refused.
          if (!acceptsEventStream(req)) return formatErrorResponse(503, "server_error", DRAINING_MESSAGE);
          return heldStreamingResponse({
            gate: drainGate,
            signal: req.signal,
            holdMs: drainHoldMs,
            heartbeatMs: drainHeartbeatMs,
            run: runTurn,
          });
        }
        return runTurn();
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (drainGate.isDraining) {
          // Codex waits for its compaction answer without a response stream: hold the request
          // (not an active turn) until the drain ends, then answer a 503 Codex retries.
          const outcome = await drainGate.wait(drainHoldMs, req.signal);
          if (outcome === "aborted") return new Response(null, { status: 499, statusText: "Client Closed Request" });
          if (outcome !== "resumed") return drainedHttpResponse();
        }
        return httpTurns.track(
          (signal, bindIdentity) => compactRequest(
            new Request(req, { signal }),
            config,
            dependencies.adapterFactory,
            { onTurnIdentity: bindIdentity, cliProxy },
          ),
          req.signal,
          process.platform,
          "compact",
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        if (drainGate.isDraining) return formatErrorResponse(503, "server_error", DRAINING_MESSAGE);
        return httpTurns.track(
          signal => nativeSearchRequest(new Request(req, { signal }), dependencies.fetchUpstream),
          req.signal,
          process.platform,
          "search",
        );
      }
      if (req.method === "POST"
        && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")) {
        if (drainGate.isDraining) return formatErrorResponse(503, "server_error", DRAINING_MESSAGE);
        const endpoint: NativeImageEndpoint = url.pathname === "/v1/images/generations"
          ? "images/generations"
          : "images/edits";
        return httpTurns.track(
          signal => nativeImagesRequest(new Request(req, { signal }), endpoint, dependencies.fetchUpstream),
          req.signal,
          process.platform,
          endpoint,
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  function shutdown(): void {
    if (shutdownPromise) return;
    // Turns still waiting for the drain get their paced-retry failure now, so Codex waits for the
    // restarted runtime instead of seeing a dropped connection.
    const heldAtShutdown = drainGate.held;
    drainGate.close();
    chatGptTurnSessions.clear();
    flushResponseState();
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
        // Give those failure frames a moment to leave before stop(true) closes the connections.
        heldAtShutdown > 0 ? Bun.sleep(HELD_TURN_SHUTDOWN_FLUSH_MS) : undefined,
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[codex-chatgpt-web] shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[codex-chatgpt-web] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
