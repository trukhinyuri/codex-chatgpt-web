import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIPROXY_ROUTES_FILE,
  augmentCatalogWithCliProxy,
  cliProxyRouteFor,
  compactViaCliProxy,
  compactionTurnViaCliProxy,
  completedResponseFromSse,
  fetchWithRestartTolerance,
  forwardCliProxyResponses,
  loopbackBaseUrl,
  mergeCliProxyModels,
  readCliProxyConnection,
  resetCliProxyStateForTests,
  scrubHistoryForCliProxy,
} from "../src/cliproxy";
import { COMPACT_PROMPT, OPAQUE_COMPACTION_NOTE, SUMMARY_PREFIX, decodeCompactionSummary, encodeCompactionSummary } from "../src/responses/compaction";
import { defaultConfig } from "../src/config";
import { compactRequest, modelsRequest, responseRequest } from "../src/server";

const KEY = "sk-proxy-test-key";
let home: string;

function writeConnection(extra: Record<string, unknown> = {}): void {
  const keyFile = join(home, "secrets", "cliproxy-api-key");
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  writeFileSync(join(home, "cliproxy.json"), JSON.stringify({
    version: 1, enabled: true, baseUrl: "http://127.0.0.1:8317", apiKeyFile: keyFile, ...extra,
  }));
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function completedText(text: string): string {
  return sse([{
    type: "response.completed",
    response: { id: "resp_1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] },
  }]);
}

const NATIVE = { slug: "gpt-6-astra", priority: 3, visibility: "list", supported_in_api: true, supported_reasoning_levels: [] };
// A complete row as CLIProxyAPI answers in Codex's catalog schema.
function proxyRow(slug: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    supported_reasoning_levels: [],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: false,
    priority: 0,
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: null,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    experimental_supported_tools: [],
    model_messages: { instructions_template: "You are Codex." },
    ...fields,
  };
}
const CLAUDE = proxyRow("claude-fable-5-1");
const GLM = proxyRow("glm-5.3", { priority: 1, supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }] });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cwg-cliproxy-"));
  mkdirSync(join(home, "runtime"), { recursive: true });
  resetCliProxyStateForTests();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetCliProxyStateForTests();
});

describe("CLIProxyAPI connection", () => {
  test("accepts only a proxy on this machine", () => {
    expect(loopbackBaseUrl("http://127.0.0.1:8317/")).toBe("http://127.0.0.1:8317");
    expect(loopbackBaseUrl("http://localhost:8317")).toBe("http://localhost:8317");
    expect(loopbackBaseUrl("http://[::1]:8317")).toBe("http://[::1]:8317");
    expect(loopbackBaseUrl("https://proxy.example.com")).toBeNull();
    expect(loopbackBaseUrl("http://127.0.0.1.evil.com:8317")).toBeNull();
    expect(loopbackBaseUrl("http://user:pass@127.0.0.1:8317")).toBeNull();
    expect(loopbackBaseUrl("http://127.0.0.1:8317/?key=x")).toBeNull();
    expect(loopbackBaseUrl("file:///etc/passwd")).toBeNull();
  });

  test("is off without a file, off when disabled, and strict about the key", () => {
    expect(readCliProxyConnection(home)).toBeNull();
    writeConnection({ enabled: false });
    expect(readCliProxyConnection(home)).toBeNull();
    writeConnection();
    expect(readCliProxyConnection(home)).toEqual({ baseUrl: "http://127.0.0.1:8317", apiKey: KEY });
    writeConnection({ baseUrl: "https://api.example.com" });
    expect(() => readCliProxyConnection(home)).toThrow(/on this machine/);
    writeConnection({ apiKeyFile: "relative/key" });
    expect(() => readCliProxyConnection(home)).toThrow(/absolute apiKeyFile/);
    writeConnection();
    writeFileSync(join(home, "secrets", "cliproxy-api-key"), "CLIPROXY_API_KEY=a b\n");
    expect(() => readCliProxyConnection(home)).toThrow(/exactly one API key/);
  });
});

