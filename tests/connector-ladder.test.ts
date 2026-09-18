import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_CONNECTOR_CATALOG_WAITS_MS,
  CHATGPT_CONNECTOR_UNOBSERVED_CONTACT_WAITS_MS,
  ChatGptBrowserWorker,
  ChatGptConnectorCatalogStaleError,
  ChatGptRateLimitCooldown,
  chatGptConnectorMentionKind,
  chatGptConnectorRegistryFailure,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import {
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
  requestLauncherConnectorTunnel,
  type LauncherConnectorTunnelStatus,
} from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const sent = new Error("fixture reached send");

type TunnelAnswer = Partial<LauncherConnectorTunnelStatus> | undefined;

function tunnel(
  readyz: boolean | null,
  contact: "observed" | "not-observed" | "unknown",
  restart = "not-requested",
  registry: LauncherConnectorTunnelStatus["registry"] = { status: "ok", sharing: "shared", tunnelName: "codex-web", workspaceMatch: "match" },
): TunnelAnswer {
  return {
    tunnelReady: readyz,
    readyz,
    contact: { status: contact, at: contact === "observed" ? "2026-09-18T08:27:03.000Z" : null },
    registry,
    restart,
  };
}

/**
 * A worker whose browser actions are recorded instead of performed. `listedOnMention` says on
 * which connector mention (1-based) ChatGPT finally lists the connector; 0 means never.
 */
function ladderFixture({
  listedOnMention,
  answer,
  multipart = false,
}: {
  listedOnMention: number;
  answer: (request: Record<string, unknown>, index: number) => TunnelAnswer;
  multipart?: boolean;
}) {
  const diagnostics = mkdtempSync(join(tmpdir(), "cgw-connector-ladder-"));
  roots.push(diagnostics);
  const calls: string[] = [];
  const tunnelRequests: Record<string, unknown>[] = [];
  let mentions = 0;
  const controller = new AbortController();
  const page = {
    evaluate: async () => ({}),
    isClosed: () => false,
    reload: async () => { calls.push("reload"); },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics },
    rateLimitCooldown: new ChatGptRateLimitCooldown(),
    runStage: async (_trace: string, _name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => (
      action(new AbortController().signal)
    ),
    prepareTemporaryChatSurface: async () => { calls.push("prepare"); },
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => (
      resolveChatGptWebModelMode(model, effort, capabilities)
    ),
    captureSubmissionBaseline: async () => ({}),
    attachPromptWithIntegrityRetry: async (
      _page: unknown,
      _text: string,
      localTools: boolean,
      _baseline: unknown,
      _capture: unknown,
      _signal: unknown,
      catalogRefreshAvailable: boolean,
    ) => {
      mentions += 1;
      calls.push(`mention:${mentions}`);
      if (!localTools) throw new Error("the connector ladder applies only to tool-capable turns");
      if (listedOnMention === 0 || mentions < listedOnMention) {
        if (!catalogRefreshAvailable) throw new Error("fixture expected a ladder-capable turn");
        throw new ChatGptConnectorCatalogStaleError("Codex Native2", 1);
      }
    },
    attachFiles: async () => { calls.push("files"); },
    sendAttachedPrompt: async () => {
      calls.push("send");
      throw sent;
    },
    waitForMultipartAcknowledgement: async () => {},
    waitForNewAssistantTurn: async () => ({}),
    connectorTunnelStatus: async (_trace: string, request: Record<string, unknown>) => {
      tunnelRequests.push(request);
      calls.push(request.restart === true && request.waitStep === undefined ? "tunnel:restart" : "tunnel");
      return answer(request, tunnelRequests.length - 1);
    },
    connectorLadderSleep: async (milliseconds: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      calls.push(`sleep:${milliseconds}`);
    },
  });
  const run = () => worker.runBrowserTurn({
    traceId: "connector_ladder_fixture",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities,
    externalProgress: new ChatGptExternalTurnProgress(),
    abortSignal: controller.signal,
    completionFence: {
      begin: async () => undefined,
      commit: async () => false,
    },
    prepare: async () => ({
      text: "Run pwd",
      images: [],
      multipart: multipart ? { parts: ['{"part":1}', '{"part":2}'], commit: "Run pwd" } : undefined,
      release: () => {},
    }),
    onTextDelta: () => {},
  }, "owned-surface", page);
  return { worker, run, calls, tunnelRequests, controller };
}

