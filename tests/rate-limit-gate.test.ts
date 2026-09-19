import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_ADMISSION_MAX_WAIT_MS,
  ChatGptAdmissionGate,
  chatGptAccountKey,
  formatChatGptAdmissionStatus as gateStatusLine,
  formatChatGptClockTime,
  isChatGptLocalAdmissionRefusal,
  type ChatGptAdmissionStatus,
  type ChatGptAdmissionTicket,
} from "../src/adapters/chatgpt-web/rate-limit-gate";
import { ChatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";
import type { CodexProviderConfig } from "../src/types";
import { FakeGateClock as FakeClock, flushMicrotasks as flush, silentGateLog } from "./fixtures/fake-gate-clock";

const silentLog = silentGateLog;
const directories: string[] = [];

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "rate-limit-gate-"));
  directories.push(directory);
  return join(directory, "state", "chatgpt-rate-limit.json");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// An incident at 17:33:23 local time, 18.09: its 60-s pause ended at 17:34:23, when three waiting
// turns started in the same second and two of them met the limit again at 17:34:36.
const START = new Date(2026, 8, 18, 17, 33, 23).getTime();

function gateAt(clock: FakeClock, path?: string, log: Pick<Console, "info" | "warn"> = silentLog): ChatGptAdmissionGate {
  return new ChatGptAdmissionGate({ accountKey: "account", ...(path ? { statePath: path } : {}), clock, log });
}

function rateLimit(seconds = 60): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(`ChatGPT rate limit: too many requests. Please try again in ${seconds}s.`, {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
}

function somethingWentWrong(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

/** Tracks one queued turn without awaiting it. */
function enqueue(gate: ChatGptAdmissionGate, traceId: string, signal?: AbortSignal) {
  const statuses: ChatGptAdmissionStatus[] = [];
  const entry: {
    ticket?: ChatGptAdmissionTicket;
    error?: unknown;
    statuses: ChatGptAdmissionStatus[];
    promise: Promise<void>;
  } = { statuses, promise: Promise.resolve() };
  entry.promise = gate.awaitReady({ traceId, ...(signal ? { signal } : {}), onStatus: status => statuses.push(status) })
    .then(ticket => { entry.ticket = ticket; }, error => { entry.error = error; });
  return entry;
}

async function admitNow(gate: ChatGptAdmissionGate, traceId: string): Promise<ChatGptAdmissionTicket> {
  const entry = enqueue(gate, traceId);
  await flush();
  if (!entry.ticket) throw new Error(`${traceId} was not admitted`);
  return entry.ticket;
}

test("five parallel failures of one incident pause the account for 60 s, not 300", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  const tickets: ChatGptAdmissionTicket[] = [];
  for (let index = 0; index < 5; index += 1) {
    tickets.push(await admitNow(gate, `turn_${index}`));
    await clock.advance(3_000);
  }
  await clock.advance(20_000);

  const surfaced = tickets.map(ticket => gate.classifyFailure(rateLimit(), ticket));
  for (const ticket of tickets) ticket.finish("rate_limited");

  expect(surfaced.map(error => error?.message)).toEqual(
    Array.from({ length: 5 }, () => "ChatGPT rate limit: too many requests. Please try again in 60s."),
  );
  expect(gate.snapshot()).toMatchObject({ tier: 1, cooldownUntil: clock.now() + 60_000, probeRequired: true });
});

test("a failed probe escalates one step per incident, the pause caps at 300 s, and a quiet period restarts it", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  expect(gate.recordRateLimit()).toBe(60);
  // Turns that started after each incident are that incident's probes; their limit is a new step.
  // A same-incident limit every ten minutes keeps the escalation alive without counting towards
  // the three-incidents pause, which needs three steps inside thirty minutes.
  const probeFails = async (afterMs: number, expected: number) => {
    await clock.advance(afterMs);
    const admittedAt = clock.now();
    await clock.advance(1_000);
    expect(gate.recordRateLimit(admittedAt)).toBe(expected);
  };
  const sameIncident = async (afterMs: number) => {
    await clock.advance(afterMs);
    gate.recordRateLimit(0);
  };
  await sameIncident(10 * 60_000);
  await probeFails(6 * 60_000, 120);
  await sameIncident(10 * 60_000);
  await probeFails(6 * 60_000, 240);
  await sameIncident(10 * 60_000);
  await probeFails(6 * 60_000, 300);
  expect(gate.snapshot().state).not.toBe("paused");

  await clock.advance(300_000 + 10 * 60_000 + 1);
  await probeFails(0, 60);
});

