import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { CompactionTransactionStore, type CompactionTransactionHandle } from "../src/adapters/chatgpt-web/compaction-transaction";
import {
  ChatGptFifoLock,
  chatGptAccountBrowserLocks,
  isChatGptHeavyBrowserStage,
} from "../src/adapters/chatgpt-web/concurrency";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import {
  ChatGptAdmissionGate,
  chatGptAccountKey,
  formatChatGptClockTime,
} from "../src/adapters/chatgpt-web/rate-limit-gate";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import type { CodexParsedRequest } from "../src/types";
import { FakeGateClock, flushMicrotasks, silentGateLog } from "./fixtures/fake-gate-clock";

const tempRoot = join(tmpdir(), `admission-worker-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const START = new Date(2026, 8, 18, 14, 52, 18).getTime();
const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
let uniqueAccount = 0;

function gate(clock: FakeGateClock): ChatGptAdmissionGate {
  uniqueAccount += 1;
  return new ChatGptAdmissionGate({ accountKey: `worker-account-${uniqueAccount}`, clock, log: silentGateLog });
}

function gatedWorker(admission: ChatGptAdmissionGate, runExclusive: (turn: BrowserTurn) => Promise<string>): ChatGptBrowserWorker {
  return Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome", storageStatePath: join(tempRoot, "unused-storage-state.json") },
    activeRuns: new Map(),
    admission,
    runExclusive,
  }) as ChatGptBrowserWorker;
}

function browserTurn(traceId: string, extra: Partial<BrowserTurn> = {}): BrowserTurn {
  return {
    traceId,
    modelId: "chatgpt-web/high",
    capabilities,
    prepare: async () => ({ text: traceId, images: [], release() {} }),
    onTextDelta() {},
    ...extra,
  };
}

/**
 * Bun 1.4 never times out `expect(promise).resolves` on a promise that never settles, so a
 * regression that leaves a turn queued would hang the suite instead of failing it.
 */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function rateLimit(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("ChatGPT rate limit: too many requests. Please try again in 60s.", {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
}

test("during a cooldown a new turn never touches the browser until the pause ends", async () => {
  const clock = new FakeGateClock(START);
  const admission = gate(clock);
  admission.recordRateLimit();
  const browserCalls: number[] = [];
  const worker = gatedWorker(admission, async () => {
    browserCalls.push(clock.now());
    return "answer";
  });

  const running = worker.run(browserTurn("turn_cooldown"));
  await clock.advance(59_999);
  expect(browserCalls).toEqual([]);
  await clock.advance(1);
  expect(await within(running)).toBe("answer");
  expect(browserCalls).toEqual([START + 60_000]);
});

test("a rate limit before Send sends the turn back to its place in the queue: the caller sees no error and learns when it goes", async () => {
  const clock = new FakeGateClock(START);
  const admission = gate(clock);
  const browserCalls: number[] = [];
  const worker = gatedWorker(admission, async turn => {
    browserCalls.push(clock.now());
    if (browserCalls.length === 1) throw rateLimit();
    await turn.onSendActivated?.();
    turn.onSubmitted?.();
    return "answer";
  });
  const reasoning: string[] = [];
  const admitted: number[] = [];
  const running = worker.run(browserTurn("turn_requeued", {
    onReasoningSummary: text => reasoning.push(text),
    onAdmitted: () => admitted.push(clock.now()),
  }));
  await flushMicrotasks();
  expect(browserCalls).toEqual([START]);
  await clock.advance(59_999);
  expect(browserCalls).toHaveLength(1);
  await clock.advance(1);
  expect(await within(running)).toBe("answer");
  expect(browserCalls).toEqual([START, START + 60_000]);
  expect(admitted).toEqual([START, START + 60_000]);
  expect(reasoning).toEqual([
    `ChatGPT asked to slow down. This step waits in the bridge and will be sent at about ${formatChatGptClockTime(START + 60_000)} (position 1 in the queue). Nothing to do.`,
  ]);
  // The requeued turn was the probe; its served answer ended the escalation.
  expect(admission.snapshot()).toMatchObject({ tier: 0, probeRequired: false, queued: 0, active: 0 });
});

test("a rate limit after Send reaches the caller with the remaining pause, because only the caller may resend", async () => {
  const clock = new FakeGateClock(START);
  const admission = gate(clock);
  let browserCalls = 0;
  const worker = gatedWorker(admission, async turn => {
    browserCalls += 1;
    await turn.onSendActivated?.();
    throw rateLimit();
  });
  await expect(within(worker.run(browserTurn("turn_after_send")))).rejects.toMatchObject({
    code: "rate_limit_exceeded",
    retryable: true,
    message: "ChatGPT rate limit: too many requests. Please try again in 60s.",
  });
  expect(browserCalls).toBe(1);
  expect(admission.snapshot()).toMatchObject({ tier: 1, cooldownUntil: START + 60_000, active: 0 });
});

test("cancelling a queued turn frees its place and never opens the browser", async () => {
  const clock = new FakeGateClock(START);
  const admission = gate(clock);
  admission.recordRateLimit();
  let browserCalls = 0;
  const worker = gatedWorker(admission, async () => {
    browserCalls += 1;
    return "answer";
  });
  const abort = new AbortController();
  const running = worker.run(browserTurn("turn_cancelled", { abortSignal: abort.signal }));
  await flushMicrotasks();
  expect(admission.snapshot().queued).toBe(1);
  abort.abort();
  await expect(within(running)).rejects.toMatchObject({ name: "AbortError" });
  expect(admission.snapshot().queued).toBe(0);
  await clock.advance(60_000);
  expect(browserCalls).toBe(0);
});

test("a parent that waits for Codex tool results does not block its subagent after an incident (#397)", async () => {
  const clock = new FakeGateClock(START);
  const admission = gate(clock);
  admission.recordRateLimit();
  const parentProgress = new ChatGptExternalTurnProgress();
  let releaseParent!: () => void;
  const started: string[] = [];
  const worker = gatedWorker(admission, turn => {
    started.push(turn.traceId);
    turn.onSubmitted?.();
    if (turn.traceId === "parent") {
      return new Promise<string>(resolve => { releaseParent = () => resolve("parent done"); });
    }
    return Promise.resolve("subagent done");
  });
  const parent = worker.run(browserTurn("parent", { externalProgress: parentProgress }));
  await clock.advance(60_000);
  expect(started).toEqual(["parent"]);

  const subagent = worker.run(browserTurn("subagent"));
  await clock.advance(30_000);
  // After an incident only one turn may generate, and the parent is generating.
  expect(started).toEqual(["parent"]);

  // ChatGPT asked Codex to run the subagent: the parent now only waits for Codex.
  parentProgress.recordToolBatch(1, clock.now());
  await flushMicrotasks();
  expect(await within(subagent)).toBe("subagent done");
  expect(started).toEqual(["parent", "subagent"]);

  parentProgress.recordToolResult(clock.now());
  releaseParent();
  expect(await within(parent)).toBe("parent done");
});

test("an accepted compaction handoff counts as a served response", async () => {
  const clock = new FakeGateClock(START);
  const admission = gate(clock);
  admission.recordRateLimit();
  const worker = gatedWorker(admission, async () => { throw new ChatGptCompactionHandoffAccepted(); });
  const running = worker.run(browserTurn("compaction_handoff"));
  await clock.advance(60_000);
  await expect(within(running)).rejects.toBeInstanceOf(ChatGptCompactionHandoffAccepted);
  expect(admission.snapshot()).toMatchObject({ tier: 0, probeRequired: false, active: 0 });
});

function lockedWorker(name: string) {
  const config = { browserHost: "launcher" as const, browserHostDescriptorPath: join(tempRoot, `${name}.json`), storageStatePath: "" };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config });
  return { worker, locks: chatGptAccountBrowserLocks(chatGptAccountKey(config)) };
}

function runStage<T>(worker: unknown, traceId: string, stage: string, timeoutMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return (ChatGptBrowserWorker.prototype as unknown as {
    runStage(traceId: string, stage: string, timeoutMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
  }).runStage.call(worker, traceId, stage, timeoutMs, action);
}

test("heavy page phases of one account take turns in FIFO order, while waiting for a model answer is never locked", async () => {
  const { worker } = lockedWorker("fifo");
  const events: string[] = [];
  let releaseSend!: () => void;
  const send = runStage(worker, "trace_a", "send", 10_000, async () => {
    events.push("a:send:start");
    await new Promise<void>(resolve => { releaseSend = resolve; });
    events.push("a:send:end");
  });
  await Bun.sleep(5);
  const page = runStage(worker, "trace_b", "browser_page", 10_000, async () => { events.push("b:browser_page"); });
  const ack = runStage(worker, "trace_c", "multipart_stage_2_acknowledgement", 10_000, async () => { events.push("c:ack"); });
  const answer = runStage(worker, "trace_d", "response", 10_000, async () => { events.push("d:response"); });
  await answer;
  await Bun.sleep(5);
  expect(events).toEqual(["a:send:start", "d:response"]);

  releaseSend();
  await Promise.all([send, page, ack]);
  expect(events).toEqual(["a:send:start", "d:response", "a:send:end", "b:browser_page", "c:ack"]);
});

test("time spent waiting for the heavy-phase lock does not spend the stage's own budget", async () => {
  const { worker } = lockedWorker("budget");
  const holding = runStage(worker, "trace_holder", "prompt_attachment", 10_000, () => Bun.sleep(150));
  await Bun.sleep(5);
  const startedAt = performance.now();
  expect(await within(runStage(worker, "trace_waiter", "effort_selection", 60, async () => {
    await Bun.sleep(20);
    return "selected";
  }))).toBe("selected");
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(120);
  await holding;
});

test("a rebind inside a send re-enters the turn's own lock instead of deadlocking", async () => {
  const { worker } = lockedWorker("reentrant");
  expect(await within(runStage(worker, "trace_nested", "send", 1_000, () => (
    runStage(worker, "trace_nested", "response_page_rebind_1", 1_000, async () => "rebound")
  )))).toBe("rebound");
  // The lock is free again for another turn.
  expect(await within(runStage(worker, "trace_other", "send", 1_000, async () => "sent"))).toBe("sent");
});

test("the heavy-phase list covers numbered stages and leaves model waits out", () => {
  for (const stage of [
    "browser_page", "temporary_chat_preparation", "effort_selection", "final_part_effort_selection",
    "prompt_attachment", "file_attachment", "send", "connector_catalog_refresh",
    "response_page_rebind_1", "response_page_rebind_12",
    "multipart_stage_1_attachment", "multipart_stage_10_send", "multipart_stage_3_acknowledgement",
  ]) {
    expect(isChatGptHeavyBrowserStage(stage)).toBeTrue();
  }
  for (const stage of ["response", "multipart_stage_x_send", "send_extra", "turn_opening_extra", "compaction_handoff"]) {
    expect(isChatGptHeavyBrowserStage(stage)).toBeFalse();
  }
});

test("two Temporary Chat openings on one account are at least 3 s apart, outside the stage budget", async () => {
  const { worker, locks } = lockedWorker("opening-spacing");
  locks.lastTemporaryChatOpeningAt = Date.now() - 2_800;
  const startedAt = performance.now();
  expect(await within(runStage(worker, "trace_opening", "temporary_chat_preparation", 50, async () => "opened"))).toBe("opened");
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(150);
  expect(Date.now() - locks.lastTemporaryChatOpeningAt).toBeLessThan(1_000);
});

test("a turn cancelled while it waits for the lock gives up its place", async () => {
  const lock = new ChatGptFifoLock();
  const holder = await lock.acquire("holder");
  const abort = new AbortController();
  const cancelled = lock.acquire("cancelled", abort.signal);
  const next = lock.acquire("next");
  expect(lock.queued).toBe(2);
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(lock.queued).toBe(1);
  holder.release();
  holder.release();
  const nextHold = await next;
  expect(lock.holds("next")).toBeTrue();
  expect(nextHold.queuedAhead).toBe(2);
  nextHold.release();
  expect(lock.holds("next")).toBeFalse();
});

test("two Bigger Context turns never interleave: the second stages its parts only after the first has sent its final part", async () => {
  const diagnostics = join(tempRoot, "multipart-diagnostics");
  const log: string[] = [];
  const finalResponse = new Error("fixture reached final response observation");
  let releaseFirstSend!: () => void;
  const firstSendGate = new Promise<void>(resolve => { releaseFirstSend = resolve; });
  const page = { evaluate: async () => ({}), isClosed: () => false };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: {
      appName: "Codex Native2",
      browserHost: "launcher",
      browserHostDescriptorPath: join(tempRoot, "multipart-lock.json"),
      browserDiagnosticsPath: diagnostics,
    },
    runStage: async (trace: string, name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      log.push(`${trace}:${name}:start`);
      if (trace === "turn_first_bigger" && name === "send") await firstSendGate;
      const value = await action(new AbortController().signal);
      log.push(`${trace}:${name}:end`);
      return value;
    },
    prepareTemporaryChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => resolveChatGptWebModelMode(model, effort, capabilities),
    captureSubmissionBaseline: async () => ({}),
    attachPrompt: async () => {},
    attachPromptWithIntegrityRetry: async () => {},
    attachFiles: async () => {},
    sendAttachedPrompt: async () => "user_turn",
    waitForNewAssistantTurn: async (...args: unknown[]) => {
      if (args[6] !== undefined) throw finalResponse;
      return {};
    },
    waitForMultipartAcknowledgement: async () => {},
  });
  const turn = (traceId: string) => (worker as unknown as {
    runBrowserTurn(turn: BrowserTurn, surface?: string, page?: unknown): Promise<string>;
  }).runBrowserTurn({
    traceId,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities,
    prepare: async () => ({
      text: "Summarize the context",
      images: [],
      multipart: { parts: ['{"part":1}', '{"part":2}', '{"part":3}'], commit: "Summarize" },
      release: () => {},
    }),
    onTextDelta() {},
  }, undefined, page);

  const firstOutcome = turn("turn_first_bigger").catch((error: unknown) => error);
  await Bun.sleep(10);
  const secondOutcome = turn("turn_second_bigger").catch((error: unknown) => error);
  await Bun.sleep(20);
  expect(log.filter(entry => entry.startsWith("turn_second_bigger:multipart_stage"))).toEqual([]);
  expect(log).toContain("turn_first_bigger:send:start");

  releaseFirstSend();
  expect(await firstOutcome).toBe(finalResponse);
  expect(await secondOutcome).toBe(finalResponse);
  const firstSendEnd = log.indexOf("turn_first_bigger:send:end");
  const secondFirstStage = log.indexOf("turn_second_bigger:multipart_stage_1_attachment:start");
  expect(firstSendEnd).toBeGreaterThan(0);
  expect(secondFirstStage).toBeGreaterThan(firstSendEnd);
  rmSync(diagnostics, { recursive: true, force: true });
});

function compactionRequest(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_admission_compaction",
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

test("a compaction handoff held at the admission gate keeps its deadline and one-shot transaction until it is admitted", async () => {
  const sourceRequest = compactionRequest(false);
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
    cancel() {},
  });
  const store = new CompactionTransactionStore();
  let handle: CompactionTransactionHandle | undefined;
  const broker = {
    beginCompactionTransaction: async (traceId: string, ttlMs: number) => {
      handle = store.begin(traceId, ttlMs);
      return handle;
    },
    waitForCompactionHandoff: (token: string, signal?: AbortSignal) => store.wait(token, signal),
    abortCompactionTransaction: (token: string) => store.abort(token),
    pauseCompactionTransaction: (token: string) => store.pause(token),
    resumeCompactionTransaction: (token: string, ttlMs: number) => store.resume(token, ttlMs),
  } as unknown as TurnBroker;
  const outer: string[] = [];
  const worker = {
    run: async (turn: BrowserTurn): Promise<string> => {
      turn.onAdmissionWait?.({ reason: "cooldown", position: 1, queued: 1, sendAt: Date.now() + 60_000, since: Date.now() });
      // Three times the handoff budget passes at the gate; nothing may expire meanwhile.
      await Bun.sleep(150);
      turn.onAdmitted?.();
      const prepared = await turn.prepareResume!();
      expect(prepared.text).toContain(handle!.token);
      store.submit(handle!.token, handle!.handoffId, "Checkpoint after the cooldown");
      return await new Promise<string>((_resolve, reject) => {
        const onAbort = () => reject(new DOMException("retained handoff browser closed", "AbortError"));
        if (turn.abortSignal?.aborted) onAbort();
        else turn.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };

  expect(await within(requestRetainedCompactionHandoff(
    worker as never,
    compactionRequest(true),
    source,
    broker,
    { ...capabilities, localToolsEnabled: true },
    "trace_gate_handoff",
    undefined,
    50,
    { onAdmissionWait: () => outer.push("wait"), onAdmitted: () => outer.push("admitted") },
  ))).toBe("Checkpoint after the cooldown");
  expect(outer).toEqual(["wait", "admitted"]);
});
