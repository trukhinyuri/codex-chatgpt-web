import { afterEach, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  CHATGPT_BROWSER_DIAGNOSTIC_FAILURE_MARKER,
  CHATGPT_BROWSER_DIAGNOSTIC_RETENTION,
  ChatGptBrowserObservationTimeoutError,
  ChatGptBrowserWorker,
  chatGptBrowserDiagnosticTracesToPrune,
  chatGptBrowserStageOf,
  chatGptTurnEndDiagnostics,
  pressVisibleChatGptStop,
  pruneChatGptBrowserDiagnostics,
  tagChatGptBrowserStage,
  type ChatGptBrowserDiagnosticTrace,
} from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_STOP_BUTTON_SELECTOR } from "../src/chatgpt-session";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, connectLauncherBrowserHost } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const HOUR = 60 * 60 * 1_000;
const NOW = Date.parse("2026-09-18T12:00:00.000Z");

function trace(index: number, options: Partial<ChatGptBrowserDiagnosticTrace> = {}): ChatGptBrowserDiagnosticTrace {
  return { name: `trace_${String(index).padStart(3, "0")}`, modifiedAtMs: NOW - index * 60_000, failed: false, bytes: 1_000, ...options };
}

async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { debug: console.debug, info: console.info, warn: console.warn, error: console.error, log: console.log };
  for (const level of ["debug", "info", "warn", "error", "log"] as const) {
    console[level] = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
  }
  try {
    return { result: await run(), lines };
  } finally {
    Object.assign(console, original);
  }
}

