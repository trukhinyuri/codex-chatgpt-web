/**
 * Live proof about the MCP tunnel this computer uses, read from OpenAI's tunnel registry.
 *
 * Everything else the product knows about the tunnel is local: the binary, the key file, the
 * process and its /readyz. None of that survives a change made in the OpenAI account. After the
 * owner changed their ChatGPT password on 18.09.2026 the tunnel stayed healthy locally while
 * ChatGPT no longer offered it ("No tunnels yet" in New Plugin → Tunnel) and the connector was
 * gone, and every check could only say that local evidence proves nothing. One authenticated
 * `GET /v1/tunnels/{id}` answers all three questions that matter: the tunnel still exists, this
 * computer's runtime key still opens it, and it is shared with at least one workspace.
 *
 * The runtime key is read from its file at the moment of the request and never stored, logged,
 * returned or put into an error (R7.2, R7.3).
 */

import { readFileSync } from "node:fs";
import type { AppConfig } from "./config";

export const OPENAI_TUNNEL_REGISTRY_URL = "https://api.openai.com/v1/tunnels";
/** Where a person shares a tunnel with a workspace; the one place every failure below points to. */
export const OPENAI_TUNNELS_SETTINGS_URL = "https://platform.openai.com/settings/organization/tunnels";
export const TUNNEL_REGISTRY_TIMEOUT_MS = 10_000;

export interface TunnelRegistryRecord {
  id: string;
  /** The tunnel's name in OpenAI, when it has one. Never a secret. */
  name: string | null;
  organizationIds: string[];
  workspaceIds: string[];
}

export type TunnelRegistryResult =
  /** The tunnel exists and this computer's runtime key opens it. */
  | { status: "ok"; record: TunnelRegistryRecord }
  /** OpenAI does not have this tunnel any more (404). */
  | { status: "missing" }
  /** The runtime key is not accepted any more (401/403). */
  | { status: "unauthorized"; httpStatus: number }
  /** Nothing was proven: no network, a timeout, an unreadable key, or an unexpected answer. */
  | { status: "unproven"; detail: string };

/** What the registry says about the tunnel reaching a workspace at all. */
export type TunnelSharingVerdict =
  | { status: "shared"; workspaces: number }
  | { status: "not-shared" }
  | { status: "unknown" };

/**
 * A tunnel that belongs to an organization but is shared with no workspace cannot appear in any
 * ChatGPT workspace, which is exactly the "No tunnels yet" dialog. A record that names neither is
 * not evidence either way.
 */
export function tunnelWorkspaceSharing(record: TunnelRegistryRecord): TunnelSharingVerdict {
  if (record.workspaceIds.length > 0) return { status: "shared", workspaces: record.workspaceIds.length };
  if (record.organizationIds.length > 0) return { status: "not-shared" };
  return { status: "unknown" };
}

function identifiers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function parseTunnelRegistryRecord(body: unknown, fallbackId: string): TunnelRegistryRecord | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id ? record.id : fallbackId;
  if (id !== fallbackId) return undefined;
  return {
    id,
    name: typeof record.name === "string" && record.name ? record.name : null,
    organizationIds: identifiers(record.organization_ids),
    workspaceIds: identifiers(record.workspace_ids),
  };
}

export interface TunnelRegistryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test seam only; production always reads the configured key file. */
  readRuntimeKey?: (path: string) => string;
}

/**
 * Ask OpenAI about the configured tunnel. Every outcome is a value, never a thrown error: a doctor
 * check and a turn's pre-flight both have to keep working without network.
 */
export async function fetchTunnelRegistryRecord(
  config: AppConfig,
  options: TunnelRegistryOptions = {},
): Promise<TunnelRegistryResult> {
  const tunnel = config.mode === "full" ? config.tunnel : undefined;
  if (!tunnel) return { status: "unproven", detail: "No MCP tunnel is configured" };
  const read = options.readRuntimeKey ?? ((path: string) => readFileSync(path, "utf8"));
  let key: string;
  try {
    key = read(tunnel.runtimeKeyFile).trim();
  } catch {
    return { status: "unproven", detail: "The tunnel runtime key file could not be read" };
  }
  if (!key) return { status: "unproven", detail: "The tunnel runtime key file is empty" };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TUNNEL_REGISTRY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${OPENAI_TUNNEL_REGISTRY_URL}/${encodeURIComponent(tunnel.tunnelId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    // The message of a fetch failure can carry the request, so it is never passed on.
    return { status: "unproven", detail: "OpenAI's tunnel registry could not be reached" };
  } finally {
    clearTimeout(timeout);
    key = "";
  }

  if (response.status === 404) return { status: "missing" };
  if (response.status === 401 || response.status === 403) {
    return { status: "unauthorized", httpStatus: response.status };
  }
  if (!response.ok) {
    return { status: "unproven", detail: `OpenAI's tunnel registry answered HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unproven", detail: "OpenAI's tunnel registry answered with an unreadable body" };
  }
  const record = parseTunnelRegistryRecord(body, tunnel.tunnelId);
  if (!record) return { status: "unproven", detail: "OpenAI's tunnel registry answered about another tunnel" };
  return { status: "ok", record };
}
