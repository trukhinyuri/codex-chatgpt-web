import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./config";

/**
 * The last native Codex model catalog that chatgpt.com served successfully, so a transient catalog
 * failure does not cost Codex its ChatGPT Web rows (upstream miuuyy/codex-chatgpt-web#543: Web
 * models disappear from the picker mid-session). Only the raw upstream catalog is kept; the bridge
 * rebuilds its own rows from it with the configuration current at the time of the failure.
 *
 * Entries are keyed by the Codex client version the catalog was requested for and a SHA-256 of the
 * ChatGPT account id, so one account never receives another account's catalog. The OAuth token is
 * never stored, hashed or logged.
 */
export const NATIVE_MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const NATIVE_MODEL_CATALOG_FILE_VERSION = 1;
const MAX_NATIVE_MODEL_CATALOG_ENTRIES = 8;

export interface NativeModelCatalogKey {
  clientVersion: string;
  accountHash: string;
}

export interface NativeModelCatalogSnapshot {
  catalog: Record<string, unknown>;
  etag?: string;
  fetchedAtMs: number;
  ageSec: number;
}

interface StoredEntry {
  clientVersion: string;
  accountHash: string;
  etag?: string;
  fetchedAt: string;
  catalog: Record<string, unknown>;
}

export function nativeModelCatalogCachePath(home: string): string {
  return join(home, "runtime", "native-model-catalog.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64UrlJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const CLIENT_VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;

/**
 * The ChatGPT account a native request belongs to: Codex sends it as `ChatGPT-Account-ID`; older or
 * foreign clients carry it only inside the access token's `https://api.openai.com/auth` claim. The
 * token is decoded locally for that one claim and is never verified, stored or logged.
 */
export function nativeRequestAccountId(headers: Headers): string | undefined {
  const header = headers.get("chatgpt-account-id")?.trim();
  if (header && ACCOUNT_ID.test(header)) return header;
  const authorization = headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return undefined;
  const parts = authorization.slice("Bearer ".length).trim().split(".");
  if (parts.length !== 3) return undefined;
  const payload = base64UrlJson(parts[1]!);
  if (!isObject(payload)) return undefined;
  const auth = payload["https://api.openai.com/auth"];
  const claim = isObject(auth) ? auth.chatgpt_account_id : undefined;
  return typeof claim === "string" && ACCOUNT_ID.test(claim) ? claim : undefined;
}

export function nativeModelCatalogKey(
  headers: Headers,
  clientVersion: string | undefined,
): NativeModelCatalogKey | undefined {
  const accountId = nativeRequestAccountId(headers);
  if (!accountId) return undefined;
  return {
    clientVersion: clientVersion && CLIENT_VERSION.test(clientVersion) ? clientVersion : "unknown",
    accountHash: createHash("sha256").update(accountId).digest("hex"),
  };
}

function entryId(key: NativeModelCatalogKey): string {
  return `${key.clientVersion}|${key.accountHash}`;
}

function parseStoredEntry(value: unknown): StoredEntry | undefined {
  if (!isObject(value)) return undefined;
  const { clientVersion, accountHash, etag, fetchedAt, catalog } = value;
  if (typeof clientVersion !== "string" || !CLIENT_VERSION.test(clientVersion)) return undefined;
  if (typeof accountHash !== "string" || !/^[0-9a-f]{64}$/.test(accountHash)) return undefined;
  if (etag !== undefined && typeof etag !== "string") return undefined;
  if (typeof fetchedAt !== "string" || !Number.isFinite(Date.parse(fetchedAt))) return undefined;
  if (!isObject(catalog) || !Array.isArray(catalog.models)) return undefined;
  return { clientVersion, accountHash, ...(etag === undefined ? {} : { etag }), fetchedAt, catalog };
}

export class NativeModelCatalogLastGood {
  private readonly entries = new Map<string, StoredEntry>();
  private loaded = false;
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  /** Without a path the last-good catalog lives only in memory (embedded and test servers). */
  constructor(private readonly options: { path?: string; now?: () => number; maxAgeMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? NATIVE_MODEL_CATALOG_MAX_AGE_MS;
  }

  private fresh(entry: StoredEntry): boolean {
    const age = this.now() - Date.parse(entry.fetchedAt);
    return age >= 0 && age <= this.maxAgeMs;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.options.path) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(readFileSync(this.options.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      // A damaged file only loses the fallback; it must never fail catalog requests.
      console.warn(`[codex-chatgpt-web] native_model_catalog_cache_unreadable ${JSON.stringify({
        name: error instanceof Error ? error.name : "Error",
      })}`);
      return;
    }
    if (!isObject(decoded) || decoded.version !== NATIVE_MODEL_CATALOG_FILE_VERSION || !Array.isArray(decoded.entries)) return;
    for (const candidate of decoded.entries) {
      const entry = parseStoredEntry(candidate);
      if (!entry || !this.fresh(entry)) continue;
      const id = entryId(entry);
      const current = this.entries.get(id);
      if (!current || Date.parse(current.fetchedAt) < Date.parse(entry.fetchedAt)) this.entries.set(id, entry);
    }
  }

  private persist(): void {
    if (!this.options.path) return;
    const entries = [...this.entries.values()];
    try {
      atomicWriteFile(this.options.path, `${JSON.stringify({ version: NATIVE_MODEL_CATALOG_FILE_VERSION, entries })}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      console.warn(`[codex-chatgpt-web] native_model_catalog_cache_write_failed ${JSON.stringify({
        name: error instanceof Error ? error.name : "Error",
        code: typeof (error as NodeJS.ErrnoException)?.code === "string" ? (error as NodeJS.ErrnoException).code : undefined,
      })}`);
    }
  }

  remember(key: NativeModelCatalogKey, catalog: Record<string, unknown>, etag?: string): void {
    this.load();
    const entry: StoredEntry = {
      clientVersion: key.clientVersion,
      accountHash: key.accountHash,
      ...(etag && etag.length <= 512 ? { etag } : {}),
      fetchedAt: new Date(this.now()).toISOString(),
      catalog: structuredClone(catalog),
    };
    const id = entryId(key);
    this.entries.delete(id);
    this.entries.set(id, entry);
    for (const [candidateId, candidate] of this.entries) {
      if (!this.fresh(candidate)) this.entries.delete(candidateId);
    }
    while (this.entries.size > MAX_NATIVE_MODEL_CATALOG_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.persist();
  }

  lookup(key: NativeModelCatalogKey): NativeModelCatalogSnapshot | undefined {
    this.load();
    const entry = this.entries.get(entryId(key));
    if (!entry || !this.fresh(entry)) return undefined;
    const fetchedAtMs = Date.parse(entry.fetchedAt);
    return {
      catalog: structuredClone(entry.catalog),
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
      fetchedAtMs,
      ageSec: Math.max(0, Math.floor((this.now() - fetchedAtMs) / 1_000)),
    };
  }
}