test("a turn arriving during a cooldown waits inside the bridge, says when it will be sent, and starts when the pause ends", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  gate.recordRateLimit();
  await clock.advance(15_000);

  const waiting = enqueue(gate, "turn_waiting");
  await flush();
  expect(waiting.ticket).toBeUndefined();
  expect(waiting.error).toBeUndefined();
  expect(waiting.statuses).toEqual([{
    reason: "cooldown",
    position: 1,
    queued: 1,
    sendAt: START + 60_000,
    since: START + 15_000,
  }]);

  await clock.advance(44_999);
  expect(waiting.ticket).toBeUndefined();
  await clock.advance(1);
  expect(waiting.ticket).toMatchObject({ traceId: "turn_waiting", probe: true, admittedAt: START + 60_000, waitedMs: 45_000 });
});

test("the status line names the send time and the queue position and asks nothing of the user", () => {
  const sendAt = new Date(2026, 8, 18, 14, 54, 10).getTime();
  const line = gateStatusLine({ reason: "cooldown", position: 2, queued: 3, sendAt, since: sendAt - 60_000 });
  expect(line).toBe("ChatGPT asked to slow down. This step waits in the bridge and will be sent at about 14:54 (position 2 in the queue). Nothing to do.");
  expect(gateStatusLine({ reason: "spacing", position: 1, queued: 1, since: sendAt })).toBeUndefined();
  for (const reason of ["probe", "recovery", "capacity"] as const) {
    expect(gateStatusLine({ reason, position: 4, queued: 4, since: sendAt })).toMatch(/\(position 4 in the queue\)\. Nothing to do\.$/);
  }
});

test("after a cooldown one probe starts; the rest wait for its accepted submission and never start in the same second (17:34:23–36)", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  gate.recordRateLimit();
  const waiting = ["turn_a", "turn_b", "turn_c"].map(traceId => enqueue(gate, traceId));
  await flush();

  await clock.advance(60_000);
  const admitted = () => waiting.filter(entry => entry.ticket);
  expect(admitted().map(entry => entry.ticket!.traceId)).toEqual(["turn_a"]);
  expect(waiting[0]!.ticket!.probe).toBeTrue();
  expect(waiting[1]!.statuses.at(-1)?.reason).toBe("probe");

  // Nothing else starts while the probe has not yet been accepted by ChatGPT.
  await clock.advance(13_000);
  expect(admitted()).toHaveLength(1);

  // Accepted: the probe proves ChatGPT takes messages again. The ceiling is still one send slot,
  // which the probe holds until it hands work to Codex or completes.
  waiting[0]!.ticket!.submissionAccepted();
  await flush();
  expect(admitted()).toHaveLength(1);
  waiting[0]!.ticket!.finish("clean");
  await flush();
  expect(admitted().map(entry => entry.ticket!.traceId)).toEqual(["turn_a", "turn_b"]);
  waiting[1]!.ticket!.finish("clean");
  await flush();
  expect(admitted()).toHaveLength(2);
  await clock.advance(10_000);
  expect(admitted().map(entry => entry.ticket!.traceId)).toEqual(["turn_a", "turn_b", "turn_c"]);

  const starts = admitted().map(entry => entry.ticket!.admittedAt);
  for (let index = 1; index < starts.length; index += 1) {
    expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(10_000);
    expect(Math.floor(starts[index]! / 1_000)).not.toBe(Math.floor(starts[index - 1]! / 1_000));
  }
});

