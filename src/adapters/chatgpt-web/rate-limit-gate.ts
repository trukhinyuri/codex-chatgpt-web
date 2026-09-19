import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir } from "../../config";
import { ChatGptWebAdapterError, chatGptTurnAbortError } from "./adapter-error";
import {
  chatGptSecurityHoldCause,
  chatGptSecurityHoldError,
  writeChatGptSecurityHoldDiagnostic,
  type ChatGptSecurityHoldReason,
} from "./security-hold";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import { chatGptSuspensionClock } from "./suspension-clock";

// ChatGPT answers a burst with a "Too many requests" dialog and asks to wait a few minutes. Codex
// retries a rate-limited stream five times with sub-second backoff unless the error names a delay
// as "Please try again in <n>s.", so every retry opened a fresh Temporary Chat and hit the same
// account limit again. The gate below keeps new turns inside the bridge until the account has
// cooled down, grows the pause once per incident, and restarts traffic with a single probe.
export const CHATGPT_RATE_LIMIT_BASE_COOLDOWN_MS = 60_000;
export const CHATGPT_RATE_LIMIT_MAX_COOLDOWN_MS = 300_000;
/** A quiet period this long after the last limit ends the escalation and the recovery ramp. */
export const CHATGPT_RATE_LIMIT_ESCALATION_RESET_MS = 10 * 60_000;
/** Minimum distance between two browser turns opening a Temporary Chat on one account. */
export const CHATGPT_ADMISSION_OPEN_SPACING_MS = 3_000;
/** Minimum distance between releases while the account recovers from a rate limit. */
export const CHATGPT_ADMISSION_RECOVERY_SPACING_MS = 10_000;
/** A turn that waited this long inside the bridge ends with one clear instruction instead. */
export const CHATGPT_ADMISSION_MAX_WAIT_MS = 15 * 60_000;
export const CHATGPT_RATE_LIMIT_INCIDENT_WINDOW_MS = 30 * 60_000;
/** This many incidents inside the window pause the whole account instead of probing again. */
export const CHATGPT_RATE_LIMIT_INCIDENT_STOP_COUNT = 3;
/**
 * After the probe is accepted, one more concurrent turn is allowed for every clean completion and
 * also for every interval without a new limit, so one long generation cannot starve the queue into
 * the terminal wait limit.
 */
export const CHATGPT_ADMISSION_RAMP_INTERVAL_MS = 2 * 60_000;
/**
 * Every failure ChatGPT itself ends a turn with pauses the whole account, not just that turn. On
 * 18.09 failed turns were repeated every 25 seconds across up to six Codex threads on one account,
 * which is the pattern an account check reacts to. The pause starts at the base cooldown and
 * doubles per consecutive failure up to the maximum, shared by every session of the account.
 */
export const CHATGPT_FAILURE_BASE_BACKOFF_MS = CHATGPT_RATE_LIMIT_BASE_COOLDOWN_MS;
export const CHATGPT_FAILURE_MAX_BACKOFF_MS = CHATGPT_RATE_LIMIT_MAX_COOLDOWN_MS;

/** Shortest wake-up delay, so an inconsistent schedule can never become a busy loop. */
const MIN_WAKE_DELAY_MS = 250;
const CHATGPT_RATE_LIMIT_RETRY_DELAY = /\s*Please try again in \d+s\.$/;
const STATE_FILE_VERSION = 1;
const LOCAL_REFUSAL = Symbol.for("codex-chatgpt-web.local-admission-refusal");