test("a connector ChatGPT lists on the third mention is attached before anything is sent", async () => {
  const fixture = ladderFixture({ listedOnMention: 3, answer: () => tunnel(true, "observed") });
  await expect(fixture.run()).rejects.toBe(sent);
  expect(fixture.calls).toEqual([
    "prepare", "mention:1",
    "tunnel",
    "reload", "prepare", "mention:2",
    "tunnel", `sleep:${CHATGPT_CONNECTOR_CATALOG_WAITS_MS[0]}`,
    "reload", "prepare", "mention:3",
    "files", "send",
  ]);
  expect(fixture.tunnelRequests[1]).toMatchObject({ waitStep: 1, waitTotal: 5, waitMs: 15_000 });
});

test("a tunnel whose /readyz does not answer gets exactly one restart request, then the turn goes on", async () => {
  const fixture = ladderFixture({
    listedOnMention: 2,
    answer: (request, index) => {
      if (index === 0) return tunnel(false, "observed");
      if (request.restart === true) return tunnel(null, "observed", "requested");
      return index < 3 ? tunnel(null, "observed") : tunnel(true, "observed");
    },
  });
  await expect(fixture.run()).rejects.toBe(sent);
  expect(fixture.tunnelRequests.filter(request => request.restart === true)).toHaveLength(1);
  expect(fixture.calls).toEqual([
    "prepare", "mention:1",
    "tunnel", "tunnel:restart", "sleep:2000", "tunnel", "sleep:2000", "tunnel",
    "reload", "prepare", "mention:2",
    "files", "send",
  ]);
});

test("a tunnel that never becomes ready fails as tunnel_unavailable without waiting on ChatGPT", async () => {
  const fixture = ladderFixture({
    listedOnMention: 0,
    answer: (request) => request.restart === true ? tunnel(false, "unknown", "requested") : tunnel(false, "unknown"),
  });
  const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({ status: 424, code: "connector_not_found:tunnel_unavailable", retryable: false });
  expect(error.message).toContain("send the task again");
  expect(fixture.tunnelRequests.filter(request => request.restart === true)).toHaveLength(1);
  expect(fixture.calls.filter(call => call === "sleep:2000")).toHaveLength(15);
  expect(fixture.calls).not.toContain("reload");
  expect(fixture.calls).not.toContain("send");
});

test("a tunnel ChatGPT never reached fails at once with one action for the person", async () => {
  const fixture = ladderFixture({ listedOnMention: 0, answer: () => tunnel(true, "not-observed") });
  const startedAt = performance.now();
  const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
  expect(performance.now() - startedAt).toBeLessThan(10_000);
  expect(error).toMatchObject({ status: 424, code: "connector_not_found:never_contacted", retryable: false });
  expect(error.message).toContain('named exactly "Codex Native2"');
  expect(fixture.calls).toEqual(["prepare", "mention:1", "tunnel"]);
});

test("after ChatGPT reached the tunnel the turn waits 15/30/60/60/60 s, then names the next step", async () => {
  const fixture = ladderFixture({ listedOnMention: 0, answer: () => tunnel(true, "observed") });
  const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
  expect(error).toMatchObject({ status: 424, code: "connector_not_found:not_listed", retryable: false });
  expect(error.message).toContain("ChatGPT reached this computer's MCP tunnel");
  expect(fixture.calls.filter(call => call.startsWith("sleep:"))).toEqual(
    CHATGPT_CONNECTOR_CATALOG_WAITS_MS.map(wait => `sleep:${wait}`),
  );
  expect(fixture.calls.filter(call => call === "reload")).toHaveLength(1 + CHATGPT_CONNECTOR_CATALOG_WAITS_MS.length);
  expect(fixture.calls.filter(call => call.startsWith("mention:"))).toHaveLength(2 + CHATGPT_CONNECTOR_CATALOG_WAITS_MS.length);
  expect(fixture.calls).not.toContain("send");
  expect(fixture.tunnelRequests.slice(1).map(request => request.waitStep)).toEqual([1, 2, 3, 4, 5]);
});

