import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
}

interface PersistedCheckpoint {
  key: string;
  summaryHash: string;
  sourceHashes: string[];
}

interface PersistedCheckpointFile {
  version: 1;
  checkpoints: PersistedCheckpoint[];
}

const MAX_CHECKPOINTS = 256;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  return JSON.stringify([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return digest([source.turnId, source.content]);
}

function validateScopeKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid persisted ChatGPT compaction scope");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid persisted ChatGPT compaction scope");
  }
  if (!Array.isArray(parsed) || parsed.length !== 4
    || typeof parsed[0] !== "string" || !parsed[0]
    || typeof parsed[1] !== "string" || !parsed[1]
    || typeof parsed[2] !== "string" || !parsed[2]
    || (parsed[3] !== null && typeof parsed[3] !== "string")) {
    throw new Error("Invalid persisted ChatGPT compaction scope");
  }
  return value;
}

function validateHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`Invalid persisted ChatGPT compaction ${field}`);
  }
  return value;
}

function validateCheckpoint(value: unknown): [string, CompletedCheckpoint] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted ChatGPT compaction checkpoint");
  }
  const raw = value as Partial<PersistedCheckpoint>;
  const key = validateScopeKey(raw.key);
  const summaryHash = validateHash(raw.summaryHash, "summary hash");
  if (!Array.isArray(raw.sourceHashes) || raw.sourceHashes.length === 0
    || raw.sourceHashes.length > 8) {
    throw new Error("Invalid persisted ChatGPT compaction source hashes");
  }
  const sourceHashes = new Set(raw.sourceHashes.map(hash => validateHash(hash, "source hash")));
  if (sourceHashes.size !== raw.sourceHashes.length) {
    throw new Error("Invalid persisted ChatGPT compaction source hashes");
  }
  return [key, { summaryHash, sourceHashes }];
}

/**
 * Durable evidence of compaction handoffs actually completed by this bridge.
 *
 * Only hashes and native identity scope are persisted; prompt/summary plaintext never leaves the
 * normal Codex/ChatGPT histories. A restart may reload previously authenticated handoffs, but an
 * arbitrary summary-looking message can never create new authority: rememberCompactionContinuation
 * is the only writer, and it only ever records what this daemon itself just produced.
 */
export class ChatGptCompactionContinuationStore {
  private loaded = false;
  private readonly checkpoints = new Map<string, CompletedCheckpoint>();

  constructor(private readonly path?: string) {}

  remember(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
    sources: readonly ChatGptTurnUserRevision[],
    summary: string,
  ): void {
    const key = scope(parsed, identity);
    if (!key || !parsed._compactionRequest || !summary) return;
    this.load();
    this.checkpoints.delete(key);
    this.checkpoints.set(key, {
      summaryHash: digest(summary),
      sourceHashes: new Set(sources.map(sourceDigest)),
    });
    while (this.checkpoints.size > MAX_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      this.checkpoints.delete(oldest);
    }
    this.persist();
  }

  accepts(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
    source: ChatGptTurnUserRevision,
  ): boolean {
    const key = scope(parsed, identity);
    if (!key) return false;
    this.load();
    const checkpoint = this.checkpoints.get(key);
    if (!checkpoint || !checkpoint.sourceHashes.has(sourceDigest(source))) return false;
    const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
    if (!Array.isArray(input)) return false;
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index] as Record<string, unknown> | null;
      if (!item || typeof item !== "object") continue;
      if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
        const summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
        return summary !== null && this.acceptsSummary(key, checkpoint, summary);
      }
      if (item.role !== "user") continue;
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
        ? item.content.map(part => part?.text ?? "").join("\n") : "";
      if (isReadableCompactionSummaryText(text)) {
        return this.acceptsSummary(key, checkpoint, text.slice(SUMMARY_PREFIX.length + 1));
      }
    }
    return false;
  }

  private acceptsSummary(key: string, checkpoint: CompletedCheckpoint, summary: string): boolean {
    if (digest(summary) !== checkpoint.summaryHash) return false;
    // A long-running continuation does not become invalid merely because time passed. Keep the
    // bounded registry ordered by actual use instead of expiring a still-active native turn.
    this.checkpoints.delete(key);
    this.checkpoints.set(key, checkpoint);
    this.persist();
    return true;
  }

  private load(): void {
    if (this.loaded) return;
    if (!this.path || !existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    const loaded = new Map<string, CompletedCheckpoint>();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PersistedCheckpointFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.checkpoints)
        || parsed.checkpoints.length > MAX_CHECKPOINTS) {
        throw new Error("Invalid persisted ChatGPT compaction store envelope");
      }
      for (const raw of parsed.checkpoints) {
        const [key, checkpoint] = validateCheckpoint(raw);
        if (loaded.has(key)) throw new Error("Duplicate persisted ChatGPT compaction scope");
        loaded.set(key, checkpoint);
      }
    } catch {
      // Persistence is only evidence for a previously completed handoff. Corruption must never
      // leave partially validated authority resident, nor should it prevent a future completed
      // compaction from establishing fresh authority and atomically repairing the file.
      this.checkpoints.clear();
      this.loaded = true;
      return;
    }
    this.checkpoints.clear();
    for (const [key, checkpoint] of loaded) this.checkpoints.set(key, checkpoint);
    this.loaded = true;
  }

  private persist(): void {
    if (!this.path) return;
    const payload: PersistedCheckpointFile = {
      version: 1,
      checkpoints: [...this.checkpoints].map(([key, checkpoint]) => ({
        key,
        summaryHash: checkpoint.summaryHash,
        sourceHashes: [...checkpoint.sourceHashes],
      })),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

// Direct in-process calls (mostly tests) preserve the historical memory-only behavior. Production
// binds every parsed request to the server-owned durable store before any revision validation
// (see bindCompactionContinuationStore in src/server.ts).
const defaultStore = new ChatGptCompactionContinuationStore();
const requestStores = new WeakMap<CodexParsedRequest, ChatGptCompactionContinuationStore>();

export function bindCompactionContinuationStore(
  parsed: CodexParsedRequest,
  store: ChatGptCompactionContinuationStore,
): void {
  requestStores.set(parsed, store);
}

function storeFor(parsed: CodexParsedRequest): ChatGptCompactionContinuationStore {
  return requestStores.get(parsed) ?? defaultStore;
}

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  storeFor(parsed).remember(parsed, identity, sources, summary);
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  return storeFor(parsed).accepts(parsed, identity, source);
}
