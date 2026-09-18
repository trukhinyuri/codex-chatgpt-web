import type { ChatGptGateClock } from "../../src/adapters/chatgpt-web/rate-limit-gate";

/** A manual clock for the admission gate: time moves only when a test advances it. */
export class FakeGateClock implements ChatGptGateClock {
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 1;

  constructor(public current: number) {}

  now(): number {
    return this.current;
  }

  setTimer(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Moves time forward, firing every timer due on the way in order. */
  async advance(ms: number): Promise<void> {
    // Let any pending microtasks (e.g. Promise.resolve().then(runAdmitted)) run first so
    // waiters are registered in the gate before we start firing timers.
    await flushMicrotasks();
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.current = Math.max(this.current, due[1].at);
      due[1].callback();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
    await flushMicrotasks(); // extra pass for deep Promise chains (admission gate has 6-8 hops)
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 200; index += 1) await Promise.resolve();
}

export const silentGateLog = { info: () => {}, warn: () => {} };