test("without a launcher to ask, the wait is short and the failure still names a next step", async () => {
  const fixture = ladderFixture({ listedOnMention: 0, answer: () => undefined });
  const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
  expect(error).toMatchObject({ code: "connector_not_found:not_listed" });
  expect(error.message).toContain("create it in ChatGPT for this computer's tunnel if it does not exist");
  expect(fixture.calls.filter(call => call.startsWith("sleep:"))).toEqual(
    CHATGPT_CONNECTOR_UNOBSERVED_CONTACT_WAITS_MS.map(wait => `sleep:${wait}`),
  );
});

test("a contact seen during a short wait extends it to the full ladder", async () => {
  const fixture = ladderFixture({
    listedOnMention: 0,
    answer: (_request, index) => index === 0 ? tunnel(true, "unknown") : tunnel(true, "observed"),
  });
  await fixture.run().catch(() => {});
  expect(fixture.calls.filter(call => call.startsWith("sleep:"))).toEqual(
    CHATGPT_CONNECTOR_CATALOG_WAITS_MS.map(wait => `sleep:${wait}`),
  );
});

test("aborting the turn during a wait stops the ladder without touching the page again", async () => {
  const fixture = ladderFixture({ listedOnMention: 0, answer: () => tunnel(true, "observed") });
  fixture.worker.connectorLadderSleep = async () => {
    fixture.calls.push("sleep");
    fixture.controller.abort();
    throw new DOMException("ChatGPT web turn aborted", "AbortError");
  };
  const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
  expect(error).toMatchObject({ name: "AbortError" });
  const afterSleep = fixture.calls.slice(fixture.calls.indexOf("sleep") + 1);
  expect(afterSleep).toEqual([]);
  expect(fixture.calls).not.toContain("send");
});

test("a staged Bigger Context turn never reloads its conversation to wait for the connector", async () => {
  const fixture = ladderFixture({ listedOnMention: 0, answer: () => tunnel(true, "observed"), multipart: true });
  fixture.worker.attachPromptWithIntegrityRetry = async (
    _page: unknown,
    _text: string,
    localTools: boolean,
    _baseline: unknown,
    _capture: unknown,
    _signal: unknown,
    catalogRefreshAvailable: boolean,
  ) => {
    fixture.calls.push(`attach:${localTools}:${catalogRefreshAvailable}`);
    if (localTools) throw new ChatGptConnectorCatalogStaleError("Codex Native2", 1);
  };
  fixture.worker.attachPrompt = async () => { fixture.calls.push("stage"); };
  fixture.worker.sendAttachedPrompt = async () => "user_turn";
  await expect(fixture.run()).rejects.toBeInstanceOf(ChatGptConnectorCatalogStaleError);
  expect(fixture.calls).toContain("attach:true:false");
  expect(fixture.calls).not.toContain("reload");
  expect(fixture.tunnelRequests).toHaveLength(0);
});

test("menu evidence maps to a kind without keeping the row titles", () => {
  expect(chatGptConnectorMentionKind("Codex Native2", [])).toBe("menu_unavailable");
  expect(chatGptConnectorMentionKind("Codex Native2", ["Another connector"])).toBe("not_listed");
  expect(chatGptConnectorMentionKind("Codex Native2", ["Codex Native2"])).toBe("selection_failed");
  expect(chatGptConnectorMentionKind("Codex Native2", ["codex native2"])).toBe("other_name");
  expect(chatGptConnectorMentionKind("Codex Native2", ["Codex Native"])).toBe("other_name");
  expect(chatGptConnectorMentionKind("Codex Native2", ["Codex Native2 DEV"])).toBe("other_name");
});

