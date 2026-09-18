import { expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { DrainGate } from "../src/drain-gate";
import { startServer } from "../src/server";
import { codex0154ResponseFailed, failedResponse, parseSseFrames, runCodex0154Turn } from "./support/codex-0154";

const decoder = new TextDecoder();

function turnBody(): string {
  return JSON.stringify({
    model: "chatgpt-web/high",
    stream: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue the task" }] }],
  });
}

function countingAdapter(): { constructions: () => number; factory: () => ProviderAdapter } {
  let constructions = 0;
  return {
    constructions: () => constructions,
    factory: () => {
      constructions += 1;
      return {
        name: "drain-hold-test",
        runTurn: async (_parsed, _incoming, emit) => {
          emit({ type: "text_delta", text: "ran after the drain", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      };
    },
  };
}

class StreamText {
  text = "";
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async until(predicate: (text: string) => boolean, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.text)) {
      if (Date.now() > deadline) throw new Error(`stream did not reach the expected state: ${JSON.stringify(this.text.slice(-400))}`);
      const chunk = await this.reader.read();
      if (chunk.done) break;
      this.text += decoder.decode(chunk.value, { stream: true });
    }
    return this.text;
  }

  async rest(): Promise<string> {
    for (;;) {
      const chunk = await this.reader.read();
      if (chunk.done) return this.text;
      this.text += decoder.decode(chunk.value, { stream: true });
    }
  }
}

const heartbeats = (text: string) => text.split("event: response.heartbeat").length - 1;

async function health(endpoint: string): Promise<Record<string, unknown>> {
  return await (await fetch(`${endpoint}/healthz`)).json() as Record<string, unknown>;
}

async function waitForHealth(endpoint: string, predicate: (health: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const current = await health(endpoint);
    if (predicate(current)) return current;
    if (Date.now() > deadline) throw new Error(`health did not reach the expected state: ${JSON.stringify(current)}`);
    await Bun.sleep(10);
  }
}

function control(endpoint: string, token: string, action: string): Promise<Response> {
  return fetch(`${endpoint}/admin/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
}

test("a drain gate lets waiting requests through on resume, times them out, and closes for good", async () => {
  const gate = new DrainGate();
  expect(await gate.wait(1_000)).toBe("resumed");
  gate.drain();
  const resumed = gate.wait(10_000);
  expect(gate.held).toBe(1);
  gate.resume();
  expect(await resumed).toBe("resumed");
  expect(gate.held).toBe(0);

  gate.drain();
  expect(await gate.wait(20)).toBe("timeout");
  const abort = new AbortController();
  const aborted = gate.wait(10_000, abort.signal);
  abort.abort();
  expect(await aborted).toBe("aborted");
  expect(gate.held).toBe(0);

  const closed = gate.wait(10_000);
  gate.close();
  expect(await closed).toBe("shutdown");
  gate.resume();
  expect(gate.isDraining).toBe(true);
  expect(await gate.wait(10_000)).toBe("shutdown");
});

test("a streamed turn that arrives during a drain waits with heartbeats and runs after resume", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const adapter = countingAdapter();
  const server = startServer(config, { adapterFactory: adapter.factory, drainHoldMs: 30_000, drainHeartbeatMs: 20 });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    expect((await control(endpoint, config.controlToken, "drain")).status).toBe(200);
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: turnBody(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = new StreamText(response.body!.getReader());
    await stream.until(text => heartbeats(text) >= 3);

    // Waiting is not an active turn: the drain can still prove idleness for its service operation.
    expect(await health(endpoint)).toMatchObject({
      accepting_turns: false,
      active_http_turns: 0,
      drain_held_requests: 1,
    });
    expect(adapter.constructions()).toBe(0);

    expect((await control(endpoint, config.controlToken, "resume")).status).toBe(200);
    const text = await stream.rest();
    const frames = parseSseFrames(text);
    expect(frames.some(frame => frame.event === "response.failed")).toBe(false);
    expect(frames.find(frame => frame.event === "response.completed")).toBeDefined();
    expect(text).toContain("ran after the drain");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(adapter.constructions()).toBe(1);
    await waitForHealth(endpoint, current => current.drain_held_requests === 0 && current.active_http_turns === 0);
  } finally {
    await server.stop(true);
  }
});

test("a drain that outlasts the hold asks Codex to wait 10 s and retry, never 'at capacity'", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const adapter = countingAdapter();
  const server = startServer(config, { adapterFactory: adapter.factory, drainHoldMs: 150, drainHeartbeatMs: 20 });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await control(endpoint, config.controlToken, "drain");
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: turnBody(),
    });
    const text = await response.text();
    expect(heartbeats(text)).toBeGreaterThanOrEqual(1);
    const failed = failedResponse(parseSseFrames(text));
    expect(failed?.error).toMatchObject({ code: "rate_limit_exceeded", bridge_code: "service_draining" });
    expect(String((failed!.error as { message: string }).message)).toContain("Please try again in 10s.");
    expect(codex0154ResponseFailed(failed)).toMatchObject({ variant: "RateLimitExceeded", retryable: true, delayMs: 10_000 });
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(adapter.constructions()).toBe(0);
    expect(await health(endpoint)).toMatchObject({ drain_held_requests: 0, active_http_turns: 0 });
  } finally {
    warnings.mockRestore();
    await server.stop(true);
  }
});

test("shutting down a drained runtime answers a waiting turn with the paced retry first", async () => {
  // Shutdown requires zero browser turns in this process; other test files share its session registry.
  chatGptTurnSessions.clear();
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const adapter = countingAdapter();
  const server = startServer(config, { adapterFactory: adapter.factory, drainHoldMs: 30_000, drainHeartbeatMs: 20 });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await control(endpoint, config.controlToken, "drain");
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: turnBody(),
    });
    const stream = new StreamText(response.body!.getReader());
    await stream.until(text => heartbeats(text) >= 1);

    const shutdown = await control(endpoint, config.controlToken, "shutdown");
    expect(shutdown.status).toBe(200);
    expect(await shutdown.json()).toMatchObject({ status: "ok", active_http_turns: 0, active_browser_turns: 0 });

    const text = await stream.rest();
    const failed = failedResponse(parseSseFrames(text));
    expect(failed?.error).toMatchObject({ code: "rate_limit_exceeded", bridge_code: "service_draining" });
    expect(codex0154ResponseFailed(failed)).toMatchObject({ variant: "RateLimitExceeded", delayMs: 10_000 });
    expect(adapter.constructions()).toBe(0);
  } finally {
    warnings.mockRestore();
    await server.stop(true);
  }
});

test("an error answer that arrives after the drain ends keeps HTTP's terminal meaning inside the stream", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const adapter = countingAdapter();
  const server = startServer(config, { adapterFactory: adapter.factory, drainHoldMs: 30_000, drainHeartbeatMs: 20 });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await control(endpoint, config.controlToken, "drain");
    let requests = 0;
    const turn = runCodex0154Turn(async () => {
      requests += 1;
      return await fetch(`${endpoint}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ model: "chatgpt-web/not-enabled", stream: true, input: "test" }),
      });
    });
    await waitForHealth(endpoint, current => current.drain_held_requests === 1);
    await control(endpoint, config.controlToken, "resume");
    // Without a drain this request is an HTTP 400, which Codex never retries; waiting for the drain
    // moved it into the stream, where it must stay terminal and keep the bridge's own text.
    const result = await turn;
    expect(result.requests).toBe(1);
    expect(requests).toBe(1);
    expect(result.final?.variant).toBe("InvalidRequest");
    expect(result.final?.shown).toContain("chatgpt-web/not-enabled");
    expect(adapter.constructions()).toBe(0);
  } finally {
    warnings.mockRestore();
    await server.stop(true);
  }
});

