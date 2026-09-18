// Shared by the browser stage runner and the admission gate, which must not import each other.
/**
 * Detects that this process was suspended (system sleep) by watching for gaps in a steady tick.
 * On Apple Silicon the monotonic clock keeps advancing through sleep, so elapsed time alone cannot
 * distinguish "the stage really took 15 minutes" from "the machine slept for 14 of them" — and a
 * stage budget charged for slept time cancels turns that never got their budget awake.
 */
export class ChatGptSuspensionClock {
  private suspendedTotalMs = 0;
  private lastTickAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tickIntervalMs = 1_000,
    private readonly gapThresholdMs = 5_000,
  ) {
    this.lastTickAt = Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(Date.now()), this.tickIntervalMs);
    this.timer.unref?.();
  }

  /** Exposed for tests; production ticks come from the interval above. */
  tick(now: number): void {
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap >= this.gapThresholdMs) this.suspendedTotalMs += gap - this.tickIntervalMs;
  }

  suspendedMs(): number {
    return this.suspendedTotalMs;
  }
}

export const chatGptSuspensionClock = new ChatGptSuspensionClock();