describe("catalog", () => {
  test("proxy models follow the native rows, and a native slug stays native", () => {
    const { catalog, added } = mergeCliProxyModels(
      { models: [NATIVE, { slug: "chatgpt-web/high", priority: 4 }] },
      [{ ...NATIVE, display_name: "pooled" }, CLAUDE, GLM, { slug: "chatgpt-web/pro" }],
    );
    expect(added).toEqual(["claude-fable-5-1", "glm-5.3"]);
    const models = catalog.models as Array<Record<string, unknown>>;
    expect(models.map(model => model.slug)).toEqual(["gpt-6-astra", "chatgpt-web/high", "claude-fable-5-1", "glm-5.3"]);
    expect(models[0]).toEqual(NATIVE);
    expect(models[2]).toMatchObject({ supported_in_api: true, priority: 6 });
    expect(models[3]).toMatchObject({ supported_in_api: true, priority: 7 });
  });

  test("a proxy row Codex would reject is left out, so Codex keeps the whole catalog", () => {
    const { catalog, added, rejected } = mergeCliProxyModels({ models: [NATIVE] }, [
      proxyRow("no-instructions", { model_messages: {} }),
      proxyRow("legacy-instructions", { model_messages: undefined, base_instructions: "You are Codex." }),
      proxyRow("bad-shell", { shell_type: "zsh" }),
      proxyRow("bad-truncation", { truncation_policy: { mode: "lines", limit: 1 } }),
      proxyRow("bad-levels", { supported_reasoning_levels: [{ effort: "high" }] }),
      proxyRow("no-verbosity-flag", { support_verbosity: undefined }),
      CLAUDE,
    ]);
    expect(added).toEqual(["legacy-instructions", "claude-fable-5-1"]);
    expect(rejected).toEqual([
      { slug: "no-instructions", field: "instructions" },
      { slug: "bad-shell", field: "shell_type" },
      { slug: "bad-truncation", field: "truncation_policy" },
      { slug: "bad-levels", field: "supported_reasoning_levels" },
      { slug: "no-verbosity-flag", field: "support_verbosity" },
    ]);
    expect((catalog.models as Array<{ slug: string }>).map(model => model.slug)).toEqual(["gpt-6-astra", "legacy-instructions", "claude-fable-5-1"]);
  });

  test("an optional field Codex does not know is removed instead of costing the catalog", () => {
    const { catalog, added } = mergeCliProxyModels({ models: [NATIVE] }, [
      proxyRow("odd-fields", { default_verbosity: "loud", web_search_tool_type: "video", input_modalities: ["text", "smell"], context_window: "big", use_responses_lite: false }),
    ]);
    expect(added).toEqual(["odd-fields"]);
    const row = (catalog.models as Array<Record<string, unknown>>)[1]!;
    expect(row).not.toHaveProperty("default_verbosity");
    expect(row).not.toHaveProperty("web_search_tool_type");
    expect(row).not.toHaveProperty("input_modalities");
    expect(row).not.toHaveProperty("context_window");
    expect(row.use_responses_lite).toBe(false);
    expect(row).not.toHaveProperty("available_access_programs");
  });

  test("the catalog stays within the 100 rows Codex Desktop reads, and only proxy rows give way", () => {
    const native = Array.from({ length: 60 }, (_, index) => ({ ...NATIVE, slug: `native-${index}`, priority: index }));
    const proxy = Array.from({ length: 50 }, (_, index) => proxyRow(`proxy-${index}`, index < 4 ? { visibility: "hide" } : {}));
    const { catalog, added, dropped } = mergeCliProxyModels({ models: native }, proxy);
    const slugs = (catalog.models as Array<{ slug: string }>).map(model => model.slug);
    expect(slugs).toHaveLength(100);
    expect(slugs.slice(0, 60)).toEqual(native.map(model => model.slug));
    expect(dropped).toEqual(["proxy-0", "proxy-1", "proxy-2", "proxy-3", "proxy-44", "proxy-45", "proxy-46", "proxy-47", "proxy-48", "proxy-49"]);
    expect(added).toHaveLength(40);
    expect(added).not.toContain("proxy-49");
    const nativeMax = Math.max(...native.map(model => model.priority));
    expect((catalog.models as Array<{ slug: string; priority: number }>).filter(model => model.slug.startsWith("proxy-")).every(model => model.priority > nativeMax)).toBe(true);
  });

  test("asks the proxy with its own key for the Codex catalog and records the routes", async () => {
    writeConnection();
    const seen: Request[] = [];
    const incoming = new Request("http://127.0.0.1:17841/v1/models?client_version=0.155.0", {
      headers: { authorization: "Bearer chatgpt-oauth", "chatgpt-account-id": "acct", "user-agent": "codex_cli_rs/0.155.0" },
    });
    const catalog = await augmentCatalogWithCliProxy({ models: [NATIVE] }, incoming, {
      home,
      fetchImpl: async request => { seen.push(request); return Response.json({ models: [CLAUDE, NATIVE] }); },
    });
    expect((catalog.models as Array<{ slug: string }>).map(model => model.slug)).toEqual(["gpt-6-astra", "claude-fable-5-1"]);
    expect(seen[0]!.url).toBe("http://127.0.0.1:8317/v1/models?client_version=0.155.0");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers.get("chatgpt-account-id")).toBeNull();
    expect(seen[0]!.headers.get("user-agent")).toBe("codex_cli_rs/0.155.0");
    expect(JSON.parse(readFileSync(join(home, CLIPROXY_ROUTES_FILE), "utf8"))).toEqual({ native: ["gpt-6-astra"], proxy: ["claude-fable-5-1"] });
    expect(cliProxyRouteFor("claude-fable-5-1", home)).toEqual({ baseUrl: "http://127.0.0.1:8317", apiKey: KEY });
    expect(cliProxyRouteFor("gpt-6-astra", home)).toBeNull();
    expect(cliProxyRouteFor("chatgpt-web/high", home)).toBeNull();
  });

  test("a proxy that is down or restarting never costs Codex its catalog", async () => {
    writeConnection();
    const incoming = new Request("http://127.0.0.1:17841/v1/models?client_version=1.0.0");
    const unavailable = await augmentCatalogWithCliProxy({ models: [NATIVE] }, incoming, {
      home, fetchImpl: async () => new Response("bad gateway", { status: 502 }),
    });
    expect(unavailable).toEqual({ models: [NATIVE] });

    await augmentCatalogWithCliProxy({ models: [NATIVE] }, incoming, { home, fetchImpl: async () => Response.json({ models: [CLAUDE] }) });
    resetCliProxyStateForTests();
    // A restarted bridge still knows the routes from disk.
    expect(cliProxyRouteFor("claude-fable-5-1", home)).not.toBeNull();
  });
});