test("a client that leaves while its turn waits for the drain leaves nothing behind", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const adapter = countingAdapter();
  const server = startServer(config, { adapterFactory: adapter.factory, drainHoldMs: 30_000, drainHeartbeatMs: 20 });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    await control(endpoint, config.controlToken, "drain");
    const abort = new AbortController();
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: turnBody(),
      signal: abort.signal,
    });
    const stream = new StreamText(response.body!.getReader());
    await stream.until(text => heartbeats(text) >= 1);
    expect((await health(endpoint)).drain_held_requests).toBe(1);
    abort.abort();
    await waitForHealth(endpoint, current => current.drain_held_requests === 0);
    await control(endpoint, config.controlToken, "resume");
    await Bun.sleep(50);
    expect(adapter.constructions()).toBe(0);
    expect(await health(endpoint)).toMatchObject({ active_http_turns: 0, drain_held_requests: 0 });
  } finally {
    await server.stop(true);
  }
});

test("a drained runtime refuses a non-stream turn and the model catalog at once, without 'at capacity'", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const adapter = countingAdapter();
  const server = startServer(config, { adapterFactory: adapter.factory, drainHoldMs: 30_000 });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    await control(endpoint, config.controlToken, "drain");
    const started = Date.now();
    const turn = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/high", input: "test", stream: false }),
    });
    expect(turn.status).toBe(503);
    expect(await turn.json()).toMatchObject({
      error: { type: "server_error", code: "service_unavailable", message: "codex-chatgpt-web is draining for a requested service operation" },
    });
    const models = await fetch(`${endpoint}/v1/models`);
    expect(models.status).toBe(503);
    expect((await models.json() as { error: { code: string } }).error.code).toBe("service_unavailable");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(adapter.constructions()).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("a compaction request during a drain waits, then runs on resume or gets a retryable 503", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const adapter = countingAdapter();
  const compactBody = JSON.stringify({
    model: "chatgpt-web/high",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Summarize the task" }] }],
  });
  const resumed = startServer(config, { adapterFactory: adapter.factory, drainHoldMs: 30_000 });
  const resumedEndpoint = `http://127.0.0.1:${resumed.port}`;
  try {
    await control(resumedEndpoint, config.controlToken, "drain");
    const pending = fetch(`${resumedEndpoint}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: compactBody,
    });
    await waitForHealth(resumedEndpoint, current => current.drain_held_requests === 1);
    expect((await health(resumedEndpoint)).active_http_turns).toBe(0);
    expect(adapter.constructions()).toBe(0);
    await control(resumedEndpoint, config.controlToken, "resume");
    const compacted = await pending;
    expect(compacted.status).toBe(200);
    expect(JSON.stringify(await compacted.json())).toContain("ran after the drain");
    expect(adapter.constructions()).toBe(1);
  } finally {
    await resumed.stop(true);
  }

  const timedOut = startServer({ ...config }, { adapterFactory: adapter.factory, drainHoldMs: 100 });
  const timedOutEndpoint = `http://127.0.0.1:${timedOut.port}`;
  try {
    await control(timedOutEndpoint, config.controlToken, "drain");
    const refused = await fetch(`${timedOutEndpoint}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: compactBody,
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("10");
    const error = (await refused.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("service_unavailable");
    expect(error.message).toContain("draining");
    expect(adapter.constructions()).toBe(1);
  } finally {
    await timedOut.stop(true);
  }
});
