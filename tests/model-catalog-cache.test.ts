import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type AppConfig } from "../src/config";
import {
  NATIVE_MODEL_CATALOG_MAX_AGE_MS,
  NativeModelCatalogLastGood,
  nativeModelCatalogCachePath,
  nativeModelCatalogKey,
} from "../src/model-catalog-cache";
import { MODEL_CATALOG_STALE_HEADER, modelsRequest, type ModelCatalogFailure, type ModelCatalogStaleServe } from "../src/server";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "catalog-last-good-"));
  roots.push(root);
  return root;
}

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

function paidConfig(): AppConfig {
  const config = defaultConfig("browser-only");
  config.solAvailable = true;
  config.extraHighAvailable = true;
  config.extraHighAvailable = true;
  return config;
}

function jwtFor(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      email: "person@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" },
    }),
    "signature-not-checked",
  ].join(".");
}

function catalogRequest(options: { account?: string; token?: string; signal?: AbortSignal } = {}): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token ?? "codex-oauth-access-token"}`,
    "user-agent": "codex_cli_rs/0.154.0 (Mac OS 26.0.0; arm64)",
  };
  if (options.account !== undefined) headers["chatgpt-account-id"] = options.account;
  return new Request("http://127.0.0.1:17841/v1/models?client_version=0.154.0", {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function connectionReset(): Error {
  return Object.assign(new TypeError("The socket connection was closed unexpectedly"), { code: "ECONNRESET" });
}

async function webSlugs(response: Response): Promise<string[]> {
  const body = await response.json() as { models: Array<{ slug: string }> };
  return body.models.map(model => model.slug).filter(slug => slug.startsWith("chatgpt-web/"));
}

test("a transport failure after a success serves the last-good catalog rebuilt with the current configuration", async () => {
  const home = tempHome();
  const lastGood = new NativeModelCatalogLastGood({ path: nativeModelCatalogCachePath(home) });
  const config = paidConfig();
  let outcome: "ok" | "reset" = "ok";
  let calls = 0;
  const upstream = async () => {
    calls += 1;
    if (outcome === "reset") throw connectionReset();
    return Response.json(nativeCatalog(), {
      headers: { etag: "W/\"upstream-etag\"", "set-cookie": "__oailb=load-balancer; Path=/" },
    });
  };
  const failures: ModelCatalogFailure[] = [];
  const stale: ModelCatalogStaleServe[] = [];
  const options = { lastGood, retryDelayMs: 1, onStale: (value: ModelCatalogStaleServe) => stale.push(value) };

  const fresh = await modelsRequest(catalogRequest({ account: "acct-1" }), config, upstream, undefined, value => failures.push(value), undefined, options);
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get("set-cookie")).toBeNull();
  expect(fresh.headers.get(MODEL_CATALOG_STALE_HEADER)).toBeNull();
  expect(await webSlugs(fresh)).toContain("chatgpt-web/extra-high");

  outcome = "reset";
  calls = 0;
  const served = await modelsRequest(catalogRequest({ account: "acct-1" }), config, upstream, undefined, value => failures.push(value), undefined, options);
  expect(served.status).toBe(200);
  expect(served.headers.get(MODEL_CATALOG_STALE_HEADER)).toBe("stale");
  expect(Number(served.headers.get("age"))).toBeGreaterThanOrEqual(0);
  expect(served.headers.get("set-cookie")).toBeNull();
  expect(served.headers.get("etag")).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
  const slugs = await webSlugs(served);
  expect(slugs).toContain("chatgpt-web/extra-high");
  // ChatGPT Web - Pro is retired: a saved catalog never brings its row back.
  expect(slugs).not.toContain("chatgpt-web/pro");
  // One retry, then the fallback: never a third upstream request inside Codex's refresh budget.
  expect(calls).toBe(2);
  expect(failures).toEqual([]);
  expect(stale).toHaveLength(1);
  expect(stale[0]!.failure).toEqual({ stage: "transport", code: "ECONNRESET", name: "TypeError", origin: "upstream_fetch" });

  // The rebuilt rows follow the configuration of the moment, not the one of the saved catalog.
  config.extraHighAvailable = false;
  const downgraded = await modelsRequest(catalogRequest({ account: "acct-1" }), config, upstream, undefined, undefined, undefined, options);
  expect(downgraded.headers.get(MODEL_CATALOG_STALE_HEADER)).toBe("stale");
  const downgradedSlugs = await webSlugs(downgraded);
  expect(downgradedSlugs).not.toContain("chatgpt-web/extra-high");
  expect(downgradedSlugs).not.toContain("chatgpt-web/pro");
});

test("without an earlier success a catalog failure is still reported as a 502", async () => {
  const failures: ModelCatalogFailure[] = [];
  const stale: ModelCatalogStaleServe[] = [];
  const response = await modelsRequest(
    catalogRequest({ account: "acct-1" }),
    paidConfig(),
    async () => { throw connectionReset(); },
    undefined,
    value => failures.push(value),
    undefined,
    { lastGood: new NativeModelCatalogLastGood(), retryDelayMs: 1, onStale: value => stale.push(value) },
  );
  expect(response.status).toBe(502);
  expect(failures).toEqual([{ stage: "transport", code: "ECONNRESET", name: "TypeError", origin: "upstream_fetch" }]);
  expect(stale).toEqual([]);
});

test.each([401, 403])("an upstream %i passes through untouched, unretried and never replaced by the last-good catalog", async status => {
  const lastGood = new NativeModelCatalogLastGood();
  const config = paidConfig();
  let calls = 0;
  let denied = false;
  const upstream = async () => {
    calls += 1;
    if (!denied) return Response.json(nativeCatalog());
    return new Response("{\"detail\":\"token_revoked\"}", {
      status,
      headers: { "content-type": "application/json", "set-cookie": "__oailb=load-balancer; Path=/" },
    });
  };
  expect((await modelsRequest(catalogRequest({ account: "acct-1" }), config, upstream, undefined, undefined, undefined, { lastGood, retryDelayMs: 1 })).status).toBe(200);
  denied = true;
  calls = 0;
  const failures: ModelCatalogFailure[] = [];
  const response = await modelsRequest(catalogRequest({ account: "acct-1" }), config, upstream, undefined, value => failures.push(value), undefined, { lastGood, retryDelayMs: 1 });
  expect(response.status).toBe(status);
  expect(await response.text()).toBe("{\"detail\":\"token_revoked\"}");
  expect(response.headers.get(MODEL_CATALOG_STALE_HEADER)).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(calls).toBe(1);
  expect(failures).toEqual([{ stage: "upstream", status }]);
});

test("the single retry recovers a transient failure but never retries a 429", async () => {
  const config = paidConfig();
  const recovered: ModelCatalogFailure[] = [];
  let calls = 0;
  const sequence = async (statuses: number[]) => {
    calls = 0;
    return await modelsRequest(catalogRequest({ account: "acct-1" }), config, async () => {
      const status = statuses[Math.min(calls, statuses.length - 1)]!;
      calls += 1;
      return status === 200 ? Response.json(nativeCatalog()) : new Response("busy", { status });
    }, undefined, undefined, undefined, { retryDelayMs: 1, onRecovered: value => recovered.push(value) });
  };

  const afterServerError = await sequence([503, 200]);
  expect(afterServerError.status).toBe(200);
  expect(afterServerError.headers.get(MODEL_CATALOG_STALE_HEADER)).toBeNull();
  expect(calls).toBe(2);
  expect(recovered).toEqual([{ stage: "upstream", status: 503 }]);

  const throttled = await sequence([429, 200]);
  expect(throttled.status).toBe(429);
  expect(calls).toBe(1);

  const unavailable = await sequence([502, 502, 200]);
  expect(unavailable.status).toBe(502);
  expect(calls).toBe(2);
});

test("a 429 after a success serves the last-good catalog without retrying", async () => {
  const lastGood = new NativeModelCatalogLastGood();
  const config = paidConfig();
  let throttled = false;
  let calls = 0;
  const upstream = async () => {
    calls += 1;
    return throttled ? new Response("slow down", { status: 429 }) : Response.json(nativeCatalog());
  };
  await modelsRequest(catalogRequest({ account: "acct-1" }), config, upstream, undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  throttled = true;
  calls = 0;
  const response = await modelsRequest(catalogRequest({ account: "acct-1" }), config, upstream, undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  expect(response.status).toBe(200);
  expect(response.headers.get(MODEL_CATALOG_STALE_HEADER)).toBe("stale");
  expect(calls).toBe(1);
});

test("a client that leaves mid-request is answered as client_aborted, never retried and never served stale", async () => {
  const lastGood = new NativeModelCatalogLastGood();
  const config = paidConfig();
  await modelsRequest(catalogRequest({ account: "acct-1" }), config, async () => Response.json(nativeCatalog()), undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  const client = new AbortController();
  let calls = 0;
  const failures: ModelCatalogFailure[] = [];
  const stale: ModelCatalogStaleServe[] = [];
  const response = await modelsRequest(
    catalogRequest({ account: "acct-1", signal: client.signal }),
    config,
    request => {
      calls += 1;
      setTimeout(() => client.abort(), 5);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      });
    },
    undefined,
    value => failures.push(value),
    undefined,
    { lastGood, retryDelayMs: 1, onStale: value => stale.push(value) },
  );
  expect(response.status).toBe(499);
  expect(calls).toBe(1);
  expect(failures).toEqual([{ stage: "client_aborted" }]);
  expect(stale).toEqual([]);
});

test("a catalog that arrived after its client left is still kept as the last-good one", async () => {
  const lastGood = new NativeModelCatalogLastGood();
  const config = paidConfig();
  const client = new AbortController();
  const abandoned = await modelsRequest(catalogRequest({ account: "acct-1", signal: client.signal }), config, async () => {
    client.abort();
    return Response.json(nativeCatalog());
  }, undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  expect(abandoned.status).toBe(499);
  const served = await modelsRequest(catalogRequest({ account: "acct-1" }), config, async () => {
    throw connectionReset();
  }, undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  expect(served.status).toBe(200);
  expect(served.headers.get(MODEL_CATALOG_STALE_HEADER)).toBe("stale");
});

test("a failure that already spent two seconds of Codex's refresh budget is not retried", async () => {
  let calls = 0;
  const response = await modelsRequest(catalogRequest({ account: "acct-1" }), paidConfig(), async () => {
    calls += 1;
    await Bun.sleep(2_050);
    throw connectionReset();
  }, undefined, undefined, undefined, { retryDelayMs: 1 });
  expect(response.status).toBe(502);
  expect(calls).toBe(1);
}, 15_000);

test("the last-good file is private, keyed by a hash of the account, and never holds the token", async () => {
  const home = tempHome();
  const path = nativeModelCatalogCachePath(home);
  const token = jwtFor("account-from-token-claim");
  const config = paidConfig();
  const ok = async () => Response.json(nativeCatalog(), { headers: { etag: "W/\"upstream-etag\"" } });
  const fresh = await modelsRequest(
    catalogRequest({ token }),
    config,
    ok,
    undefined,
    undefined,
    undefined,
    { lastGood: new NativeModelCatalogLastGood({ path }), retryDelayMs: 1 },
  );
  expect(fresh.status).toBe(200);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const stored = readFileSync(path, "utf8");
  for (const secret of ["Bearer", token, "signature-not-checked", "access_token", "person@example.com", "account-from-token-claim"]) {
    expect(stored).not.toContain(secret);
  }
  expect(stored).toContain(createHash("sha256").update("account-from-token-claim").digest("hex"));
  expect(stored).toContain("upstream-etag");

  // A restarted bridge reads the same file; the fallback needs no fresh success first.
  const reloaded = new NativeModelCatalogLastGood({ path });
  const failing = async () => { throw connectionReset(); };
  const sameAccount = await modelsRequest(catalogRequest({ token }), config, failing, undefined, undefined, undefined, { lastGood: reloaded, retryDelayMs: 1 });
  expect(sameAccount.status).toBe(200);
  expect(sameAccount.headers.get(MODEL_CATALOG_STALE_HEADER)).toBe("stale");

  const otherAccount = await modelsRequest(catalogRequest({ token: jwtFor("another-account") }), config, failing, undefined, undefined, undefined, { lastGood: reloaded, retryDelayMs: 1 });
  expect(otherAccount.status).toBe(502);
  const otherVersion = new Request("http://127.0.0.1:17841/v1/models?client_version=0.155.0", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect((await modelsRequest(otherVersion, config, failing, undefined, undefined, undefined, { lastGood: reloaded, retryDelayMs: 1 })).status).toBe(502);
});

test("a request without any account identity is never cached or served from the fallback", async () => {
  const lastGood = new NativeModelCatalogLastGood();
  const config = paidConfig();
  expect(nativeModelCatalogKey(catalogRequest().headers, "0.154.0")).toBeUndefined();
  await modelsRequest(catalogRequest(), config, async () => Response.json(nativeCatalog()), undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  const response = await modelsRequest(catalogRequest(), config, async () => { throw connectionReset(); }, undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  expect(response.status).toBe(502);
});

test("a last-good catalog older than 24 hours is not served", async () => {
  let now = Date.parse("2026-09-18T10:00:00.000Z");
  const lastGood = new NativeModelCatalogLastGood({ now: () => now });
  const config = paidConfig();
  await modelsRequest(catalogRequest({ account: "acct-1" }), config, async () => Response.json(nativeCatalog()), undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  const failing = async () => { throw connectionReset(); };
  now += NATIVE_MODEL_CATALOG_MAX_AGE_MS;
  const atLimit = await modelsRequest(catalogRequest({ account: "acct-1" }), config, failing, undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  expect(atLimit.status).toBe(200);
  expect(atLimit.headers.get("age")).toBe(String(NATIVE_MODEL_CATALOG_MAX_AGE_MS / 1_000));
  now += 1_000;
  const expired = await modelsRequest(catalogRequest({ account: "acct-1" }), config, failing, undefined, undefined, undefined, { lastGood, retryDelayMs: 1 });
  expect(expired.status).toBe(502);
});

test("a damaged last-good file is ignored and replaced by the next success", async () => {
  const home = tempHome();
  const path = nativeModelCatalogCachePath(home);
  const key = nativeModelCatalogKey(new Headers({ "chatgpt-account-id": "acct-1" }), "0.154.0")!;
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(path, "{not json", { mode: 0o600 });
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...values: unknown[]) => { warnings.push(values.join(" ")); };
  try {
    const damaged = new NativeModelCatalogLastGood({ path });
    expect(damaged.lookup(key)).toBeUndefined();
    damaged.remember(key, nativeCatalog(), "W/\"etag\"");
    expect(new NativeModelCatalogLastGood({ path }).lookup(key)?.catalog).toEqual(nativeCatalog());
  } finally {
    console.warn = originalWarn;
  }
  expect(warnings.join("\n")).toContain("native_model_catalog_cache_unreadable");
  expect(warnings.join("\n")).not.toContain(home);
});
