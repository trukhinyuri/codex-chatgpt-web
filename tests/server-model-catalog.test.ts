import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { NativeModelCatalogLastGood } from "../src/model-catalog-cache";
import { MODEL_CATALOG_STALE_HEADER, startServer } from "../src/server";

const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
  "CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR"];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const roots: string[] = [];
afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nativeCatalog(): Record<string, unknown> {
  return {
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "5.6 Sol",
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: "low", description: "Low" }],
      tool_mode: "code_mode_only",
    }],
  };
}

/** Every console line the bridge prints while `run` executes, by level. */
async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<"debug" | "info" | "warn" | "error", string[]> }> {
  const lines = { debug: [] as string[], info: [] as string[], warn: [] as string[], error: [] as string[] };
  const original = { debug: console.debug, info: console.info, warn: console.warn, error: console.error, log: console.log };
  console.debug = (...values: unknown[]) => { lines.debug.push(values.map(String).join(" ")); };
  console.info = (...values: unknown[]) => { lines.info.push(values.map(String).join(" ")); };
  console.log = (...values: unknown[]) => { lines.info.push(values.map(String).join(" ")); };
  console.warn = (...values: unknown[]) => { lines.warn.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { lines.error.push(values.map(String).join(" ")); };
  try {
    return { result: await run(), lines };
  } finally {
    Object.assign(console, original);
  }
}

function catalogLines(lines: Record<string, string[]>): string[] {
  return Object.values(lines).flat().filter(line => line.includes("model_catalog"));
}

function expectStructuralOnly(lines: string[], forbidden: string[] = []): void {
  for (const line of lines) {
    expect(line).not.toContain("Bearer");
    expect(line).not.toMatch(/https?:/);
    expect(line).not.toMatch(/\/(Users|home|private|tmp|var)\//);
    for (const value of forbidden) expect(line).not.toContain(value);
    const json = line.slice(line.indexOf("{"));
    const detail = JSON.parse(json) as { failure?: { name?: string } };
    if (detail.failure?.name !== undefined) expect(detail.failure.name).toMatch(/^[A-Za-z]{1,40}$/);
  }
}

async function health(base: string): Promise<Record<string, any>> {
  return await (await fetch(`${base}/healthz`)).json() as Record<string, any>;
}

test("a model catalog request Codex abandons is neither a failure nor a newer catalog result", async () => {
  let upstreamCalls = 0;
  let enteredUpstream!: () => void;
  const entered = new Promise<void>(resolve => { enteredUpstream = resolve; });
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    modelCatalogRetryDelayMs: 1,
    fetchUpstream: request => {
      upstreamCalls += 1;
      enteredUpstream();
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const { lines } = await captureConsole(async () => {
      const client = new AbortController();
      const pending = fetch(`${base}/v1/models`, {
        headers: { authorization: "Bearer private-session-token", "chatgpt-account-id": "acct-1" },
        signal: client.signal,
      }).catch(() => null);
      await entered;
      client.abort();
      await pending;
      const deadline = Date.now() + 10_000;
      while ((await health(base)).client_aborted_model_catalog_requests !== 1 && Date.now() < deadline) await Bun.sleep(5);
    });
    const snapshot = await health(base);
    expect(snapshot).toMatchObject({
      client_aborted_model_catalog_requests: 1,
      model_catalog_requests: 1,
      successful_model_catalog_requests: 0,
      last_model_catalog_result: null,
      stale_model_catalog_responses: 0,
      catalog_stale_age_sec: null,
    });
    expect(upstreamCalls).toBe(1);
    expect(lines.warn.filter(line => line.includes("model_catalog"))).toEqual([]);
    expect(lines.debug.filter(line => line.includes("model_catalog_client_aborted"))).toHaveLength(1);
    expect(lines.debug[0]).toStartWith("[codex-chatgpt-web] debug model_catalog_client_aborted {");
    expectStructuralOnly(catalogLines(lines), ["private-session-token"]);
  } finally {
    await server.stop(true);
  }
});

test("real catalog failures log their name and origin without tokens, URLs or paths", async () => {
  for (const key of envKeys) delete process.env[key];
  const root = mkdtempSync(join(tmpdir(), "catalog-failure-origin-"));
  roots.push(root);
  // A missing launcher descriptor names its absolute path in the error message.
  process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR = join(root, "missing-launcher-browser.json");
  const descriptorServer = startServer({ ...defaultConfig("browser-only"), port: 0 }, { modelCatalogRetryDelayMs: 1 });
  const resetServer = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    modelCatalogRetryDelayMs: 1,
    fetchUpstream: async () => {
      throw Object.assign(
        new TypeError(`fetch to https://chatgpt.com/backend-api/codex/models failed under ${root}`),
        { code: "ECONNRESET" },
      );
    },
  });
  try {
    const { lines } = await captureConsole(async () => {
      for (const server of [descriptorServer, resetServer]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
          headers: { authorization: "Bearer private-session-token", "chatgpt-account-id": "acct-1" },
        });
        expect(response.status).toBe(502);
        await response.text();
      }
    });
    const descriptorHealth = await health(`http://127.0.0.1:${descriptorServer.port}`);
    expect(descriptorHealth.last_model_catalog_result.failure).toEqual({
      stage: "transport",
      code: "LauncherDescriptorUnavailable",
      name: "Error",
      origin: "descriptor",
    });
    const resetHealth = await health(`http://127.0.0.1:${resetServer.port}`);
    expect(resetHealth.last_model_catalog_result.failure).toEqual({
      stage: "transport",
      code: "ECONNRESET",
      name: "TypeError",
      origin: "upstream_fetch",
    });
    const failed = lines.warn.filter(line => line.includes("model_catalog_failed"));
    expect(failed).toHaveLength(2);
    expect(failed.join("\n")).toContain("\"origin\":\"descriptor\"");
    expect(failed.join("\n")).toContain("\"origin\":\"upstream_fetch\"");
    expectStructuralOnly(catalogLines(lines), ["private-session-token", root]);
  } finally {
    await descriptorServer.stop(true);
    await resetServer.stop(true);
  }
});