function expectNoSecretsUrlsOrPaths(lines: string[]): void {
  for (const line of lines) {
    expect(line).not.toContain("Bearer");
    expect(line).not.toMatch(/https?:|wss?:/);
    expect(line).not.toMatch(/\/(Users|home|private|tmp|var)\//);
  }
}

test("retention keeps the ten newest traces plus the twenty newest failed ones", () => {
  // 60 traces, one per minute; every third one failed.
  const traces = Array.from({ length: 60 }, (_, index) => trace(index, { failed: index % 3 === 0 }));
  const pruned = new Set(chatGptBrowserDiagnosticTracesToPrune(traces, NOW));
  const kept = traces.filter(candidate => !pruned.has(candidate.name));
  const newest = traces.slice(0, 10).map(candidate => candidate.name);
  const newestFailed = traces.filter(candidate => candidate.failed).slice(0, 20).map(candidate => candidate.name);
  expect(new Set(kept.map(candidate => candidate.name))).toEqual(new Set([...newest, ...newestFailed]));
  // The old limit kept only ten traces; a failure an hour back is now still there.
  expect(kept.some(candidate => candidate.failed && candidate.modifiedAtMs < NOW - 50 * 60_000)).toBe(true);
});

test("retention drops traces older than 48 hours and stays under the size cap", () => {
  const aged = [
    trace(0),
    trace(1, { failed: true, modifiedAtMs: NOW - 47 * HOUR }),
    trace(2, { failed: true, modifiedAtMs: NOW - 49 * HOUR }),
    trace(3, { modifiedAtMs: NOW - 49 * HOUR }),
  ];
  expect(chatGptBrowserDiagnosticTracesToPrune(aged, NOW).sort()).toEqual(["trace_002", "trace_003"]);

  const retention = { ...CHATGPT_BROWSER_DIAGNOSTIC_RETENTION, maxBytes: 2_500 };
  const heavy = [trace(0), trace(1), trace(2), trace(3, { failed: true })];
  // The newest two fit (2 000 bytes); every older trace would cross the cap.
  expect(chatGptBrowserDiagnosticTracesToPrune(heavy, NOW, undefined, retention).sort())
    .toEqual(["trace_002", "trace_003"]);
  // The trace being written is never pruned, and its bytes count first.
  expect(chatGptBrowserDiagnosticTracesToPrune(heavy, NOW, "trace_003", retention).sort())
    .toEqual(["trace_001", "trace_002"]);
});

test("pruning on disk keeps failed traces, including ones written before the failure marker existed", () => {
  const root = tempRoot("browser-turns-");
  const make = (name: string, minutesAgo: number, files: string[]) => {
    const directory = join(root, name);
    mkdirSync(directory);
    for (const file of files) writeFileSync(join(directory, file), "{}\n");
    const at = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(directory, at, at);
  };
  for (let index = 0; index < 14; index += 1) make(`ok_trace_${index}`, index, ["01-browser-page-acquired.json"]);
  make("failed_marker", 30, ["01-browser-page-acquired.json", CHATGPT_BROWSER_DIAGNOSTIC_FAILURE_MARKER]);
  make("failed_legacy", 31, ["01-browser-page-acquired.json", "07-turn-failed.json"]);
  make("failed_expired", 49 * 60, [CHATGPT_BROWSER_DIAGNOSTIC_FAILURE_MARKER]);

  const pruned = pruneChatGptBrowserDiagnostics(root, "ok_trace_0");
  const remaining = readdirSync(root).sort();
  expect(remaining).toEqual([
    "failed_legacy",
    "failed_marker",
    ...Array.from({ length: 10 }, (_, index) => `ok_trace_${index}`),
  ].sort());
  expect(pruned.sort()).toEqual(["failed_expired", "ok_trace_10", "ok_trace_11", "ok_trace_12", "ok_trace_13"]);
});

test("a failed trace is marked so that retention keeps it, without a message or path in the marker", async () => {
  const diagnosticsRoot = tempRoot("cgw-failure-marker-");
  const page = { evaluate: async () => ({ composer: { visibleCount: 1, textChars: [0] } }) };
  const failure = new Error(`connector proof failed at ${diagnosticsRoot}`);
  const verifyConnectorExclusive = (ChatGptBrowserWorker.prototype as unknown as {
    verifyConnectorExclusive(traceId: string): Promise<string>;
  }).verifyConnectorExclusive;
  const { result: rejected } = await captureConsole(() => verifyConnectorExclusive.call({
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnosticsRoot },
    ensurePage: async () => page,
    prepareTemporaryChatSurface: async () => { throw failure; },
  }, "verify_marker_trace").catch(error => error));
  expect(rejected).toBe(failure);
  const [traceDirectory] = readdirSync(diagnosticsRoot);
  const files = readdirSync(join(diagnosticsRoot, traceDirectory!));
  expect(files).toContain(CHATGPT_BROWSER_DIAGNOSTIC_FAILURE_MARKER);
  // Checkpoints are the numbered .json files; the marker is not one of them.
  expect(files.filter(name => name.endsWith(".json")).every(name => /^\d{2}-/.test(name))).toBe(true);
  const marker = readFileSync(join(diagnosticsRoot, traceDirectory!, CHATGPT_BROWSER_DIAGNOSTIC_FAILURE_MARKER), "utf8");
  expect(JSON.parse(marker)).toMatchObject({ version: 1, traceId: "verify_marker_trace", code: "error", stage: "connector_verification" });
  expect(marker).not.toContain(diagnosticsRoot);
  expect(marker).not.toContain("connector proof failed");
});

