import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { throwIfChatGptSessionFailureAlert } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_FAILURE_BASE_BACKOFF_MS,
  CHATGPT_FAILURE_MAX_BACKOFF_MS,
  ChatGptAdmissionGate,
  type ChatGptAdmissionTicket,
} from "../src/adapters/chatgpt-web/rate-limit-gate";
import {
  chatGptSecurityHoldError,
  isChatGptSecurityHoldError,
  isChatGptSecurityHoldText,
  throwIfChatGptSecurityHoldBanner,
  writeChatGptSecurityHoldDiagnostic,
} from "../src/adapters/chatgpt-web/security-hold";
import { FakeGateClock as FakeClock, flushMicrotasks as flush, silentGateLog } from "./fixtures/fake-gate-clock";

const directories: string[] = [];

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "security-hold-"));
  directories.push(created);
  return created;
}

function statePath(): string {
  return join(directory(), "state", "chatgpt-rate-limit.json");
}

afterEach(() => {
  for (const created of directories.splice(0)) rmSync(created, { recursive: true, force: true });
});

// The hold the owner's account received on 18.09.2026, after a day of parallel bridge traffic.
const START = new Date(2026, 8, 18, 17, 33, 23).getTime();

function gateAt(clock: FakeClock, path?: string, log = silentGateLog): ChatGptAdmissionGate {
  return new ChatGptAdmissionGate({ accountKey: "account", ...(path ? { statePath: path } : {}), clock, log });
}

function enqueue(gate: ChatGptAdmissionGate, traceId: string) {
  const entry: { ticket?: ChatGptAdmissionTicket; error?: unknown; promise: Promise<void> } = {
    promise: Promise.resolve(),
  };
  entry.promise = gate.awaitReady({ traceId })
    .then(ticket => { entry.ticket = ticket; }, error => { entry.error = error; });
  return entry;
}

function chatGptFailure(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

/** A locator whose text search reports the banner exactly once. */
function bannerScope(visible: boolean) {
  return { getByText: () => ({ last: () => ({ isVisible: async () => visible }) }) } as never;
}

test("ChatGPT's account-hold wording is recognised, and ordinary page text is not", () => {
  expect(isChatGptSecurityHoldText(
    "Suspicious activity detected. It looks like someone else may be using your ChatGPT account."
    + " Please secure your account to regain access to all features",
  )).toBeTrue();
  expect(isChatGptSecurityHoldText("It looks like someone else may be using your ChatGPT account")).toBeTrue();
  expect(isChatGptSecurityHoldText("Too many requests. You are making requests too quickly.")).toBeFalse();
  expect(isChatGptSecurityHoldText(undefined)).toBeFalse();
});

test("the account-hold banner ends the turn terminally with exactly one action", async () => {
  await expect(throwIfChatGptSecurityHoldBanner(bannerScope(false))).resolves.toBeUndefined();
  try {
    await throwIfChatGptSecurityHoldBanner(bannerScope(true));
    throw new Error("expected the account hold to end the turn");
  } catch (error) {
    expect(isChatGptSecurityHoldError(error)).toBeTrue();
    expect(error).toMatchObject({
      name: "ChatGptWebAdapterError",
      status: 403,
      errorType: "chatgpt_security_hold",
      // Codex retries every code it does not know; this is the one it treats as final.
      code: "invalid_prompt",
      retryable: false,
    });
    const message = String(error);
    expect(message).toContain("secure the account there and sign in again");
    // One action only: nothing else asks the user to do the product's work.
    expect(message).toContain("will not retry");
    expect(message).not.toContain("Reload ChatGPT");
    expect(message).not.toContain("retry the turn");
  }
});

test("a held account admits nothing, does not repeat, and does not expire by itself", async () => {
  const clock = new FakeClock(START);
  const path = statePath();
  const gate = gateAt(clock, path);
  const queued = [enqueue(gate, "turn_a"), enqueue(gate, "turn_b")];
  await flush();
  expect(queued[0]!.ticket).toBeDefined();

  gate.recordSecurityHold("suspicious_activity");
  await flush();

  // Every waiting turn ends at once, with the same terminal error.
  expect(isChatGptSecurityHoldError(queued[1]!.error)).toBeTrue();
  expect(gate.snapshot()).toMatchObject({
    state: "held",
    securityHoldAt: START,
    securityHoldReason: "suspicious_activity",
  });

  const refused = enqueue(gate, "turn_c");
  await flush();
  expect(refused.ticket).toBeUndefined();
  expect(isChatGptSecurityHoldError(refused.error)).toBeTrue();

  // Waiting does not release the hold: only a person who secured the account does.
  await clock.advance(6 * 60 * 60_000);
  const later = enqueue(gate, "turn_d");
  await flush();
  expect(later.ticket).toBeUndefined();
  expect(isChatGptSecurityHoldError(later.error)).toBeTrue();
  expect(() => gate.assertMaintenanceAllowed("smoke test")).toThrow("secure the account");

  // The hold survives a daemon restart through the same saved state.
  const restarted = gateAt(clock, path);
  expect(restarted.snapshot().state).toBe("held");

  restarted.clearSecurityHold();
  const resumed = enqueue(restarted, "turn_e");
  await flush();
  expect(resumed.ticket).toBeDefined();
  expect(restarted.snapshot().state).not.toBe("held");
});

test("a failure ChatGPT reports as an account hold becomes the account-wide hold", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock, statePath());
  const ticket = enqueue(gate, "turn_a");
  await flush();

  const wrapped = new Error("browser turn failed", {
    cause: chatGptSecurityHoldError("model_controls_missing", { diagnostic: "slider missing" }),
  });
  const classified = gate.classifySecurityHold(wrapped);
  expect(isChatGptSecurityHoldError(classified)).toBeTrue();
  expect(String(classified)).toContain("model and effort controls");
  expect(gate.snapshot()).toMatchObject({ state: "held", securityHoldReason: "model_controls_missing" });
  ticket.ticket?.finish("failed");

  // classifyFailure answers with the hold too, so a caller never requeues a held turn.
  expect(isChatGptSecurityHoldError(gate.classifyFailure(wrapped))).toBeTrue();
});