test("a probe that fails for another reason hands the probe to the next turn at least 10 s later", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  gate.recordRateLimit();
  const first = enqueue(gate, "turn_first");
  const second = enqueue(gate, "turn_second");
  await clock.advance(60_000);
  expect(first.ticket?.probe).toBeTrue();
  first.ticket!.finish("failed");
  await flush();
  expect(second.ticket).toBeUndefined();
  await clock.advance(10_000);
  expect(second.ticket).toMatchObject({ probe: true, admittedAt: START + 70_000 });
});

test("before any incident five turns run and a sixth waits in FIFO order instead of failing; an abort frees its place", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  const running: ChatGptAdmissionTicket[] = [];
  for (let index = 0; index < 5; index += 1) {
    running.push(await admitNow(gate, `turn_${index}`));
    await clock.advance(3_000);
  }
  const abort = new AbortController();
  const sixth = enqueue(gate, "turn_6", abort.signal);
  const seventh = enqueue(gate, "turn_7");
  await clock.advance(60_000);
  expect(sixth.ticket).toBeUndefined();
  expect(sixth.error).toBeUndefined();
  expect(sixth.statuses.at(-1)).toMatchObject({ reason: "capacity", position: 1 });
  expect(seventh.statuses.at(-1)).toMatchObject({ reason: "capacity", position: 2 });

  const reason = new Error("a newer Codex instruction superseded this turn");
  abort.abort(reason);
  await flush();
  expect(sixth.error).toMatchObject({ name: "AbortError" });
  // The reason survives, so the caller can tell a superseded turn from a user cancellation.
  expect((sixth.error as Error).cause).toBe(reason);
  running[0]!.finish("clean");
  await flush();
  expect(seventh.ticket?.traceId).toBe("turn_7");
  expect(gate.snapshot()).toMatchObject({ queued: 0, active: 5 });
});

test("a turn that waits for tool results still holds its browser tab, so a sixth waits for a tab", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  const running: ChatGptAdmissionTicket[] = [];
  for (let index = 0; index < 5; index += 1) {
    running.push(await admitNow(gate, `turn_${index}`));
    await clock.advance(3_000);
  }
  // Four parents hand work to Codex: they send nothing, but their tabs stay open in the launcher,
  // which holds at most five.
  for (const ticket of running.slice(0, 4)) ticket.setWaitingForTools(true);
  const sixth = enqueue(gate, "turn_6");
  await clock.advance(60_000);
  expect(sixth.ticket).toBeUndefined();
  expect(sixth.statuses.at(-1)).toMatchObject({ reason: "capacity", position: 1 });
  running[4]!.finish("clean");
  await flush();
  expect(sixth.ticket?.traceId).toBe("turn_6");
});

test("time the computer spends asleep does not count towards the 15-minute limit", async () => {
  class SleepingClock extends FakeClock {
    slept = 0;
    suspendedMs(): number {
      return this.slept;
    }
  }
  const clock = new SleepingClock(START);
  const gate = gateAt(clock);
  for (let index = 0; index < 5; index += 1) {
    await admitNow(gate, `turn_${index}`);
    await clock.advance(3_000);
  }
  const waiting = enqueue(gate, "turn_waiting");
  await clock.advance(5 * 60_000);
  // The lid was closed for an hour.
  clock.slept += 60 * 60_000;
  await clock.advance(60 * 60_000);
  expect(waiting.error).toBeUndefined();
  await clock.advance(10 * 60_000 - 1);
  expect(waiting.error).toBeUndefined();
  await clock.advance(1);
  expect(waiting.error).toMatchObject({ code: "invalid_prompt", errorType: "chatgpt_admission_wait_exceeded" });
});