function descriptorFile(controlEndpoint: string): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-connector-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    control: { endpoint: controlEndpoint, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

async function controlServer(respond: (url: string, body: Record<string, unknown>) => unknown) {
  const received: { url: string; authorization?: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    received.push({ url: request.url ?? "", authorization: request.headers.authorization, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(respond(request.url ?? "", body))}\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("control server has no port");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    received,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test("the helper asks the launcher about the tunnel with its control token and reads the answer defensively", async () => {
  const server = await controlServer(() => ({
    tunnelReady: true,
    readyz: true,
    contact: { status: "observed", at: "2026-09-18T08:27:03.000Z" },
    registry: { status: "ok", sharing: "shared", tunnelName: "codex-web", workspaceMatch: "match", extra: "ignored" },
    restart: "not-requested",
    extra: "ignored",
  }));
  try {
    const path = descriptorFile(server.endpoint);
    await expect(requestLauncherConnectorTunnel(path, {
      traceId: "abc123def456",
      helperPid: process.pid,
      restart: true,
    })).resolves.toEqual({
      tunnelReady: true,
      readyz: true,
      contact: { status: "observed", at: "2026-09-18T08:27:03.000Z" },
      registry: { status: "ok", sharing: "shared", tunnelName: "codex-web", workspaceMatch: "match" },
      restart: "not-requested",
    });
    expect(server.received[0]).toMatchObject({
      url: "/v1/connector/tunnel",
      authorization: "Bearer launcher-control-token-0123456789abcdefghijklmnop",
      body: { traceId: "abc123def456", helperPid: process.pid, restart: true },
    });
  } finally {
    await server.close();
  }
  const odd = await controlServer(() => ({
    readyz: "yes",
    contact: { status: "maybe", at: "never" },
    registry: { status: "maybe", sharing: "sometimes", tunnelName: 7, workspaceMatch: "perhaps" },
    restart: "<b>",
  }));
  try {
    await expect(requestLauncherConnectorTunnel(descriptorFile(odd.endpoint), {
      traceId: "abc123def456",
      helperPid: process.pid,
    })).resolves.toEqual({
      tunnelReady: null,
      readyz: null,
      contact: { status: "unknown", at: null },
      registry: { status: "unproven", sharing: "unknown", tunnelName: null, workspaceMatch: "unknown" },
      restart: "unknown",
    });
  } finally {
    await odd.close();
  }
});

test("a turn that ends on a connector failure tells the launcher its structured code", async () => {
  const server = await controlServer((url) => url === "/v1/turn/start"
    ? { ok: true, surfaceId: "launcher_surface_id_0123456789AB", reused: false, connectorBound: false }
    : { ok: true, cancelledByUser: false });
  try {
    const failure = new ChatGptWebAdapterError("ChatGPT still does not list connector \"Codex Native2\"", {
      status: 424,
      errorType: "connector_error",
      code: "connector_not_found:not_listed",
      retryable: false,
    });
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: descriptorFile(server.endpoint) },
      runBrowserTurn: async () => { throw failure; },
    });
    await expect(worker.runExclusive({
      traceId: "abc123def456",
      modelId: "gpt-5.6-sol",
      capabilities,
      prepare: async () => ({ text: "x", images: [], release: () => {} }),
      onTextDelta: () => {},
    })).rejects.toBe(failure);
    const end = server.received.find(request => request.url === "/v1/turn/end");
    expect(end?.body).toMatchObject({ status: "failed", failureCode: "connector_not_found:not_listed" });

    worker.runBrowserTurn = async () => { throw new Error("ChatGPT stopped responding"); };
    await expect(worker.runExclusive({
      traceId: "abc123def457",
      modelId: "gpt-5.6-sol",
      capabilities,
      prepare: async () => ({ text: "x", images: [], release: () => {} }),
      onTextDelta: () => {},
    })).rejects.toThrow("stopped responding");
    const otherEnd = server.received.filter(request => request.url === "/v1/turn/end").at(-1);
    expect(otherEnd?.body.failureCode).toBeUndefined();
  } finally {
    await server.close();
  }
});

// After the owner changed their ChatGPT password on 18.09.2026 the tunnel stayed healthy locally,
// but it had lost its workspace: ChatGPT's New Plugin -> Tunnel said "No tunnels yet", the connector
// was gone from the account, and every turn burned the full catalog ladder before failing. OpenAI's
// own record of the tunnel settles both cases before a single wait.
test("a tunnel OpenAI no longer has fails at once and names creating one", async () => {
  const fixture = ladderFixture({
    listedOnMention: 0,
    answer: () => tunnel(true, "observed", "not-requested", { status: "missing", sharing: "unknown", tunnelName: null, workspaceMatch: "unknown" }),
  });
  const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
  expect(error).toMatchObject({ status: 424, code: "connector_not_found:tunnel_missing", retryable: false });
  expect(error.message).toContain("platform.openai.com/settings/organization/tunnels");
  expect(fixture.calls).toEqual(["prepare", "mention:1", "tunnel"]);
  expect(fixture.calls).not.toContain("send");
});

test("a tunnel shared with no workspace fails at once and names sharing it", async () => {
  const fixture = ladderFixture({
    listedOnMention: 0,
    answer: () => tunnel(true, "unknown", "not-requested", { status: "ok", sharing: "not-shared", tunnelName: "codex-web", workspaceMatch: "unknown" }),
  });
  const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
  expect(error).toMatchObject({ status: 424, code: "connector_not_found:tunnel_not_shared", retryable: false });
  expect(error.message).toContain('share tunnel "codex-web"');
  expect(error.message).toContain("this ChatGPT workspace");
  expect(fixture.calls).toEqual(["prepare", "mention:1", "tunnel"]);
});

test("an unproven or unauthorized registry answer changes nothing about the ladder", async () => {
  for (const registry of [
    { status: "unproven", sharing: "unknown", tunnelName: null, workspaceMatch: "unknown" },
    { status: "unauthorized", sharing: "unknown", tunnelName: null, workspaceMatch: "unknown" },
    { status: "ok", sharing: "unknown", tunnelName: null, workspaceMatch: "unknown" },
    // A workspace this computer could not read never ends a turn on its own.
    { status: "ok", sharing: "shared", tunnelName: "codex-web", workspaceMatch: "unknown" },
  ] as const) {
    const fixture = ladderFixture({
      listedOnMention: 0,
      answer: () => tunnel(true, "observed", "not-requested", { ...registry }),
    });
    const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
    expect(error).toMatchObject({ code: "connector_not_found:not_listed" });
    expect(fixture.calls.filter(call => call.startsWith("sleep:"))).toEqual(
      CHATGPT_CONNECTOR_CATALOG_WAITS_MS.map(wait => `sleep:${wait}`),
    );
  }
});

test("a registry verdict a turn cannot understand never ends the turn", () => {
  expect(chatGptConnectorRegistryFailure("Codex Native2", undefined)).toBeUndefined();
  expect(chatGptConnectorRegistryFailure("Codex Native2", { status: "ok", sharing: "shared", tunnelName: "codex-web", workspaceMatch: "match" }))
    .toBeUndefined();
  expect(chatGptConnectorRegistryFailure("Codex Native2", { status: "unproven", sharing: "not-shared", tunnelName: null, workspaceMatch: "unknown" }))
    .toBeUndefined();
});

// 19.09.2026: two ChatGPT accounts were signed in to the embedded browser, the connector and the
// tunnel belonged to the one that was not active, and every turn kept going to the active account
// where no connector existed. ChatGPT Web switching accounts is supported (upstream #563), so the
// mismatch has to be named, not waited out.
test("a ChatGPT workspace the tunnel is not shared with fails at once and names the account to switch", async () => {
  const fixture = ladderFixture({
    listedOnMention: 0,
    answer: () => tunnel(true, "unknown", "not-requested",
      { status: "ok", sharing: "shared", tunnelName: "codex-web", workspaceMatch: "mismatch" }),
  });
  const error = await fixture.run().catch((caught: Error & { code?: string }) => caught);
  expect(error).toMatchObject({ status: 424, code: "connector_not_found:wrong_workspace", retryable: false });
  expect(error.message).toContain("switch ChatGPT back to the workspace");
  expect(error.message).toContain("platform.openai.com/settings/organization/tunnels");
  expect(fixture.calls).toEqual(["prepare", "mention:1", "tunnel"]);
  expect(fixture.calls).not.toContain("send");
});