test("turn_ended diagnostics name the code, the stage and who cancelled", () => {
  const timeout = tagChatGptBrowserStage(new Error("ChatGPT browser stage timed out: send"), "send");
  expect(chatGptTurnEndDiagnostics(timeout, undefined, "lease")).toEqual({ code: "stage_timeout", stage: "send" });

  const limit = new ChatGptWebAdapterError("limit", { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true });
  expect(chatGptTurnEndDiagnostics(tagChatGptBrowserStage(limit, "response"), undefined, "lease"))
    .toEqual({ code: "rate_limit_exceeded", stage: "response" });

  const cancelled = new AbortController();
  cancelled.abort();
  const abort = tagChatGptBrowserStage(new DOMException("ChatGPT web turn aborted", "AbortError"), "response");
  expect(chatGptTurnEndDiagnostics(abort, cancelled.signal, "lease"))
    .toEqual({ code: "aborted", stage: "response", abortClass: "codex_cancelled" });
  expect(chatGptTurnEndDiagnostics(new DOMException("aborted", "AbortError"), new AbortController().signal, "lease"))
    .toEqual({ code: "aborted", stage: "lease", abortClass: "internal_abort" });
  expect(chatGptTurnEndDiagnostics(chatGptBrowserTabClosedError(), undefined, "lease"))
    .toEqual({ code: "client_cancelled", stage: "lease", abortClass: "tab_closed" });
  expect(chatGptTurnEndDiagnostics(new ChatGptCompactionHandoffAccepted(), undefined, "response"))
    .toEqual({ code: "compaction_handoff_accepted", stage: "response", abortClass: "compaction_handoff" });
  expect(chatGptTurnEndDiagnostics(new ChatGptBrowserObservationTimeoutError(5_000), undefined, "setup"))
    .toEqual({ code: "observation_timeout", stage: "setup" });
  expect(chatGptTurnEndDiagnostics(new Error("at /Users/person/.codex"), undefined, "setup"))
    .toEqual({ code: "error", stage: "setup" });
});

test("a failed browser stage tags its error with the innermost stage", async () => {
  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web",
    baseUrl: `browser://stage-tag-${Date.now()}-${Math.random()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true },
  }) as unknown as {
    runStage<T>(traceId: string, stage: string, timeoutMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
  };
  const failure = new Error("rebind failed");
  const { result } = await captureConsole(() => worker.runStage("stagetrace01", "send", 5_000, () => (
    worker.runStage("stagetrace01", "response_page_rebind_1", 5_000, async () => { throw failure; })
  )).catch(error => error));
  expect(result).toBe(failure);
  expect(chatGptBrowserStageOf(failure)).toBe("response_page_rebind_1");

  const timedOut = await captureConsole(() => worker.runStage("stagetrace01", "file_attachment", 20, () => new Promise(() => {}))
    .catch(error => error));
  expect(chatGptBrowserStageOf(timedOut.result)).toBe("file_attachment");
  expect(chatGptTurnEndDiagnostics(timedOut.result, undefined, "setup")).toEqual({ code: "stage_timeout", stage: "file_attachment" });
});

test("every Stop press is logged with its reason and whether it landed", async () => {
  let presses = 0;
  const stopButton = { last() { return this; }, isVisible: async () => true, press: async () => { presses += 1; } };
  const hidden = { last() { return this; }, isVisible: async () => false, press: async () => { presses += 1; } };
  let visible = true;
  const page = {
    locator: (selector: string) => (selector === CHATGPT_STOP_BUTTON_SELECTOR && visible ? stopButton : hidden),
  } as unknown as Page;

  const { result, lines } = await captureConsole(() => pressVisibleChatGptStop(page, "response_aborted"));
  expect(result).toBe(true);
  expect(presses).toBe(1);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("[chatgpt-web] stop_pressed ");
  expect(JSON.parse(lines[0]!.slice("[chatgpt-web] stop_pressed ".length))).toEqual({ reason: "response_aborted", pressed: true });
  expectNoSecretsUrlsOrPaths(lines);

  visible = false;
  const absent = await captureConsole(() => pressVisibleChatGptStop(page, "send_failed"));
  expect(absent.result).toBe(false);
  expect(absent.lines).toEqual([]);
  expect(presses).toBe(1);
});

test("the one-minute progress checkpoint is informational and named for what it is", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(source).not.toContain("response-stalled-60s");
  const checkpoint = source.indexOf("\"response-still-generating-60s\"");
  expect(checkpoint).toBeGreaterThan(0);
  const window = source.slice(checkpoint, source.indexOf("waiting for completed-turn evidence", checkpoint));
  expect(window).toContain("console.info(");
  expect(window).not.toContain("console.warn(");
});

function launcherDescriptor(root: string, endpoint: string, controlEndpoint: string): string {
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint,
    control: { endpoint: controlEndpoint, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

test("a CDP connection attempt logs how long each step took and where it stopped", async () => {
  const root = tempRoot("cdp-connect-");
  const cdp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unavailable", { status: 503 }) });
  try {
    const descriptor = launcherDescriptor(root, `http://127.0.0.1:${cdp.port}`, "http://127.0.0.1:39111");
    const { result, lines } = await captureConsole(() => connectLauncherBrowserHost(descriptor, 1_000, undefined, undefined, "cdptrace0001")
      .then(() => undefined, error => error));
    expect(result).toBeInstanceOf(Error);
    const logged = lines.filter(line => line.startsWith("[chatgpt-web] cdp_connect "));
    expect(logged).toHaveLength(1);
    const detail = JSON.parse(logged[0]!.slice("[chatgpt-web] cdp_connect ".length)) as Record<string, unknown>;
    expect(detail).toMatchObject({ traceId: "cdptrace0001", outcome: "failed", step: "cdp_ready" });
    expect(detail.cdpReadyMs).toBeGreaterThanOrEqual(0);
    expect(detail.totalMs).toBeGreaterThanOrEqual(0);
    expect(detail.connectMs).toBeUndefined();
    expectNoSecretsUrlsOrPaths(logged);
  } finally {
    cdp.stop(true);
  }
});