test("new turns open at least 3 s apart even without an incident", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  const entries = ["turn_1", "turn_2", "turn_3"].map(traceId => enqueue(gate, traceId));
  await flush();
  expect(entries.filter(entry => entry.ticket)).toHaveLength(1);
  await clock.advance(2_999);
  expect(entries.filter(entry => entry.ticket)).toHaveLength(1);
  await clock.advance(1);
  expect(entries.filter(entry => entry.ticket)).toHaveLength(2);
  await clock.advance(3_000);
  expect(entries.map(entry => entry.ticket!.admittedAt)).toEqual([START, START + 3_000, START + 6_000]);
  // A plain opening gap is not worth a line in Codex.
  expect(entries.flatMap(entry => entry.statuses)).toEqual([]);
});

test("after an incident the ceiling is one and grows with each clean completion and with time", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  gate.recordRateLimit();
  const entries = ["p", "a", "b", "c"].map(traceId => enqueue(gate, traceId));
  await clock.advance(60_000);
  const probe = entries[0]!.ticket!;
  probe.submissionAccepted();
  probe.finish("clean");
  await clock.advance(10_000);
  expect(gate.snapshot().limit).toBe(2);
  expect(entries.filter(entry => entry.ticket).map(entry => entry.ticket!.traceId)).toEqual(["p", "a"]);
  await clock.advance(10_000);
  expect(entries.filter(entry => entry.ticket).map(entry => entry.ticket!.traceId)).toEqual(["p", "a", "b"]);
  expect(gate.snapshot()).toMatchObject({ limit: 2, active: 2 });
  // A long generation must not starve the queue into the 15-minute limit: the ceiling also rises
  // once per two quiet minutes after the probe was accepted.
  await clock.advance(2 * 60_000);
  expect(gate.snapshot().limit).toBe(3);
  expect(entries[3]!.ticket?.traceId).toBe("c");
});

test("a turn that waits for Codex tool results holds no send slot, so its subagent starts (#397)", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  gate.recordRateLimit();
  const parent = enqueue(gate, "parent");
  await clock.advance(60_000);
  parent.ticket!.submissionAccepted();
  const subagent = enqueue(gate, "subagent");
  await clock.advance(30_000);
  expect(subagent.ticket).toBeUndefined();

  parent.ticket!.setWaitingForTools(true);
  await flush();
  expect(subagent.ticket?.traceId).toBe("subagent");
  expect(gate.snapshot()).toMatchObject({ limit: 1, active: 2, waitingForTools: 1 });

  // The parent resumes when the results arrive; it never waits for a slot to continue.
  parent.ticket!.setWaitingForTools(false);
  subagent.ticket!.finish("clean");
  parent.ticket!.finish("clean");
});

test("a finished turn whose tab stays retained holds no slot, so its owner's next turn is the probe", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  for (let index = 0; index < 5; index += 1) {
    (await admitNow(gate, `retained_${index}`)).finish("clean");
    await clock.advance(3_000);
  }
  gate.recordRateLimit();
  const next = enqueue(gate, "owner_next_turn");
  await clock.advance(60_000);
  expect(next.ticket).toMatchObject({ probe: true });
});

test("a turn that waited 15 minutes ends with invalid_prompt, the time it started waiting and one action", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  const running = [];
  for (let index = 0; index < 5; index += 1) {
    running.push(await admitNow(gate, `turn_${index}`));
    await clock.advance(3_000);
  }
  const since = clock.now();
  const waiting = enqueue(gate, "turn_waiting");
  await clock.advance(CHATGPT_ADMISSION_MAX_WAIT_MS - 1);
  expect(waiting.error).toBeUndefined();
  await clock.advance(1);
  expect(waiting.error).toMatchObject({
    name: "ChatGptWebAdapterError",
    // A client-error status: HTTP clients that retry 429 and 409 on their own must not retry this.
    status: 400,
    code: "invalid_prompt",
    errorType: "chatgpt_admission_wait_exceeded",
    retryable: false,
  });
  expect((waiting.error as Error).message).toBe(
    `ChatGPT asked to slow down, and this step waited in the bridge for 15 minutes (since ${formatChatGptClockTime(since)}) without being sent. Nothing was sent to ChatGPT. Send your message again.`,
  );
  expect(isChatGptLocalAdmissionRefusal(waiting.error)).toBeTrue();
});

