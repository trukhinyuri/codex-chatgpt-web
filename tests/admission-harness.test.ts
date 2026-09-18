import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_ADAPTER_HEARTBEAT_MS, chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { ChatGptAdmissionGate } from "../src/adapters/chatgpt-web/rate-limit-gate";
import { chatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnRetryKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import { FakeGateClock, silentGateLog } from "./fixtures/fake-gate-clock";

const tempRoot = join(tmpdir(), `admission-harness-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
afterAll(() => {
  chatGptTurnSessions.clear();
  rmSync(tempRoot, { recursive: true, force: true });
});

const environmentXml = `<environment_context>
  <cwd>${tempRoot}</cwd>
  <filesystem><workspace_roots><root>${tempRoot}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function wireRequest(threadId: string, turnId: string): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "Inspect the project", timestamp: 2 }],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: environmentXml }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the project" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  };
}

type WorkerInternals = {
  admission?: ChatGptAdmissionGate;
  runExclusive: (turn: BrowserTurn) => Promise<string>;
  run: (turn: BrowserTurn) => Promise<string>;
};

test("a turn held by a ChatGPT cooldown keeps Codex alive with heartbeats, shows one status line, sends nothing and spends no retry", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://chatgpt-admission-heartbeat-${Date.now()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as WorkerInternals;
  const clock = new FakeGateClock(Date.now());
  const admission = new ChatGptAdmissionGate({ accountKey: "admission-heartbeat", clock, log: silentGateLog });
  admission.recordRateLimit();
  let browserCalls = 0;
  worker.admission = admission;
  worker.runExclusive = async turn => {
    browserCalls += 1;
    await turn.prepare();
    turn.onTextDelta("Done after the cooldown");
    return "Done after the cooldown";
  };
  const events: Array<{ at: number; event: AdapterEvent }> = [];
  const startedAt = Date.now();
  const request = wireRequest("thread_admission_heartbeat", "turn_admission_heartbeat");
  const retryKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnRetryKey(request)}`;
  const retryEntries = (chatGptWebTurnRetryPolicy as unknown as { entries: Map<string, unknown> }).entries;
  try {
    const running = createChatGptWebAdapter(provider).runTurn!(
      request,
      { headers: new Headers() },
      event => events.push({ at: Date.now() - startedAt, event }),
    );
    await Bun.sleep(CHATGPT_WEB_ADAPTER_HEARTBEAT_MS + 500);
    expect(browserCalls).toBe(0);
    expect(retryEntries.has(retryKey)).toBeFalse();
    expect(events.filter(entry => entry.event.type === "heartbeat").length).toBeGreaterThanOrEqual(2);
    expect(events.some(entry => entry.event.type === "error")).toBeFalse();
    const status = events
      .map(entry => entry.event)
      .filter((event): event is Extract<AdapterEvent, { type: "thinking_delta" }> => event.type === "thinking_delta");
    expect(status).toHaveLength(1);
    expect(status[0]!.thinking).toMatch(/^ChatGPT asked to slow down\. This step waits in the bridge and will be sent at about \d\d:\d\d \(position 1 in the queue\)\. Nothing to do\.$/);

    await clock.advance(60_000);
    await running;
    expect(browserCalls).toBe(1);
    expect(retryEntries.has(retryKey)).toBeFalse();
    expect(events.at(-1)?.event).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect(events.some(entry => entry.event.type === "error")).toBeFalse();
  } finally {
    delete (worker as Partial<WorkerInternals>).admission;
    delete (worker as Partial<WorkerInternals>).runExclusive;
  }
}, 30_000);

test("a ChatGPT rate limit before Send is waited out inside the bridge: Codex sees no error and no retry is spent", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://chatgpt-admission-requeue-${Date.now()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as WorkerInternals;
  const clock = new FakeGateClock(Date.now());
  worker.admission = new ChatGptAdmissionGate({ accountKey: "admission-requeue", clock, log: silentGateLog });
  let browserCalls = 0;
  worker.runExclusive = async turn => {
    browserCalls += 1;
    await turn.prepare();
    if (browserCalls === 1) {
      throw new ChatGptWebAdapterError("ChatGPT rate limit: too many requests. Please try again in 60s.", {
        status: 429,
        errorType: "rate_limit_error",
        code: "rate_limit_exceeded",
        retryable: true,
      });
    }
    await turn.onSendActivated?.();
    turn.onSubmitted?.();
    turn.onTextDelta("Sent after the pause");
    return "Sent after the pause";
  };
  const request = wireRequest("thread_admission_requeue", "turn_admission_requeue");
  const retryKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnRetryKey(request)}`;
  const retryEntries = (chatGptWebTurnRetryPolicy as unknown as { entries: Map<string, unknown> }).entries;
  const events: AdapterEvent[] = [];
  try {
    const running = createChatGptWebAdapter(provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
    await Bun.sleep(20);
    expect(browserCalls).toBe(1);
    expect(retryEntries.has(retryKey)).toBeFalse();
    expect(events.some(event => event.type === "error")).toBeFalse();
    expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(1);

    await clock.advance(60_000);
    await running;
    expect(browserCalls).toBe(2);
    expect(retryEntries.has(retryKey)).toBeFalse();
    expect(events.some(event => event.type === "error")).toBeFalse();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    delete (worker as Partial<WorkerInternals>).admission;
    delete (worker as Partial<WorkerInternals>).runExclusive;
  }
});

test("a tool-capable turn relays the gate's status line to Codex before its capability exists", async () => {
  const socketPath = join(tmpdir(), `cgw-admission-relay-${process.pid}-${Date.now()}.sock`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://chatgpt-admission-relay-${Date.now()}`,
    chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, extraHighAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as WorkerInternals;
  const originalRun = worker.run;
  let admit!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  worker.run = async turn => {
    turn.onReasoningSummary?.("ChatGPT asked to slow down. This step waits in the bridge and will be sent at about 14:54 (position 1 in the queue). Nothing to do.");
    await admitted;
    const prepared = await turn.prepare();
    prepared.release();
    turn.onTextDelta("Tool-capable answer");
    return "Tool-capable answer";
  };
  const events: AdapterEvent[] = [];
  try {
    const running = createChatGptWebAdapter(provider).runTurn!(
      wireRequest("thread_admission_relay", "turn_admission_relay"),
      { headers: new Headers() },
      event => events.push(event),
    );
    await Bun.sleep(50);
    expect(events.filter(event => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", thinking: "ChatGPT asked to slow down. This step waits in the bridge and will be sent at about 14:54 (position 1 in the queue). Nothing to do." },
    ]);
    admit();
    await running;
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
  }
});