describe("forwarding", () => {
  test("the proxy gets its own key, never the ChatGPT credentials, and the stream comes back unchanged", async () => {
    let upstream: Request | undefined;
    const incoming = new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer chatgpt-oauth", cookie: "session=1", "chatgpt-account-id": "acct",
        "openai-organization": "org", session_id: "thread-1", "user-agent": "codex_cli_rs/0.155.0",
      },
      body: "{}",
    });
    const body = completedText("hello");
    const response = await forwardCliProxyResponses(incoming, { model: "claude-fable-5-1", input: [], stream: true }, { baseUrl: "http://127.0.0.1:8317", apiKey: KEY }, async request => {
      upstream = request;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    expect(upstream!.url).toBe("http://127.0.0.1:8317/v1/responses");
    expect(upstream!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    for (const name of ["cookie", "chatgpt-account-id", "openai-organization"]) expect(upstream!.headers.get(name)).toBeNull();
    expect(upstream!.headers.get("session_id")).toBe("thread-1");
    expect(await upstream!.json()).toEqual({ model: "claude-fable-5-1", input: [], stream: true });
    expect(await response.text()).toBe(body);
  });

  test("history from other backends becomes readable text for the proxy", () => {
    const scrubbed = scrubHistoryForCliProxy({
      model: "claude-fable-5-1",
      previous_response_id: "resp_native",
      input: [
        { type: "compaction", encrypted_content: encodeCompactionSummary("did A, next B") },
        { type: "compaction", encrypted_content: "gAAAAAopaque" },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ocxr1:bridge" },
        { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "claude-signature" },
      ],
    });
    expect(scrubbed.previous_response_id).toBeUndefined();
    expect(scrubbed.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\ndid A, next B` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: OPAQUE_COMPACTION_NOTE }] },
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "claude-signature" },
    ]);
    const untouched = { model: "m", previous_response_id: "keep", input: [{ type: "message", role: "user", content: "hi" }] };
    expect(scrubHistoryForCliProxy(untouched)).toBe(untouched);
  });

  test("a rejected key is reported without echoing it", async () => {
    const response = await forwardCliProxyResponses(new Request("http://127.0.0.1/v1/responses", { method: "POST", body: "{}" }), { model: "m" }, { baseUrl: "http://127.0.0.1:8317", apiKey: KEY }, async () => new Response("unauthorized", { status: 401 }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("cliproxy_unauthorized");
    expect(text).not.toContain(KEY);
  });

  test("a proxy restarting for an update is waited out; other failures are not retried", async () => {
    // A real refused connection, as Bun reports it, on a port nothing listens on.
    const closed = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = closed.port;
    closed.stop(true);
    let attempts = 0;
    const response = await fetchWithRestartTolerance(
      () => new Request(`http://127.0.0.1:${port}/v1/models`),
      async request => {
        attempts += 1;
        if (attempts < 3) return await fetch(request);
        return new Response("ok");
      },
      undefined,
      5_000,
    );
    expect(await response.text()).toBe("ok");
    expect(attempts).toBe(3);

    let other = 0;
    await expect(fetchWithRestartTolerance(() => new Request("http://127.0.0.1:1/"), async () => {
      other += 1;
      throw new Error("TLS handshake failed");
    }, undefined, 5_000)).rejects.toThrow("TLS handshake failed");
    expect(other).toBe(1);
  });
});