test("three incidents in 30 minutes pause the account: waiting and new turns end with the time and one action", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  gate.recordRateLimit();
  const [first, second, behind] = ["turn_first", "turn_second", "turn_behind"].map(traceId => enqueue(gate, traceId));
  await clock.advance(60_000);
  expect(first!.ticket?.probe).toBeTrue();
  gate.classifyFailure(rateLimit(), first!.ticket);
  first!.ticket!.finish("rate_limited");
  expect(gate.snapshot()).toMatchObject({ state: "waiting", tier: 2 });

  await clock.advance(120_000);
  expect(second!.ticket?.probe).toBeTrue();
  gate.classifyFailure(rateLimit(), second!.ticket);
  second!.ticket!.finish("rate_limited");
  await flush();

  const snapshot = gate.snapshot();
  expect(snapshot.state).toBe("paused");
  const pausedUntil = snapshot.pausedUntil!;
  expect(pausedUntil).toBe(clock.now() + 30 * 60_000);
  expect(behind!.error).toMatchObject({ status: 400, code: "invalid_prompt", errorType: "chatgpt_account_paused", retryable: false });
  const late = await gate.awaitReady({ traceId: "turn_late" }).catch((error: unknown) => error);
  expect(late).toMatchObject({ code: "invalid_prompt", retryable: false });
  expect((late as Error).message).toBe(
    `ChatGPT asked this account to slow down 3 times in 30 minutes (last at ${formatChatGptClockTime(clock.now())}), so the bridge sends nothing to ChatGPT until ${formatChatGptClockTime(pausedUntil)}. This step was not sent. Send your message again after ${formatChatGptClockTime(pausedUntil)}.`,
  );

  await clock.advance(30 * 60_000);
  const after = enqueue(gate, "turn_after_pause");
  await flush();
  expect(after.ticket).toMatchObject({ probe: true });
});

test("'Something went wrong' shortly after a rate limit is the same limit and asks Codex to wait", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  expect(gate.classifyFailure(somethingWentWrong())).toBeUndefined();

  gate.classifyFailure(rateLimit());
  await clock.advance(79_000);
  const throttled = gate.classifyFailure(somethingWentWrong());
  expect(throttled).toMatchObject({ status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true });
  expect(throttled!.message).toBe(
    "ChatGPT rate limit: ChatGPT reported an error while this account was still throttled after \"Too many requests\". Please try again in 120s.",
  );
  expect(throttled!.cause).toBeInstanceOf(ChatGptWebAdapterError);

  await clock.advance(10 * 60_000 + 1);
  expect(gate.classifyFailure(somethingWentWrong())).toBeUndefined();
});

test("classification rewrites only ChatGPT rate-limit errors and keeps their retry contract", () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  const first = gate.classifyFailure(rateLimit())!;
  const second = gate.classifyFailure(rateLimit())!;

  expect(first.message).toBe("ChatGPT rate limit: too many requests. Please try again in 60s.");
  // Two failures at the same moment are one incident, not two escalation steps.
  expect(second.message).toBe("ChatGPT rate limit: too many requests. Please try again in 60s.");
  expect(second).toMatchObject({ status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true });
  expect(second.cause).toBeInstanceOf(ChatGptWebAdapterError);
  expect(gate.classifyFailure(new Error("ChatGPT stopped responding"))).toBeUndefined();
  expect(gate.snapshot().tier).toBe(1);
});

