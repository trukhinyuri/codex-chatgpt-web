/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam. Turns beyond the bound wait in the admission
 * gate's queue (rate-limit-gate.ts) instead of failing.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

/**
 * Stages that drive the ChatGPT page hard: opening and binding a tab, preparing the Temporary Chat,
 * choosing the mode, attaching and sending a message, acknowledging a staged Bigger Context part,
 * and rebinding a stalled page. Several tabs doing this at once starve one another's renderer, so
 * they take turns per account. Waiting for the model's answer is not in this list.
 */
const CHATGPT_HEAVY_BROWSER_STAGE = new RegExp(
  "^(?:browser_page|temporary_chat_preparation|effort_selection|final_part_effort_selection"
  + "|prompt_attachment|file_attachment|send|connector_catalog_refresh|response_page_rebind_\\d+"
  + "|multipart_stage_\\d+_(?:attachment|send|acknowledgement))$",
);

/** Stages that load a new Temporary Chat document, which ChatGPT counts as a conversation opening. */
const CHATGPT_TEMPORARY_CHAT_OPENING_STAGE = /^(?:temporary_chat_preparation|connector_catalog_refresh)$/;

export function isChatGptHeavyBrowserStage(stage: string): boolean {
  return CHATGPT_HEAVY_BROWSER_STAGE.test(stage);
}

export function isChatGptTemporaryChatOpeningStage(stage: string): boolean {
  return CHATGPT_TEMPORARY_CHAT_OPENING_STAGE.test(stage);
}

export interface ChatGptLockHold {
  /** How long this acquisition waited behind other owners. */
  readonly waitedMs: number;
  /** Owners that were ahead of this one when it asked. */
  readonly queuedAhead: number;
  /** Idempotent. */
  release(): void;
}

interface LockWaiter {
  owner: string;
  queuedAt: number;
  queuedAhead: number;
  resolve: (hold: ChatGptLockHold) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A FIFO lock that one turn may enter again while it already holds it (a rebind inside a send,
 * or a stage inside the turn's opening). Waiting is cancelled by the turn's abort signal, so a
 * cancelled turn gives up its place instead of holding up the queue.
 */
export class ChatGptFifoLock {
  private holder?: { owner: string; depth: number };
  private readonly waiters: LockWaiter[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  get queued(): number {
    return this.waiters.length;
  }

  holds(owner: string): boolean {
    return this.holder?.owner === owner;
  }

  acquire(owner: string, signal?: AbortSignal): Promise<ChatGptLockHold> {
    if (signal?.aborted) return Promise.reject(new DOMException("ChatGPT browser lock wait aborted", "AbortError"));
    if (this.holder?.owner === owner) {
      this.holder.depth += 1;
      return Promise.resolve(this.hold(owner, 0, 0));
    }
    if (!this.holder && this.waiters.length === 0) {
      this.holder = { owner, depth: 1 };
      return Promise.resolve(this.hold(owner, 0, 0));
    }
    return new Promise<ChatGptLockHold>((resolve, reject) => {
      const waiter: LockWaiter = {
        owner,
        queuedAt: this.now(),
        queuedAhead: this.waiters.length + (this.holder ? 1 : 0),
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          reject(new DOMException("ChatGPT browser lock wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private hold(owner: string, waitedMs: number, queuedAhead: number): ChatGptLockHold {
    let released = false;
    return {
      waitedMs,
      queuedAhead,
      release: () => {
        if (released) return;
        released = true;
        this.release(owner);
      },
    };
  }

  private release(owner: string): void {
    if (this.holder?.owner !== owner) return;
    this.holder.depth -= 1;
    if (this.holder.depth > 0) return;
    this.holder = undefined;
    const next = this.waiters.shift();
    if (!next) return;
    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
    this.holder = { owner: next.owner, depth: 1 };
    next.resolve(this.hold(next.owner, Math.max(0, this.now() - next.queuedAt), next.queuedAhead));
  }
}

/** Browser-side serialization shared by every worker of one ChatGPT account in this process. */
export interface ChatGptAccountBrowserLocks {
  /** Heavy page phases: one at a time per account. */
  readonly heavy: ChatGptFifoLock;
  /** One Bigger Context transaction at a time per account. */
  readonly multipart: ChatGptFifoLock;
  /** When the last Temporary Chat opening began, for the minimum opening distance. */
  lastTemporaryChatOpeningAt: number;
}

const accountBrowserLocks = new Map<string, ChatGptAccountBrowserLocks>();

export function chatGptAccountBrowserLocks(accountKey: string): ChatGptAccountBrowserLocks {
  let locks = accountBrowserLocks.get(accountKey);
  if (!locks) {
    locks = { heavy: new ChatGptFifoLock(), multipart: new ChatGptFifoLock(), lastTemporaryChatOpeningAt: 0 };
    accountBrowserLocks.set(accountKey, locks);
  }
  return locks;
}