describe("compaction", () => {
  const connection = { baseUrl: "http://127.0.0.1:8317", apiKey: KEY };
  const history = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Refactor the parser" }] },
    { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ];

  test("v1 asks the model for Codex's summary and returns the replacement history", async () => {
    let sent: Record<string, unknown> | undefined;
    const response = await compactViaCliProxy(
      new Request("http://127.0.0.1/v1/responses/compact", { method: "POST", body: "{}" }),
      { model: "claude-fable-5-1", instructions: "sys", tools: [{ type: "function", name: "shell" }], input: history },
      connection,
      async request => { sent = await request.json() as Record<string, unknown>; return new Response(completedText("SUMMARY: parser half done")); },
    );
    const input = sent!.input as Array<Record<string, unknown>>;
    expect(input.at(-1)).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] });
    expect(sent).toMatchObject({ model: "claude-fable-5-1", instructions: "sys", stream: true, store: false });
    const output = (await response.json() as { output: Array<{ content: Array<{ text: string }> }> }).output;
    expect(output[0]!.content[0]!.text).toBe("Refactor the parser");
    expect(output.at(-1)!.content[0]!.text).toBe(`${SUMMARY_PREFIX}\nSUMMARY: parser half done`);
  });

  test("v2 streams exactly one compaction item that later turns can read", async () => {
    const response = await compactionTurnViaCliProxy(
      new Request("http://127.0.0.1/v1/responses", { method: "POST", body: "{}" }),
      { model: "claude-fable-5-1", input: [...history, { type: "compaction_trigger" }] },
      connection,
      async request => {
        const sent = await request.json() as { input: Array<{ type?: string }> };
        expect(sent.input.some(item => item.type === "compaction_trigger")).toBe(false);
        return new Response(completedText("state of the work"));
      },
    );
    const completed = completedResponseFromSse(await response.text());
    const items = completed!.output as Array<{ type: string; encrypted_content: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("compaction");
    expect(decodeCompactionSummary(items[0]!.encrypted_content)).toBe("state of the work");
  });

  test("an empty or failed summary is an error, never an empty checkpoint", async () => {
    const request = new Request("http://127.0.0.1/v1/responses/compact", { method: "POST", body: "{}" });
    await expect(compactViaCliProxy(request, { model: "m", input: history }, connection, async () => new Response(completedText("  ")))).rejects.toThrow(/empty conversation summary/);
    await expect(compactViaCliProxy(request, { model: "m", input: history }, connection, async () => new Response("no", { status: 429 }))).rejects.toThrow(/HTTP 429/);
    await expect(compactViaCliProxy(request, { model: "m", input: history }, connection, async () => new Response(sse([{ type: "response.failed", response: { error: { message: "quota exhausted" } } }])))).rejects.toThrow(/quota exhausted/);
  });
});

describe("server routing", () => {
  test("the catalog, turns and compaction of a proxy model go to the proxy; native models stay native", async () => {
    writeConnection();
    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    const proxyCalls: string[] = [];
    const cliProxy = {
      home,
      fetchImpl: async (request: Request) => {
        proxyCalls.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.method === "GET") return Response.json({ models: [CLAUDE] });
        return new Response(completedText("from claude"), { headers: { "content-type": "text/event-stream" } });
      },
    };
    const nativeTemplate = { ...NATIVE, tool_mode: "code_mode_only", multi_agent_version: "v2", context_window: 272_000 };
    const models = await modelsRequest(
      new Request("http://127.0.0.1:17841/v1/models?client_version=1.0.0", { headers: { authorization: "Bearer chatgpt-oauth" } }),
      config,
      async () => Response.json({ models: [nativeTemplate] }),
      undefined,
      undefined,
      cliProxy,
    );
    const slugs = (await models.json() as { models: Array<{ slug: string }> }).models.map(model => model.slug);
    expect(slugs[0]).toBe("gpt-6-astra");
    expect(slugs.at(-1)).toBe("claude-fable-5-1");

    const turn = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer chatgpt-oauth", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5-1", input: [], stream: true }),
    }), config, undefined, { cliProxy });
    expect(await turn.text()).toContain("from claude");

    const compact = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
      method: "POST",
      headers: { authorization: "Bearer chatgpt-oauth", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5-1", input: [{ type: "message", role: "user", content: "go" }] }),
    }), config, undefined, { cliProxy });
    expect(compact.status).toBe(200);
    expect(proxyCalls).toEqual(["GET /v1/models", "POST /v1/responses", "POST /v1/responses"]);

    // Without the wiring (embedded servers, other tests) nothing is routed to a proxy.
    const unwired = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5-1", input: [] }),
    }), config);
    expect(unwired.status).toBe(502);
    expect(proxyCalls).toHaveLength(3);
  });
});