test("only a response served after the incident ends the escalation; an accepted submission or an earlier turn does not", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  const early = await admitNow(gate, "early");
  await clock.advance(1_000);
  gate.recordRateLimit();
  // A turn sent before the incident proves nothing about it by completing.
  early.finish("clean");
  expect(gate.snapshot().tier).toBe(1);

  const probe = enqueue(gate, "probe");
  await clock.advance(60_000);
  await clock.advance(1_000);
  expect(gate.recordRateLimit(probe.ticket!.admittedAt)).toBe(120);
  probe.ticket!.finish("rate_limited");
  const cooldownUntil = gate.snapshot().cooldownUntil;

  const next = enqueue(gate, "next_probe");
  await clock.advance(119_000);
  expect(next.ticket).toBeUndefined();
  expect(gate.snapshot().cooldownUntil).toBe(cooldownUntil);
  await clock.advance(1_000);
  next.ticket!.submissionAccepted();
  expect(gate.snapshot().tier).toBe(2);

  next.ticket!.finish("clean");
  expect(gate.snapshot().tier).toBe(0);
  // The next incident starts from the base pause again.
  expect(gate.recordRateLimit(clock.now())).toBe(60);
});

test("a restarted daemon says that it restored a saved cooldown", async () => {
  const clock = new FakeClock(START);
  const path = statePath();
  gateAt(clock, path).recordRateLimit();
  await clock.advance(50_000);
  const lines: string[] = [];
  const restarted = gateAt(clock, path, { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) });
  expect(lines.some(line => line.includes("cooldown restored") && line.includes("remainingSeconds=10"))).toBeTrue();
  expect(restarted.snapshot()).toMatchObject({ state: "waiting", cooldownUntil: START + 60_000, tier: 1 });

  const saved = JSON.parse(readFileSync(path, "utf8")) as { version: number; accounts: Record<string, Record<string, unknown>> };
  expect(saved.version).toBe(1);
  expect(Object.keys(saved.accounts.account!).sort()).toEqual([
    "failureTier", "incidentStartedAt", "incidents", "lastFailureAt", "lastLimitAt", "probeRequired",
    "recoveredSlots", "recovering", "recoveryStartedAt", "securityHoldAt", "securityHoldReason",
    "stoppedUntil", "tier", "until", "updatedAt",
  ].sort());
});

test("a cooldown written before a restart holds a new turn for exactly the time left", async () => {
  const clock = new FakeClock(START);
  const path = statePath();
  const writer = gateAt(clock, path);
  writer.recordRateLimit();
  writer.dispose();
  // Rewrite the saved state as the incident at 14:52:18 left it: 110 s of the pause remaining.
  const saved = JSON.parse(readFileSync(path, "utf8")) as { accounts: Record<string, Record<string, unknown>> };
  saved.accounts.account!.until = clock.now() + 110_000;
  saved.accounts.account!.updatedAt = clock.now() + 1;
  writeFileSync(path, JSON.stringify(saved));

  const restarted = gateAt(clock, path);
  const waiting = enqueue(restarted, "turn_after_restart");
  await clock.advance(109_999);
  expect(waiting.ticket).toBeUndefined();
  await clock.advance(1);
  expect(waiting.ticket).toMatchObject({ probe: true });
});