test("the launcher learns the code, stage and abort class of a turn that did not complete", async () => {
  const ends: Record<string, unknown>[] = [];
  const control = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/turn/start") {
      response.end('{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","reused":false,"connectorBound":false}\n');
      return;
    }
    if (request.url === "/v1/turn/end") ends.push(body);
    response.end('{"ok":true,"cancelledByUser":false}\n');
  });
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(0, "127.0.0.1", resolve);
  });
  const root = tempRoot("turn-end-");
  try {
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("control server has no port");
    const descriptorPath = launcherDescriptor(root, "http://127.0.0.1:39110", `http://127.0.0.1:${address.port}`);
    const worker = ChatGptBrowserWorker.forProvider({
      adapter: "chatgpt-web",
      baseUrl: `browser://turn-end-${Date.now()}-${Math.random()}`,
      chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: descriptorPath, localToolsEnabled: false, solAvailable: true },
    }) as unknown as {
      runExclusive(turn: Record<string, unknown>): Promise<string>;
      runBrowserTurn: (turn: Record<string, unknown>) => Promise<string>;
    };
    const turn = (traceId: string, abortSignal?: AbortSignal) => ({
      traceId,
      modelId: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: false },
      prepare: async () => { throw new Error("not used"); },
      onTextDelta: () => {},
      ...(abortSignal ? { abortSignal } : {}),
    });

    worker.runBrowserTurn = async () => {
      throw tagChatGptBrowserStage(new Error("ChatGPT browser stage timed out: send"), "send");
    };
    await expect(worker.runExclusive(turn("turnendfail01"))).rejects.toThrow("stage timed out");

    const codex = new AbortController();
    worker.runBrowserTurn = async () => {
      codex.abort();
      throw tagChatGptBrowserStage(new DOMException("ChatGPT web turn aborted", "AbortError"), "response");
    };
    await expect(worker.runExclusive(turn("turnendabort1", codex.signal))).rejects.toMatchObject({ name: "AbortError" });

    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ traceId: "turnendfail01", status: "failed", code: "stage_timeout", stage: "send" });
    expect(ends[0]!.abortClass).toBeUndefined();
    expect(ends[1]).toMatchObject({
      traceId: "turnendabort1", status: "aborted", code: "aborted", stage: "response", abortClass: "codex_cancelled",
    });
  } finally {
    await new Promise<void>(resolve => control.close(() => resolve()));
  }
});