test("the hold diagnostic carries the reason and the account key, and no page text", () => {
  const target = join(directory(), "security-hold");
  const path = writeChatGptSecurityHoldDiagnostic({
    reason: "suspicious_activity",
    accountKey: "0123456789abcdef",
    detectedAt: new Date(START).toISOString(),
    diagnostic: "bridge stopped automatic turns for this account",
  }, target);
  expect(path).toBeDefined();
  expect(existsSync(path!)).toBeTrue();
  expect(readdirSync(target)).toHaveLength(1);
  const record = JSON.parse(readFileSync(path!, "utf8")) as Record<string, unknown>;
  expect(record).toEqual({
    version: 1,
    reason: "suspicious_activity",
    accountKey: "0123456789abcdef",
    detectedAt: new Date(START).toISOString(),
    diagnostic: "bridge stopped automatic turns for this account",
  });
  const serialized = JSON.stringify(record);
  expect(serialized).not.toContain("Suspicious activity detected");
  expect(serialized).not.toContain("chatgpt.com");
});

test("every ChatGPT-side failure paces the whole account, doubling to the five-minute ceiling", async () => {
  const clock = new FakeClock(START);
  const path = statePath();
  const gate = gateAt(clock, path);

  const first = await (async () => {
    const entry = enqueue(gate, "turn_a");
    await flush();
    return entry.ticket!;
  })();
  expect(gate.classifyFailure(chatGptFailure())).toBeUndefined();
  expect(gate.recordChatGptFailure(first)).toBe(CHATGPT_FAILURE_BASE_BACKOFF_MS / 1_000);
  first.finish("failed");

  // A second session of the same account waits for the same pause instead of sending at once.
  const queued = enqueue(gate, "turn_b");
  await flush();
  expect(queued.ticket).toBeUndefined();

  const seconds: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    await clock.advance(6 * 60_000);
    seconds.push(gate.recordChatGptFailure());
  }
  expect(seconds).toEqual([120, 240, 300, 300]);
  expect(CHATGPT_FAILURE_MAX_BACKOFF_MS / 1_000).toBe(300);

  // A clean turn proves ChatGPT serves the account again: the next failure starts from the base.
  await clock.advance(6 * 60_000);
  const clean = enqueue(gate, "turn_c");
  await flush();
  clean.ticket!.finish("clean");
  await clock.advance(1_000);
  expect(gate.recordChatGptFailure()).toBe(CHATGPT_FAILURE_BASE_BACKOFF_MS / 1_000);
});

test("the page-level alert check reports ChatGPT's account hold before any other alert", async () => {
  const page = {
    getByText: () => ({ last: () => ({ isVisible: async () => true }) }),
    // A held account also shows its ordinary alerts; the hold must win over every one of them.
    locator: () => ({ filter: () => ({ last: () => ({ isVisible: async () => true }) }) }),
  } as never;
  await expect(throwIfChatGptSessionFailureAlert(page)).rejects.toMatchObject({
    errorType: "chatgpt_security_hold",
    code: "invalid_prompt",
    retryable: false,
  });
});