test("a corrupt state file is ignored and a pause far in the future is cut to 300 s", async () => {
  const clock = new FakeClock(START);
  const corruptPath = statePath();
  mkdirSync(dirname(corruptPath), { recursive: true });
  writeFileSync(corruptPath, "{not json");
  const warnings: string[] = [];
  const fresh = gateAt(clock, corruptPath, { info: () => {}, warn: line => warnings.push(String(line)) });
  expect(fresh.snapshot()).toMatchObject({ state: "normal", tier: 0 });
  expect(warnings.some(line => line.includes("ignored an unreadable"))).toBeTrue();
  expect(await admitNow(fresh, "turn_ok")).toBeDefined();

  const futurePath = statePath();
  mkdirSync(dirname(futurePath), { recursive: true });
  writeFileSync(futurePath, JSON.stringify({
    version: 1,
    accounts: {
      account: {
        until: START + 24 * 60 * 60_000,
        tier: 3,
        incidentStartedAt: START,
        lastLimitAt: START,
        incidents: [],
        stoppedUntil: START + 24 * 60 * 60_000,
        probeRequired: true,
        recovering: true,
        recoveryStartedAt: 0,
        recoveredSlots: 0,
        updatedAt: START,
      },
    },
  }));
  const clamped = gateAt(clock, futurePath).snapshot();
  expect(clamped.cooldownUntil).toBe(START + 300_000);
  expect(clamped.pausedUntil).toBe(START + 30 * 60_000);
});

test("the saved state is written atomically on every transition", () => {
  const clock = new FakeClock(START);
  const path = statePath();
  const gate = gateAt(clock, path);
  expect(existsSync(path)).toBeFalse();
  gate.recordRateLimit();
  const saved = JSON.parse(readFileSync(path, "utf8")) as { accounts: Record<string, { until: number; tier: number }> };
  expect(saved.accounts.account).toMatchObject({ until: START + 60_000, tier: 1 });
});

test("two configurations of one browser profile share one account key, one gate and one state", () => {
  const base = { adapter: "chatgpt-web" as const, baseUrl: "browser://chatgpt-shared-account" };
  const descriptor = join(tmpdir(), "shared-profile-descriptor.json");
  const first: CodexProviderConfig = { ...base, chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: descriptor } };
  const second: CodexProviderConfig = {
    ...base,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: descriptor, turnTimeoutMs: 120_000, autoApproveToolCalls: true },
  };
  expect(JSON.stringify(resolveBrowserConfig(first))).not.toBe(JSON.stringify(resolveBrowserConfig(second)));
  expect(chatGptAccountKey(resolveBrowserConfig(first))).toBe(chatGptAccountKey(resolveBrowserConfig(second)));

  const workers = [ChatGptBrowserWorker.forProvider(first), ChatGptBrowserWorker.forProvider(second)];
  expect(workers[0]).not.toBe(workers[1]);
  const gates = workers.map(worker => (worker as unknown as { admissionGate(): ChatGptAdmissionGate }).admissionGate());
  expect(gates[0]).toBe(gates[1]);

  const other: CodexProviderConfig = { ...base, chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: `${descriptor}.other` } };
  expect(chatGptAccountKey(resolveBrowserConfig(other))).not.toBe(chatGptAccountKey(resolveBrowserConfig(first)));
});

test("a local admission refusal never spends the retry budget; a real ChatGPT limit does", async () => {
  const clock = new FakeClock(START);
  const gate = gateAt(clock);
  gate.recordRateLimit();
  const refusal = await (async () => {
    try {
      gate.assertMaintenanceAllowed("smoke test");
    } catch (error) {
      return error as ChatGptWebAdapterError;
    }
    throw new Error("the smoke test was not refused during the cooldown");
  })();
  expect(refusal.message).toBe(
    `ChatGPT asked to slow down, so the smoke test sent nothing to ChatGPT. Run it again after ${formatChatGptClockTime(START + 60_000)}. Please try again in 60s.`,
  );
  expect(isChatGptLocalAdmissionRefusal(refusal)).toBeTrue();

  const policy = new ChatGptWebTurnRetryPolicy();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect(policy.recordRetryableFailure("turn", refusal)).toBe(refusal);
  }
  expect(policy.exhaustedError("turn")).toBeUndefined();
  for (let attempt = 0; attempt < 4; attempt += 1) policy.recordRetryableFailure("turn", rateLimit());
  expect(policy.exhaustedError("turn")).toBeDefined();
});
