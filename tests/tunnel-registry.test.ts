import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  fetchTunnelRegistryRecord,
  OPENAI_TUNNEL_REGISTRY_URL,
  parseTunnelRegistryRecord,
  tunnelWorkspaceSharing,
} from "../src/tunnel-registry";

const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";

function fullConfig() {
  return {
    ...defaultConfig("full"),
    appName: "Codex Native2",
    tunnel: {
      binaryPath: "/bin/tunnel-client",
      tunnelId: TUNNEL_ID,
      runtimeKeyFile: "/secrets/runtime.key",
      profileDir: "/profiles",
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  };
}

function answer(status: number, body?: unknown): typeof fetch {
  return (async () => new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

// Local evidence about the tunnel — the binary, the key file, the process and its /readyz — stays
// green after the tunnel is deleted or unshared in the OpenAI account. On 18.09.2026 that left the
// product saying only "local checks cannot prove", while ChatGPT offered no tunnel and no connector.
describe("what OpenAI's tunnel registry proves about this computer's tunnel", () => {
  test("a healthy tunnel answers with its name, organization and workspaces", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), authorization: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify({
        id: TUNNEL_ID,
        name: "codex-web",
        organization_ids: ["org-abc"],
        workspace_ids: ["ws-0000-1111"],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchTunnelRegistryRecord(fullConfig(), {
      fetchImpl,
      readRuntimeKey: () => "  runtime-key-value\n",
    });
    expect(result).toEqual({
      status: "ok",
      record: { id: TUNNEL_ID, name: "codex-web", organizationIds: ["org-abc"], workspaceIds: ["ws-0000-1111"] },
    });
    expect(seen).toEqual([{ url: `${OPENAI_TUNNEL_REGISTRY_URL}/${TUNNEL_ID}`, authorization: "Bearer runtime-key-value" }]);
  });

  test("404 is a missing tunnel, 401 and 403 a key OpenAI does not accept", async () => {
    expect(await fetchTunnelRegistryRecord(fullConfig(), { fetchImpl: answer(404, {}), readRuntimeKey: () => "k" }))
      .toEqual({ status: "missing" });
    for (const status of [401, 403]) {
      expect(await fetchTunnelRegistryRecord(fullConfig(), { fetchImpl: answer(status, {}), readRuntimeKey: () => "k" }))
        .toEqual({ status: "unauthorized", httpStatus: status });
    }
  });

  test("no network, an unreadable key, an empty key or a strange answer prove nothing", async () => {
    const rejecting = (async () => { throw new Error(`connect ECONNREFUSED for Bearer runtime-key-value`); }) as unknown as typeof fetch;
    for (const [options, detail] of [
      [{ fetchImpl: rejecting, readRuntimeKey: () => "runtime-key-value" }, "OpenAI's tunnel registry could not be reached"],
      [{ fetchImpl: answer(200, {}), readRuntimeKey: () => { throw new Error("ENOENT"); } }, "The tunnel runtime key file could not be read"],
      [{ fetchImpl: answer(200, {}), readRuntimeKey: () => "   " }, "The tunnel runtime key file is empty"],
      [{ fetchImpl: answer(500, {}), readRuntimeKey: () => "k" }, "OpenAI's tunnel registry answered HTTP 500"],
      [{ fetchImpl: answer(200, undefined), readRuntimeKey: () => "k" }, "OpenAI's tunnel registry answered with an unreadable body"],
      [{ fetchImpl: answer(200, { id: "tunnel_ffffffffffffffffffffffffffffffff" }), readRuntimeKey: () => "k" },
        "OpenAI's tunnel registry answered about another tunnel"],
    ] as const) {
      const result = await fetchTunnelRegistryRecord(fullConfig(), options);
      expect(result).toEqual({ status: "unproven", detail });
      // A failure's own message can carry the request and its bearer token; it never leaves here.
      expect(JSON.stringify(result)).not.toContain("runtime-key-value");
    }
  });

  test("browser-only mode has no tunnel to ask about", async () => {
    expect(await fetchTunnelRegistryRecord(defaultConfig("browser-only"), { fetchImpl: answer(200, {}) }))
      .toEqual({ status: "unproven", detail: "No MCP tunnel is configured" });
  });

  test("a tunnel with no workspace is exactly ChatGPT's \"No tunnels yet\"", () => {
    expect(tunnelWorkspaceSharing({ id: TUNNEL_ID, name: "codex-web", organizationIds: ["org-abc"], workspaceIds: ["ws"] }))
      .toEqual({ status: "shared", workspaces: 1 });
    expect(tunnelWorkspaceSharing({ id: TUNNEL_ID, name: "codex-web", organizationIds: ["org-abc"], workspaceIds: [] }))
      .toEqual({ status: "not-shared" });
    expect(tunnelWorkspaceSharing({ id: TUNNEL_ID, name: null, organizationIds: [], workspaceIds: [] }))
      .toEqual({ status: "unknown" });
  });

  test("a record is read defensively and never invents identifiers", () => {
    expect(parseTunnelRegistryRecord({ name: 7, organization_ids: ["org", 3, ""], workspace_ids: "ws" }, TUNNEL_ID))
      .toEqual({ id: TUNNEL_ID, name: null, organizationIds: ["org"], workspaceIds: [] });
    expect(parseTunnelRegistryRecord([], TUNNEL_ID)).toBeUndefined();
    expect(parseTunnelRegistryRecord(null, TUNNEL_ID)).toBeUndefined();
    expect(parseTunnelRegistryRecord({ id: "tunnel_other" }, TUNNEL_ID)).toBeUndefined();
  });
});