test("health reports how old the served fallback catalog is and returns to fresh after recovery", async () => {
  let outcome: "ok" | "reset" = "ok";
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    modelCatalogRetryDelayMs: 1,
    modelCatalogLastGood: new NativeModelCatalogLastGood(),
    fetchUpstream: async () => {
      if (outcome === "reset") throw Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" });
      return Response.json(nativeCatalog(), { headers: { "set-cookie": "__oailb=load-balancer; Path=/" } });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const models = () => fetch(`${base}/v1/models`, {
    headers: { authorization: "Bearer private-session-token", "chatgpt-account-id": "acct-1" },
  });
  try {
    const { lines } = await captureConsole(async () => {
      const fresh = await models();
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("set-cookie")).toBeNull();
      await fresh.text();
      expect((await health(base)).catalog_stale_age_sec).toBeNull();

      outcome = "reset";
      const stale = await models();
      expect(stale.status).toBe(200);
      expect(stale.headers.get(MODEL_CATALOG_STALE_HEADER)).toBe("stale");
      const body = await stale.json() as { models: Array<{ slug: string }> };
      expect(body.models.some(model => model.slug.startsWith("chatgpt-web/"))).toBe(true);
      const degraded = await health(base);
      expect(degraded.catalog_stale_age_sec).toBeGreaterThanOrEqual(0);
      expect(degraded.stale_model_catalog_responses).toBe(1);
      expect(degraded.successful_model_catalog_requests).toBe(2);
      expect(degraded.last_model_catalog_result).toMatchObject({
        status: 200,
        stale: true,
        failure: { stage: "transport", code: "ECONNRESET", name: "TypeError", origin: "upstream_fetch" },
      });

      outcome = "ok";
      await (await models()).text();
      const recovered = await health(base);
      expect(recovered.catalog_stale_age_sec).toBeNull();
      expect(recovered.last_model_catalog_result.failure).toBeUndefined();
    });
    expect(lines.warn.filter(line => line.includes("model_catalog_failed"))).toEqual([]);
    expect(lines.warn.filter(line => line.includes("model_catalog_served_stale"))).toHaveLength(1);
    expectStructuralOnly(catalogLines(lines), ["private-session-token"]);
  } finally {
    await server.stop(true);
  }
});
