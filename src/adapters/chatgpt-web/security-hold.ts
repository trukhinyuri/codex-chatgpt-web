import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright-core";
import { atomicWriteFile, getConfigDir } from "../../config";
import { ChatGptWebAdapterError } from "./adapter-error";

/**
 * ChatGPT's own account check, not a rate limit.
 *
 * On 18 September 2026 the owner's account was held with "Suspicious activity detected. It looks
 * like someone else may be using your ChatGPT account. Please secure your account to regain access
 * to all features" after a day of parallel bridge traffic. While the hold was in place the model
 * menu lost its Thinking effort controls, so every turn failed with "ChatGPT model controls are
 * unavailable" and the bridge kept retrying — which is exactly the traffic that prolongs a hold.
 *
 * Both signals now mean the same thing: stop sending for this account until a person has secured it
 * and signed in again. See docs/incidents/2026-09-18-account-lock.md.
 */
export type ChatGptSecurityHoldReason = "suspicious_activity" | "model_controls_missing";

/** Exactly one action for the user (R2.3). */
export const CHATGPT_SECURITY_HOLD_ACTION =
  "Open the ChatGPT tab in Codex Superpower, secure the account there and sign in again.";

const REASON_TEXT: Record<ChatGptSecurityHoldReason, string> = {
  suspicious_activity:
    "ChatGPT is holding this account after a suspicious-activity check, so the bridge stopped sending turns for it and will not retry.",
  model_controls_missing:
    "ChatGPT stopped offering this account's model and effort controls, which is how a held account looks to the bridge. The bridge stopped sending turns for this account and will not retry.",
};

/**
 * The strings ChatGPT shows for an account hold. The banner is matched on the product's own
 * wording; no page text is stored or logged anywhere (R7.1).
 */
const CHATGPT_SECURITY_HOLD_PATTERNS: readonly RegExp[] = [
  /Suspicious activity detected/i,
  /someone else may be using your ChatGPT account/i,
  /secure your account to regain access/i,
];

/** True when a piece of page text carries ChatGPT's account-hold notice. */
export function isChatGptSecurityHoldText(text: string | null | undefined): boolean {
  if (!text) return false;
  return CHATGPT_SECURITY_HOLD_PATTERNS.some(pattern => pattern.test(text));
}

export function chatGptSecurityHoldError(
  reason: ChatGptSecurityHoldReason,
  options: { diagnostic?: string; heldSince?: number } = {},
): ChatGptWebAdapterError {
  const since = options.heldSince
    ? ` The hold was first seen at ${new Date(options.heldSince).toISOString()}.`
    : "";
  return new ChatGptWebAdapterError(
    `${REASON_TEXT[reason]}${since} ${CHATGPT_SECURITY_HOLD_ACTION}`,
    {
      status: 403,
      errorType: "chatgpt_security_hold",
      // Codex retries every code it does not know up to five times. `invalid_prompt` is the one
      // terminal code it honours, so a held account receives no automatic repeat.
      code: "invalid_prompt",
      retryable: false,
      ...(options.diagnostic === undefined ? {} : { cause: new Error(options.diagnostic) }),
    },
  );
}

export function isChatGptSecurityHoldError(error: unknown): error is ChatGptWebAdapterError {
  return error instanceof ChatGptWebAdapterError && error.errorType === "chatgpt_security_hold";
}

/** Finds a security hold behind a wrapped failure, the way a rate limit is found. */
export function chatGptSecurityHoldCause(error: unknown, depth = 0): ChatGptWebAdapterError | undefined {
  if (depth > 4 || !(error instanceof Error)) return undefined;
  if (isChatGptSecurityHoldError(error)) return error;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = chatGptSecurityHoldCause(inner, depth + 1);
      if (found) return found;
    }
  }
  return chatGptSecurityHoldCause(error.cause, depth + 1);
}

type ChatGptSecurityHoldScope = Pick<Locator, "getByText">;

const chatGptSecurityHoldBanner = (scope: ChatGptSecurityHoldScope): Locator => scope
  .getByText(/Suspicious activity detected|someone else may be using your ChatGPT account/i)
  .last();

/** Stops the turn as soon as ChatGPT shows the account-hold banner or dialog. */
export async function throwIfChatGptSecurityHoldBanner(scope: ChatGptSecurityHoldScope): Promise<void> {
  // A surface that cannot be searched for text (a narrow locator scope) carries no banner to find.
  if (typeof (scope as { getByText?: unknown }).getByText !== "function") return;
  if (!await chatGptSecurityHoldBanner(scope).isVisible().catch(() => false)) return;
  throw chatGptSecurityHoldError("suspicious_activity", {
    diagnostic: "ChatGPT displayed its account-hold banner",
  });
}

export interface ChatGptSecurityHoldRecord {
  version: 1;
  reason: ChatGptSecurityHoldReason;
  /** Opaque per-account key; it identifies the browser profile, never the person. */
  accountKey: string;
  detectedAt: string;
  /** Structural note written by the bridge. Never page text, a prompt or an answer. */
  diagnostic: string;
}

export function chatGptSecurityHoldDiagnosticsDir(): string {
  return join(getConfigDir(), "diagnostics", "security-hold");
}

/**
 * Writes one structural record per hold. It carries no prompt, no answer, no page text and no
 * account name — only the reason, the opaque account key and the time (R7.1).
 */
export function writeChatGptSecurityHoldDiagnostic(
  record: Omit<ChatGptSecurityHoldRecord, "version">,
  directory = chatGptSecurityHoldDiagnosticsDir(),
): string | undefined {
  try {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${record.accountKey}-${Date.parse(record.detectedAt) || Date.now()}.json`);
    atomicWriteFile(path, `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`);
    return path;
  } catch {
    // A diagnostic that cannot be written must never stop the hold itself.
    return undefined;
  }
}