export function chatGptRateLimitError(message: string, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function withChatGptRetryDelay(message: string, seconds: number): string {
  return `${message.replace(CHATGPT_RATE_LIMIT_RETRY_DELAY, "")} Please try again in ${seconds}s.`;
}

export function isChatGptRateLimitError(error: unknown): error is ChatGptWebAdapterError {
  return error instanceof ChatGptWebAdapterError && error.code === "rate_limit_exceeded";
}

function isChatGptUpstreamServerError(error: unknown): error is ChatGptWebAdapterError {
  return error instanceof ChatGptWebAdapterError && error.code === "upstream_server_error";
}

/** True for an error the bridge raised itself without sending anything to ChatGPT. */
export function isChatGptLocalAdmissionRefusal(error: unknown): boolean {
  return error instanceof Error && (error as unknown as Record<symbol, unknown>)[LOCAL_REFUSAL] === true;
}

function markLocalRefusal<E extends Error>(error: E): E {
  Object.defineProperty(error, LOCAL_REFUSAL, { value: true });
  return error;
}

/** Local wall-clock time as HH:MM, the form the user compares with their own clock. */
export function formatChatGptClockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The state belongs to the signed-in ChatGPT account, which the bridge can only know by the browser
 * profile that holds it: the launcher's browser host, or the managed Chrome storage state. Two
 * provider configurations that differ in anything else still share one account and one state.
 */
export function chatGptAccountKey(config: {
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  storageStatePath: string;
}): string {
  const identity = config.browserHost === "launcher"
    ? `launcher:${resolve(config.browserHostDescriptorPath ?? "")}`
    : `managed-chrome:${resolve(config.storageStatePath)}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

export function defaultChatGptRateLimitStatePath(): string {
  return join(getConfigDir(), "state", "chatgpt-rate-limit.json");
}

/** Persisted per account; every field is an epoch millisecond or a small count. */
export interface ChatGptRateLimitState {
  /** No new browser turn starts before this time. */
  until: number;
  /** Escalation step of the current incident; 0 when no escalation is in effect. */
  tier: number;
  /** When the current escalation step began. A turn admitted earlier belongs to it. */
  incidentStartedAt: number;
  /** The latest rate limit ChatGPT reported, counted or not. */
  lastLimitAt: number;
  /** Starts of escalation steps inside the incident window. */
  incidents: number[];
  /** Repeated incidents pause the whole account until this time. */
  stoppedUntil: number;
  /** After an incident one probe must be accepted before other turns start. */
  probeRequired: boolean;
  /** Concurrency is reduced until the ramp reaches the normal ceiling again. */
  recovering: boolean;
  /** When the probe was accepted; the ramp counts from here. */
  recoveryStartedAt: number;
  /** Clean completions of turns admitted after the incident. */
  recoveredSlots: number;
  /** Consecutive ChatGPT-side turn failures; it sets the shared failure backoff. */
  failureTier: number;
  /** The latest ChatGPT-side turn failure counted into the backoff. */
  lastFailureAt: number;
  /** ChatGPT is holding this account; no automatic turn starts until a person restores it. */
  securityHoldAt: number;
  securityHoldReason: ChatGptSecurityHoldReason | "";
  updatedAt: number;
}

function emptyState(): ChatGptRateLimitState {
  return {
    until: 0,
    tier: 0,
    incidentStartedAt: 0,
    lastLimitAt: 0,
    incidents: [],
    stoppedUntil: 0,
    probeRequired: false,
    recovering: false,
    recoveryStartedAt: 0,
    recoveredSlots: 0,
    failureTier: 0,
    lastFailureAt: 0,
    securityHoldAt: 0,
    securityHoldReason: "",
    updatedAt: 0,
  };
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseAccountState(value: unknown): ChatGptRateLimitState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const until = finiteTime(record.until);
  const tier = finiteTime(record.tier);
  const incidentStartedAt = finiteTime(record.incidentStartedAt);
  const lastLimitAt = finiteTime(record.lastLimitAt);
  if (until === undefined || tier === undefined || incidentStartedAt === undefined || lastLimitAt === undefined) {
    return undefined;
  }
  const incidents = Array.isArray(record.incidents)
    ? record.incidents.map(finiteTime).filter((entry): entry is number => entry !== undefined).slice(-16)
    : [];
  return {
    until,
    tier: Math.min(16, Math.floor(tier)),
    incidentStartedAt,
    lastLimitAt,
    incidents,
    stoppedUntil: finiteTime(record.stoppedUntil) ?? 0,
    probeRequired: record.probeRequired === true,
    recovering: record.recovering === true,
    recoveryStartedAt: finiteTime(record.recoveryStartedAt) ?? 0,
    recoveredSlots: Math.min(MAX_CHATGPT_BROWSER_TABS, Math.floor(finiteTime(record.recoveredSlots) ?? 0)),
    failureTier: Math.min(16, Math.floor(finiteTime(record.failureTier) ?? 0)),
    lastFailureAt: finiteTime(record.lastFailureAt) ?? 0,
    securityHoldAt: finiteTime(record.securityHoldAt) ?? 0,
    securityHoldReason: record.securityHoldReason === "suspicious_activity"
      || record.securityHoldReason === "model_controls_missing"
      ? record.securityHoldReason
      : "",
    updatedAt: finiteTime(record.updatedAt) ?? 0,
  };
}

interface StateFileRead {
  accounts: Record<string, unknown>;
  corrupt: boolean;
}

function readStateFile(path: string): StateFileRead {
  if (!existsSync(path)) return { accounts: {}, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { accounts: {}, corrupt: true };
    const accounts = (parsed as Record<string, unknown>).accounts;
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return { accounts: {}, corrupt: true };
    return { accounts: accounts as Record<string, unknown>, corrupt: false };
  } catch {
    return { accounts: {}, corrupt: true };
  }
}

export interface ChatGptGateClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Time this process spent suspended (system sleep); a sleeping laptop is not a waiting turn. */
  suspendedMs?(): number;
}

export const systemChatGptGateClock: ChatGptGateClock = {
  now: () => Date.now(),
  suspendedMs: () => {
    chatGptSuspensionClock.start();
    return chatGptSuspensionClock.suspendedMs();
  },
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref?.();
    return timer;
  },
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type ChatGptAdmissionWaitReason = "cooldown" | "probe" | "recovery" | "capacity" | "spacing";

export interface ChatGptAdmissionStatus {
  reason: ChatGptAdmissionWaitReason;
  /** 1-based place in this account's queue. */
  position: number;
  queued: number;
  /** For a cooldown: the earliest time the step can be sent. */
  sendAt?: number;
  /** When this turn first started to wait. */
  since: number;
}

/**
 * The one line Codex shows while a step waits inside the bridge. It says what happened, when the
 * step will go and that nobody needs to act; a plain 3-second opening gap is not worth a line.
 */
export function formatChatGptAdmissionStatus(status: ChatGptAdmissionStatus): string | undefined {
  const place = `position ${status.position} in the queue`;
  switch (status.reason) {
    case "cooldown":
      return `ChatGPT asked to slow down. This step waits in the bridge and will be sent at about ${formatChatGptClockTime(status.sendAt ?? status.since)} (${place}). Nothing to do.`;
    case "probe":
      return `ChatGPT asked to slow down. One request is checking that ChatGPT accepts messages again; this step follows it (${place}). Nothing to do.`;
    case "recovery":
      return `ChatGPT asked to slow down earlier, so steps restart one at a time. This step waits for its turn (${place}). Nothing to do.`;
    case "capacity":
      return `${MAX_CHATGPT_BROWSER_TABS} ChatGPT steps are already running. This step starts when one finishes (${place}). Nothing to do.`;
    case "spacing":
      return undefined;
  }
}

export type ChatGptAdmissionOutcome = "clean" | "failed" | "aborted" | "rate_limited";

export interface ChatGptAdmissionTicket {
  readonly traceId: string;
  readonly admittedAt: number;
  readonly probe: boolean;
  /** Total time this turn waited in the queue, across every requeue. */
  readonly waitedMs: number;
  /** A turn that waits for Codex tool results sends nothing, so it does not hold a send slot. */
  setWaitingForTools(waiting: boolean): void;
  /** ChatGPT accepted this turn's submission; a probe that gets here releases the queue. */
  submissionAccepted(): void;
  /** Releases the slot. Idempotent. */
  finish(outcome: ChatGptAdmissionOutcome): void;
}

export interface ChatGptAdmissionRequest {
  traceId: string;
  signal?: AbortSignal;
  onStatus?: (status: ChatGptAdmissionStatus) => void;
  /** A turn sent back to the queue keeps its place and its accumulated waiting time. */
  requeueOf?: ChatGptAdmissionTicket;
}

interface Waiter {
  seq: number;
  traceId: string;
  firstQueuedAt: number;
  enqueuedAt: number;
  suspendedAtEnqueue: number;
  waitedBeforeMs: number;
  resolve: (ticket: ChatGptAdmissionTicket) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  onStatus?: (status: ChatGptAdmissionStatus) => void;
  statusKey?: string;
  loggedReason?: ChatGptAdmissionWaitReason;
}

class AdmissionTicket implements ChatGptAdmissionTicket {
  waitingForTools = false;
  accepted = false;
  finished = false;

  constructor(
    private readonly gate: ChatGptAdmissionGate,
    readonly traceId: string,
    readonly seq: number,
    readonly firstQueuedAt: number,
    readonly admittedAt: number,
    readonly probe: boolean,
    readonly waitedMs: number,
  ) {}

  setWaitingForTools(waiting: boolean): void {
    if (this.finished || this.waitingForTools === waiting) return;
    this.waitingForTools = waiting;
    this.gate.ticketChanged();
  }

  submissionAccepted(): void {
    if (this.finished || this.accepted) return;
    this.accepted = true;
    this.gate.ticketAccepted(this);
  }

  finish(outcome: ChatGptAdmissionOutcome): void {
    if (this.finished) return;
    this.finished = true;
    this.gate.ticketFinished(this, outcome);
  }
}

export interface ChatGptAdmissionGateOptions {
  accountKey: string;
  statePath?: string;
  clock?: ChatGptGateClock;
  maxConcurrency?: number;
  log?: Pick<Console, "info" | "warn">;
}

export interface ChatGptAdmissionGateSnapshot {
  state: "normal" | "waiting" | "paused" | "held";
  /** When ChatGPT's account hold was first seen; the account takes no automatic turn until it clears. */
  securityHoldAt?: number;
  securityHoldReason?: ChatGptSecurityHoldReason;
  cooldownUntil?: number;
  pausedUntil?: number;
  tier: number;
  probeRequired: boolean;
  limit: number;
  queued: number;
  active: number;
  waitingForTools: number;
}

/**
 * Admission to ChatGPT for one account, owned by the daemon.
 *
 * Turns wait here, in FIFO order, while the account cools down, while the one probe after an
 * incident proves that ChatGPT accepts messages again, and while the adaptive concurrency ceiling
 * is full. Waiting sends nothing to ChatGPT; the caller keeps the Codex stream alive with its own
 * heartbeat. The state survives a daemon restart through an atomically written file.
 */
export class ChatGptAdmissionGate {
  readonly accountKey: string;
  private readonly statePath?: string;
  private readonly clock: ChatGptGateClock;
  private readonly maxConcurrency: number;
  private readonly log: Pick<Console, "info" | "warn">;
  private state: ChatGptRateLimitState = emptyState();
  private stateFileMtimeMs = -1;
  private readonly waiters: Waiter[] = [];
  private readonly tickets = new Set<AdmissionTicket>();
  private probeTicket?: AdmissionTicket;
  private lastAdmissionAt = 0;
  private nextSeq = 1;
  private timer?: unknown;
  private timerAt = Number.POSITIVE_INFINITY;
  private pumping = false;
  private pumpAgain = false;

  constructor(options: ChatGptAdmissionGateOptions) {
    this.accountKey = options.accountKey;
    this.statePath = options.statePath;
    this.clock = options.clock ?? systemChatGptGateClock;
    this.maxConcurrency = Math.max(1, Math.min(options.maxConcurrency ?? MAX_CHATGPT_BROWSER_TABS, MAX_CHATGPT_BROWSER_TABS));
    this.log = options.log ?? console;
    this.refreshFromDisk(true);
  }

  /** Waits until this turn may open ChatGPT. Rejects on abort, on the wait limit or on a pause. */
  awaitReady(request: ChatGptAdmissionRequest): Promise<ChatGptAdmissionTicket> {
    const previous = request.requeueOf instanceof AdmissionTicket ? request.requeueOf : undefined;
    if (request.signal?.aborted) return Promise.reject(chatGptTurnAbortError(request.signal));
    const now = this.clock.now();
    this.refreshFromDisk(false);
    this.normalize(now);
    if (this.state.securityHoldAt > 0) return Promise.reject(this.securityHoldError());
    if (now < this.state.stoppedUntil) return Promise.reject(this.pausedError(now));
    return new Promise<ChatGptAdmissionTicket>((resolveWait, rejectWait) => {
      const waiter: Waiter = {
        seq: previous?.seq ?? this.nextSeq++,
        traceId: request.traceId,
        firstQueuedAt: previous?.firstQueuedAt ?? now,
        enqueuedAt: now,
        suspendedAtEnqueue: this.suspendedMs(),
        waitedBeforeMs: previous?.waitedMs ?? 0,
        resolve: resolveWait,
        reject: rejectWait,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onStatus ? { onStatus: request.onStatus } : {}),
      };
      if (request.signal) {
        waiter.onAbort = () => {
          if (!this.removeWaiter(waiter)) return;
          rejectWait(chatGptTurnAbortError(request.signal));
          this.pump();
        };
        request.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      const index = this.waiters.findIndex(candidate => candidate.seq > waiter.seq);
      if (index < 0) this.waiters.push(waiter);
      else this.waiters.splice(index, 0, waiter);
      this.pump();
    });
  }

  /**
   * Records what ChatGPT reported for a failed turn. A rate limit, or an error ChatGPT raises while
   * the account is still throttled, becomes a rate limit with the remaining pause; everything
   * else is not the gate's business and returns undefined.
   */
  classifyFailure(error: unknown, ticket?: Pick<ChatGptAdmissionTicket, "admittedAt">): ChatGptWebAdapterError | undefined {
    const held = this.classifySecurityHold(error);
    if (held) return held;
    if (isChatGptRateLimitError(error)) {
      return chatGptRateLimitError(withChatGptRetryDelay(error.message, this.recordRateLimit(ticket?.admittedAt)), error);
    }
    if (isChatGptUpstreamServerError(error) && this.throttledRecently()) {
      return chatGptRateLimitError(withChatGptRetryDelay(
        "ChatGPT rate limit: ChatGPT reported an error while this account was still throttled after \"Too many requests\".",
        this.recordRateLimit(ticket?.admittedAt),
      ), error);
    }
    return undefined;
  }

  /**
   * Counts one ChatGPT rate limit and returns the whole seconds left to wait. The pause grows once
   * per incident: a turn admitted before the current incident began was sent into the same limit,
   * so its failure joins that incident instead of escalating it again.
   */
  recordRateLimit(admittedAt?: number): number {
    const now = this.clock.now();
    this.refreshFromDisk(false);
    this.normalize(now);
    const state = this.state;
    state.lastLimitAt = now;
    const sameIncident = state.tier > 0 && (admittedAt === undefined
      ? now < state.until
      : admittedAt < state.incidentStartedAt);
    if (sameIncident) {
      this.log.info(
        `[chatgpt-web] rate limit joined the current incident tier=${state.tier}`
        + ` remainingSeconds=${Math.max(0, Math.ceil((state.until - now) / 1_000))}`,
      );
    } else {
      state.tier += 1;
      state.incidentStartedAt = now;
      const delay = Math.min(
        CHATGPT_RATE_LIMIT_BASE_COOLDOWN_MS * 2 ** (state.tier - 1),
        CHATGPT_RATE_LIMIT_MAX_COOLDOWN_MS,
      );
      state.until = Math.min(Math.max(state.until, now + delay), now + CHATGPT_RATE_LIMIT_MAX_COOLDOWN_MS);
      state.incidents = [...state.incidents.filter(at => now - at < CHATGPT_RATE_LIMIT_INCIDENT_WINDOW_MS), now];
      state.probeRequired = true;
      state.recovering = true;
      state.recoveryStartedAt = 0;
      state.recoveredSlots = 0;
      // A probe still running from an earlier incident proves nothing about this one.
      this.probeTicket = undefined;
      if (state.incidents.length >= CHATGPT_RATE_LIMIT_INCIDENT_STOP_COUNT) {
        // Probing again would only add to what ChatGPT already counts against the account. The
        // pause lasts one full window, so the next start begins with a clean incident history.
        state.stoppedUntil = now + CHATGPT_RATE_LIMIT_INCIDENT_WINDOW_MS;
      }
      this.log.warn(
        `[chatgpt-web] rate-limit incident tier=${state.tier}`
        + ` cooldownSeconds=${Math.ceil((state.until - now) / 1_000)}`
        + ` incidentsIn30m=${state.incidents.length} queued=${this.waiters.length} active=${this.tickets.size}`
        + (now < state.stoppedUntil ? ` accountPausedUntil=${new Date(state.stoppedUntil).toISOString()}` : ""),
      );
    }
    this.persist(now);
    this.pump();
    return Math.max(1, Math.ceil((state.until - now) / 1_000));
  }

  /**
   * Turns ChatGPT's account-hold signal into the account-wide hold. The hold has no expiry: only a
   * person who secured the account and signed in again clears it, so nothing automatic can walk the
   * bridge back into the check that produced it.
   */
  classifySecurityHold(error: unknown): ChatGptWebAdapterError | undefined {
    const held = chatGptSecurityHoldCause(error);
    if (!held) return undefined;
    const reason: ChatGptSecurityHoldReason = held.message.includes("model and effort controls")
      ? "model_controls_missing"
      : "suspicious_activity";
    this.recordSecurityHold(reason);
    return this.securityHoldError();
  }

  /** Records ChatGPT's account hold, empties the queue and stops every automatic turn. */
  recordSecurityHold(reason: ChatGptSecurityHoldReason): void {
    const now = this.clock.now();
    this.refreshFromDisk(false);
    if (this.state.securityHoldAt === 0) {
      this.state.securityHoldAt = now;
      this.state.securityHoldReason = reason;
      this.log.warn(
        `[chatgpt-web] ChatGPT is holding this account (reason=${reason});`
        + ` the bridge stops automatic turns for it queued=${this.waiters.length} active=${this.tickets.size}`,
      );
      writeChatGptSecurityHoldDiagnostic({
        reason,
        accountKey: this.accountKey,
        detectedAt: new Date(now).toISOString(),
        diagnostic: "bridge stopped automatic turns for this account",
      });
      this.persist(now);
    }
    this.pump();
  }

  /** Clears the hold after a person secured the account and signed in again. */
  clearSecurityHold(): void {
    this.refreshFromDisk(false);
    if (this.state.securityHoldAt === 0) return;
    this.state.securityHoldAt = 0;
    this.state.securityHoldReason = "";
    this.log.info("[chatgpt-web] the ChatGPT account hold was cleared; automatic turns may start again");
    this.persist(this.clock.now());
    this.pump();
  }

  securityHoldError(): ChatGptWebAdapterError {
    const reason = (this.state.securityHoldReason || "suspicious_activity") as ChatGptSecurityHoldReason;
    return markLocalRefusal(chatGptSecurityHoldError(reason, {
      ...(this.state.securityHoldAt > 0 ? { heldSince: this.state.securityHoldAt } : {}),
    }));
  }

  /**
   * Counts one ChatGPT-side turn failure and pauses the whole account before the next send. The
   * pause doubles with every consecutive failure, from the base cooldown to the maximum, and a
   * quiet period clears it. Returns the whole seconds the account now waits.
   */
  recordChatGptFailure(ticket?: Pick<ChatGptAdmissionTicket, "admittedAt">): number {
    const now = this.clock.now();
    this.refreshFromDisk(false);
    this.normalize(now);
    const state = this.state;
    // A turn admitted before the pause that is already running was sent into the same trouble; it
    // must not double that pause a second time.
    if (state.failureTier > 0 && ticket?.admittedAt !== undefined && ticket.admittedAt < state.lastFailureAt) {
      return Math.max(0, Math.ceil((state.until - now) / 1_000));
    }
    state.failureTier = Math.min(16, state.failureTier + 1);
    state.lastFailureAt = now;
    const delay = Math.min(
      CHATGPT_FAILURE_BASE_BACKOFF_MS * 2 ** (state.failureTier - 1),
      CHATGPT_FAILURE_MAX_BACKOFF_MS,
    );
    state.until = Math.min(Math.max(state.until, now + delay), now + CHATGPT_RATE_LIMIT_MAX_COOLDOWN_MS);
    this.log.warn(
      "[chatgpt-web] ChatGPT ended a turn with an error; the account waits "
      + `${Math.ceil((state.until - now) / 1_000)}s before the next send failureTier=${state.failureTier}`,
    );
    this.persist(now);
    this.pump();
    return Math.max(1, Math.ceil((state.until - now) / 1_000));
  }

  /** Refuses a maintenance operation (smoke test) while the account is paused or cooling down. */
  assertMaintenanceAllowed(operation: string): void {
    const now = this.clock.now();
    this.refreshFromDisk(false);
    this.normalize(now);
    if (this.state.securityHoldAt > 0) throw this.securityHoldError();
    if (now < this.state.stoppedUntil) throw markLocalRefusal(this.pausedError(now));
    if (now < this.state.until) {
      throw markLocalRefusal(chatGptRateLimitError(withChatGptRetryDelay(
        `ChatGPT asked to slow down, so the ${operation} sent nothing to ChatGPT. Run it again after ${formatChatGptClockTime(this.state.until)}.`,
        Math.ceil((this.state.until - now) / 1_000),
      )));
    }
  }

  snapshot(): ChatGptAdmissionGateSnapshot {
    const now = this.clock.now();
    this.refreshFromDisk(false);
    this.normalize(now);
    const paused = now < this.state.stoppedUntil;
    const cooling = now < this.state.until;
    const held = this.state.securityHoldAt > 0;
    return {
      state: held ? "held" : paused ? "paused" : cooling || this.waiters.length > 0 ? "waiting" : "normal",
      ...(held ? { securityHoldAt: this.state.securityHoldAt } : {}),
      ...(held && this.state.securityHoldReason ? { securityHoldReason: this.state.securityHoldReason } : {}),
      ...(cooling ? { cooldownUntil: this.state.until } : {}),
      ...(paused ? { pausedUntil: this.state.stoppedUntil } : {}),
      tier: this.state.tier,
      probeRequired: this.state.probeRequired,
      limit: this.limit(now),
      queued: this.waiters.length,
      active: this.tickets.size,
      waitingForTools: [...this.tickets].filter(ticket => ticket.waitingForTools).length,
    };
  }

  /** For tests and shutdown: stop the wake-up timer. Waiters stay queued. */
  dispose(): void {
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
  }

  ticketChanged(): void {
    this.pump();
  }

  ticketAccepted(ticket: AdmissionTicket): void {
    if (ticket === this.probeTicket && this.state.probeRequired) {
      const now = this.clock.now();
      this.state.probeRequired = false;
      this.state.recoveryStartedAt = now;
      this.log.info(`[chatgpt-web] rate-limit probe accepted trace=${ticket.traceId}; releasing the queue one at a time`);
      this.persist(now);
    }
    this.pump();
  }

  ticketFinished(ticket: AdmissionTicket, outcome: ChatGptAdmissionOutcome): void {
    this.tickets.delete(ticket);
    if (ticket === this.probeTicket) this.probeTicket = undefined;
    const now = this.clock.now();
    const state = this.state;
    if (outcome === "clean" && state.incidentStartedAt > 0 && ticket.admittedAt >= state.incidentStartedAt) {
      // A response served after the incident proves ChatGPT serves this account again: the next
      // incident starts from the base pause, and the concurrency ramp takes one more step.
      let changed = false;
      if (state.tier !== 0) {
        state.tier = 0;
        changed = true;
      }
      if (state.probeRequired && ticket.probe) {
        state.probeRequired = false;
        state.recoveryStartedAt = now;
        changed = true;
      }
      if (state.recovering) {
        state.recoveredSlots = Math.min(this.maxConcurrency, state.recoveredSlots + 1);
        changed = true;
      }
      if (changed) this.persist(now);
    }
    if (outcome === "clean" && state.failureTier !== 0) {
      // ChatGPT served this account again, so the next failure starts from the base pause.
      state.failureTier = 0;
      this.persist(now);
    }
    this.pump();
  }

  private suspendedMs(): number {
    return this.clock.suspendedMs?.() ?? 0;
  }

  /** Awake time this waiter spent in the queue, across every requeue. */
  private waitedMs(waiter: Waiter, now: number): number {
    const suspended = Math.max(0, this.suspendedMs() - waiter.suspendedAtEnqueue);
    return waiter.waitedBeforeMs + Math.max(0, now - waiter.enqueuedAt - suspended);
  }

  private throttledRecently(): boolean {
    const now = this.clock.now();
    return this.state.lastLimitAt > 0 && now - this.state.lastLimitAt <= CHATGPT_RATE_LIMIT_ESCALATION_RESET_MS;
  }

  private limit(now: number): number {
    const state = this.state;
    if (!state.recovering) return this.maxConcurrency;
    if (state.probeRequired || state.recoveryStartedAt === 0) return 1;
    const ramp = Math.max(0, Math.floor((now - state.recoveryStartedAt) / CHATGPT_ADMISSION_RAMP_INTERVAL_MS));
    return Math.min(this.maxConcurrency, 1 + state.recoveredSlots + ramp);
  }

  private nextRampAt(now: number): number | undefined {
    const state = this.state;
    if (!state.recovering || state.probeRequired || state.recoveryStartedAt === 0) return undefined;
    const steps = Math.max(0, Math.floor((now - state.recoveryStartedAt) / CHATGPT_ADMISSION_RAMP_INTERVAL_MS));
    return state.recoveryStartedAt + (steps + 1) * CHATGPT_ADMISSION_RAMP_INTERVAL_MS;
  }

  private sendSlots(): number {
    let slots = 0;
    for (const ticket of this.tickets) if (!ticket.waitingForTools) slots += 1;
    return slots;
  }

  /** Applies the passage of time; the result is not written back because it is reproducible. */
  private normalize(now: number): void {
    const state = this.state;
    if (state.lastLimitAt > 0
      && now - state.lastLimitAt > CHATGPT_RATE_LIMIT_MAX_COOLDOWN_MS + CHATGPT_RATE_LIMIT_ESCALATION_RESET_MS) {
      // A quiet period ends the escalation and the reduced ceiling. A probe that never ran is
      // still owed: it costs one serialized start, and it is the only evidence the limit cleared.
      state.tier = 0;
      state.recovering = false;
    }
    if (state.failureTier > 0 && state.lastFailureAt > 0
      && now - state.lastFailureAt > CHATGPT_FAILURE_MAX_BACKOFF_MS + CHATGPT_RATE_LIMIT_ESCALATION_RESET_MS) {
      state.failureTier = 0;
    }
    state.incidents = state.incidents.filter(at => at <= now && now - at < CHATGPT_RATE_LIMIT_INCIDENT_WINDOW_MS);
    // A wrong clock or a long pause must never block work beyond the longest pause ChatGPT asks for.
    if (state.until > now + CHATGPT_RATE_LIMIT_MAX_COOLDOWN_MS) state.until = now + CHATGPT_RATE_LIMIT_MAX_COOLDOWN_MS;
    if (state.stoppedUntil > now + CHATGPT_RATE_LIMIT_INCIDENT_WINDOW_MS) {
      state.stoppedUntil = now + CHATGPT_RATE_LIMIT_INCIDENT_WINDOW_MS;
    }
    if (state.recovering && !state.probeRequired && state.recoveryStartedAt > 0
      && this.limit(now) >= this.maxConcurrency) {
      state.recovering = false;
    }
  }

  private block(now: number): { reason: ChatGptAdmissionWaitReason; wakeAt?: number } | undefined {
    const state = this.state;
    if (now < state.until) return { reason: "cooldown", wakeAt: state.until };
    if (this.tickets.size >= MAX_CHATGPT_BROWSER_TABS) {
      return { reason: state.recovering ? "recovery" : "capacity" };
    }
    if (state.probeRequired) {
      if (this.probeTicket && !this.probeTicket.finished) return { reason: "probe" };
    } else if (this.sendSlots() >= this.limit(now)) {
      const wakeAt = this.nextRampAt(now);
      return { reason: state.recovering ? "recovery" : "capacity", ...(wakeAt !== undefined ? { wakeAt } : {}) };
    }
    const spacing = state.recovering ? CHATGPT_ADMISSION_RECOVERY_SPACING_MS : CHATGPT_ADMISSION_OPEN_SPACING_MS;
    if (this.lastAdmissionAt > 0 && now < this.lastAdmissionAt + spacing) {
      return {
        reason: state.recovering ? (state.probeRequired ? "probe" : "recovery") : "spacing",
        wakeAt: this.lastAdmissionAt + spacing,
      };
    }
    return undefined;
  }

  pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        this.pumpOnce();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    const now = this.clock.now();
    this.refreshFromDisk(false);
    this.normalize(now);
    if (this.state.securityHoldAt > 0) {
      for (const waiter of [...this.waiters]) {
        this.removeWaiter(waiter);
        waiter.reject(this.securityHoldError());
      }
      this.schedule(Number.POSITIVE_INFINITY, now);
      return;
    }
    if (now < this.state.stoppedUntil) {
      for (const waiter of [...this.waiters]) {
        this.removeWaiter(waiter);
        waiter.reject(this.pausedError(now));
      }
      this.schedule(Number.POSITIVE_INFINITY, now);
      return;
    }
    for (const waiter of [...this.waiters]) {
      const waited = this.waitedMs(waiter, now);
      if (waited < CHATGPT_ADMISSION_MAX_WAIT_MS) continue;
      this.removeWaiter(waiter);
      this.log.warn(`[chatgpt-web] browser turn ${waiter.traceId} waited ${Math.round(waited / 1_000)}s for ChatGPT admission; ending it`);
      waiter.reject(this.waitExceededError(waiter.firstQueuedAt));
    }
    let wakeAt = Number.POSITIVE_INFINITY;
    let blocked: { reason: ChatGptAdmissionWaitReason; wakeAt?: number } | undefined;
    while (this.waiters.length > 0) {
      blocked = this.block(now);
      if (blocked) {
        if (blocked.wakeAt !== undefined) wakeAt = Math.min(wakeAt, blocked.wakeAt);
        break;
      }
      this.admit(this.waiters[0]!, now);
    }
    for (const [index, waiter] of this.waiters.entries()) {
      wakeAt = Math.min(wakeAt, now + CHATGPT_ADMISSION_MAX_WAIT_MS - this.waitedMs(waiter, now));
      // Everyone behind the head waits for the same reason, and at least until the head goes.
      this.report(waiter, blocked?.reason ?? "spacing", index + 1, blocked?.reason === "cooldown" ? this.state.until : undefined);
    }
    this.schedule(wakeAt, now);
  }

  private admit(waiter: Waiter, now: number): void {
    this.removeWaiter(waiter);
    const probe = this.state.probeRequired;
    const ticket = new AdmissionTicket(
      this,
      waiter.traceId,
      waiter.seq,
      waiter.firstQueuedAt,
      now,
      probe,
      this.waitedMs(waiter, now),
    );
    this.tickets.add(ticket);
    if (probe) this.probeTicket = ticket;
    this.lastAdmissionAt = now;
    if (probe || ticket.waitedMs >= 1_000) {
      this.log.info(
        `[chatgpt-web] browser turn ${waiter.traceId} admitted probe=${probe} waitedMs=${Math.round(ticket.waitedMs)}`
        + ` limit=${this.limit(now)} active=${this.tickets.size} queued=${this.waiters.length}`,
      );
    }
    waiter.resolve(ticket);
  }

  private report(waiter: Waiter, reason: ChatGptAdmissionWaitReason, position: number, sendAt?: number): void {
    if (waiter.loggedReason !== reason && reason !== "spacing") {
      waiter.loggedReason = reason;
      this.log.info(
        `[chatgpt-web] browser turn ${waiter.traceId} waiting for ChatGPT admission reason=${reason}`
        + ` position=${position} queued=${this.waiters.length}`
        + (sendAt !== undefined ? ` sendAt=${new Date(sendAt).toISOString()}` : ""),
      );
    }
    if (!waiter.onStatus || reason === "spacing") return;
    const key = `${reason}:${sendAt === undefined ? "" : Math.floor(sendAt / 60_000)}`;
    if (waiter.statusKey === key) return;
    waiter.statusKey = key;
    try {
      waiter.onStatus({
        reason,
        position,
        queued: this.waiters.length,
        ...(sendAt !== undefined ? { sendAt } : {}),
        since: waiter.firstQueuedAt,
      });
    } catch (error) {
      this.log.warn(`[chatgpt-web] admission status for ${waiter.traceId} could not be shown: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private schedule(wakeAt: number, now: number): void {
    if (wakeAt === this.timerAt && this.timer !== undefined) return;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
    if (!Number.isFinite(wakeAt)) return;
    this.timerAt = wakeAt;
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined;
      this.timerAt = Number.POSITIVE_INFINITY;
      this.pump();
    }, Math.max(MIN_WAKE_DELAY_MS, wakeAt - now));
  }

  private removeWaiter(waiter: Waiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    return true;
  }

  private waitExceededError(since: number): ChatGptWebAdapterError {
    return markLocalRefusal(new ChatGptWebAdapterError(
      `ChatGPT asked to slow down, and this step waited in the bridge for ${Math.round(CHATGPT_ADMISSION_MAX_WAIT_MS / 60_000)} minutes (since ${formatChatGptClockTime(since)}) without being sent. Nothing was sent to ChatGPT. Send your message again.`,
      {
        status: 400,
        errorType: "chatgpt_admission_wait_exceeded",
        code: "invalid_prompt",
        retryable: false,
      },
    ));
  }

  private pausedError(now: number): ChatGptWebAdapterError {
    const incidents = this.state.incidents;
    const last = incidents.at(-1) ?? this.state.lastLimitAt;
    const until = formatChatGptClockTime(this.state.stoppedUntil);
    return markLocalRefusal(new ChatGptWebAdapterError(
      `ChatGPT asked this account to slow down ${Math.max(incidents.length, CHATGPT_RATE_LIMIT_INCIDENT_STOP_COUNT)} times in ${Math.round(CHATGPT_RATE_LIMIT_INCIDENT_WINDOW_MS / 60_000)} minutes (last at ${formatChatGptClockTime(last || now)}), so the bridge sends nothing to ChatGPT until ${until}. This step was not sent. Send your message again after ${until}.`,
      {
        status: 400,
        errorType: "chatgpt_account_paused",
        code: "invalid_prompt",
        retryable: false,
      },
    ));
  }

  private persist(now: number): void {
    this.state.updatedAt = Math.max(now, this.state.updatedAt + 1);
    if (!this.statePath) return;
    try {
      const current = readStateFile(this.statePath);
      const accounts = { ...current.accounts, [this.accountKey]: { ...this.state } };
      atomicWriteFile(this.statePath, `${JSON.stringify({ version: STATE_FILE_VERSION, accounts })}\n`);
      this.stateFileMtimeMs = statSync(this.statePath).mtimeMs;
    } catch (error) {
      this.log.warn(`[chatgpt-web] could not save the ChatGPT rate-limit state: ${error instanceof Error ? error.name : "Error"}`);
    }
  }

  /**
   * Adopts a newer state written by another process for the same account (for example a second
   * daemon on the same home). The first read also restores a cooldown across a restart.
   */
  private refreshFromDisk(initial: boolean): void {
    if (!this.statePath) return;
    let mtimeMs: number;
    try {
      mtimeMs = existsSync(this.statePath) ? statSync(this.statePath).mtimeMs : -1;
    } catch {
      return;
    }
    if (!initial && mtimeMs === this.stateFileMtimeMs) return;
    this.stateFileMtimeMs = mtimeMs;
    if (mtimeMs < 0) return;
    const file = readStateFile(this.statePath);
    if (file.corrupt) {
      if (initial) this.log.warn("[chatgpt-web] ignored an unreadable ChatGPT rate-limit state file");
      return;
    }
    const stored = parseAccountState(file.accounts[this.accountKey]);
    if (!stored || stored.updatedAt <= this.state.updatedAt) return;
    this.state = stored;
    const now = this.clock.now();
    this.normalize(now);
    if (initial && now < this.state.until) {
      this.log.info(
        `[chatgpt-web] ChatGPT rate-limit cooldown restored from saved state remainingSeconds=${Math.ceil((this.state.until - now) / 1_000)} tier=${this.state.tier}`,
      );
    }
  }
}

const gates = new Map<string, ChatGptAdmissionGate>();

/** The daemon-wide gate of one ChatGPT account. */
export function chatGptAdmissionGateFor(accountKey: string, statePath = defaultChatGptRateLimitStatePath()): ChatGptAdmissionGate {
  const key = `${statePath} ${accountKey}`;
  let gate = gates.get(key);
  if (!gate) {
    gate = new ChatGptAdmissionGate({ accountKey, statePath });
    gates.set(key, gate);
  }
  return gate;
}
