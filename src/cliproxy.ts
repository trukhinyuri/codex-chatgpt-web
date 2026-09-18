/**
 * CLIProxyAPI models inside the same Codex provider.
 *
 * Codex keeps its built-in OpenAI provider pointed at this bridge, so its ChatGPT sign-in and every
 * feature gated on that provider keep working. Models the local CLIProxyAPI serves (Claude, Gemini,
 * GLM and others) join the catalog here, and their turns are forwarded to the proxy with the
 * proxy's own API key. The ChatGPT credentials Codex sends never leave for the proxy, and the proxy
 * must listen on this machine.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "./config";
import {
  BRIDGE_COMPACTION_PREFIX,
  COMPACT_PROMPT,
  OPAQUE_COMPACTION_NOTE,
  SUMMARY_PREFIX,
  buildCompactV1Output,
  decodeCompactionSummary,
  encodeCompactionSummary,
  extractCompactUserMessages,
} from "./responses/compaction";
import { BRIDGE_REASONING_PREFIX } from "./responses/reasoning-envelope";
import { CHATGPT_WEB_MODEL_PREFIX } from "./chatgpt-web-models";

type JsonObject = Record<string, unknown>;
export type CliProxyFetch = (request: Request) => Promise<Response>;

export const CLIPROXY_CONNECTION_FILE = "cliproxy.json";
export const CLIPROXY_ROUTES_FILE = join("runtime", "model-routes.json");
const CATALOG_TTL_MS = 60_000;
const CONNECT_RETRY_BUDGET_MS = 20_000;
const MAX_KEY_LENGTH = 512;
// Headers that carry the user's ChatGPT or OpenAI identity; none of them may reach the proxy.
const IDENTITY_HEADERS = [
  "authorization",
  "cookie",
  "chatgpt-account-id",
  "openai-organization",
  "openai-project",
  "x-openai-client-user-agent",
];
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length",
]);

export interface CliProxyConnection {
  baseUrl: string;
  apiKey: string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only a proxy on this machine: the bridge never sends a turn, or the proxy key, anywhere else. */
export function loopbackBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * `<home>/cliproxy.json`: `{ "version": 1, "enabled": true, "baseUrl": "http://127.0.0.1:8317",
 * "apiKeyFile": "/absolute/path" }`. The key file holds only the proxy's client API key.
 */
export function readCliProxyConnection(home = getConfigDir()): CliProxyConnection | null {
  const file = join(home, CLIPROXY_CONNECTION_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!isObject(parsed) || parsed.version !== 1) throw new Error(`${file} must be a version 1 object`);
  if (parsed.enabled === false) return null;
  const baseUrl = loopbackBaseUrl(parsed.baseUrl);
  if (!baseUrl) throw new Error(`${file} must name a CLIProxyAPI address on this machine`);
  if (typeof parsed.apiKeyFile !== "string" || !isAbsolute(parsed.apiKeyFile)) {
    throw new Error(`${file} must name an absolute apiKeyFile`);
  }
  const apiKey = readFileSync(parsed.apiKeyFile, "utf8").trim();
  if (!apiKey || apiKey.length > MAX_KEY_LENGTH || /\s/.test(apiKey)) {
    throw new Error("The CLIProxyAPI key file must contain exactly one API key");
  }
  return { baseUrl, apiKey };
}

/** Which slugs belong to which backend, as of the last catalog Codex fetched. Survives restarts. */
export interface ModelRoutes {
  native: string[];
  proxy: string[];
}

// Keyed by home so a test harness or a DEV profile never shares routes with the production bridge.
let routes: { home: string; native: Set<string>; proxy: Set<string> } | null = null;
let proxyCatalog: { models: JsonObject[]; fetchedAt: number; baseUrl: string } | null = null;

export function resetCliProxyStateForTests(): void {
  routes = null;
  proxyCatalog = null;
}

function routesFile(home: string): string {
  return join(home, CLIPROXY_ROUTES_FILE);
}

function loadRoutes(home: string): { native: Set<string>; proxy: Set<string> } {
  if (routes?.home === home) return routes;
  try {
    const parsed = JSON.parse(readFileSync(routesFile(home), "utf8")) as Partial<ModelRoutes>;
    routes = {
      home,
      native: new Set(Array.isArray(parsed.native) ? parsed.native.filter(slug => typeof slug === "string") : []),
      proxy: new Set(Array.isArray(parsed.proxy) ? parsed.proxy.filter(slug => typeof slug === "string") : []),
    };
  } catch {
    routes = { home, native: new Set(), proxy: new Set() };
  }
  return routes;
}

function saveRoutes(home: string, next: ModelRoutes): void {
  routes = { home, native: new Set(next.native), proxy: new Set(next.proxy) };
  try {
    const file = routesFile(home);
    if (!existsSync(dirname(file))) return;
    atomicWriteFile(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  } catch {
    // The in-memory routes still serve this process; the file only speeds up the next start.
  }
}

function proxyHeaders(source: Headers, connection: CliProxyConnection): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  for (const name of IDENTITY_HEADERS) headers.delete(name);
  headers.set("authorization", `Bearer ${connection.apiKey}`);
  return headers;
}

function connectionRefused(error: unknown): boolean {
  const code = isObject(error) ? (error as { code?: unknown }).code : undefined;
  const text = error instanceof Error ? error.message : String(error);
  return code === "ECONNREFUSED" || code === "ConnectionRefused" || /ECONNREFUSED|Unable to connect|ConnectionRefused/i.test(text);
}

/**
 * The launcher restarts CLIProxyAPI to update it; for that second the port refuses connections.
 * Retry only that, only before any response arrived, so an update never surfaces as a failed turn.
 */
export async function fetchWithRestartTolerance(
  make: () => Request,
  fetchImpl: CliProxyFetch,
  signal?: AbortSignal,
  budgetMs = CONNECT_RETRY_BUDGET_MS,
): Promise<Response> {
  const deadline = Date.now() + budgetMs;
  let delay = 250;
  for (;;) {
    try {
      return await fetchImpl(make());
    } catch (error) {
      if (!connectionRefused(error) || signal?.aborted || Date.now() + delay > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2_000);
    }
  }
}

async function fetchProxyCatalog(
  connection: CliProxyConnection,
  incoming: Request,
  fetchImpl: CliProxyFetch,
): Promise<JsonObject[]> {
  if (proxyCatalog
    && proxyCatalog.baseUrl === connection.baseUrl
    && Date.now() - proxyCatalog.fetchedAt < CATALOG_TTL_MS) {
    return proxyCatalog.models;
  }
  const incomingUrl = new URL(incoming.url);
  // CLIProxyAPI answers in Codex's own catalog schema when the request carries client_version.
  const clientVersion = incomingUrl.searchParams.get("client_version") ?? "0.0.0";
  const url = `${connection.baseUrl}/v1/models?client_version=${encodeURIComponent(clientVersion)}`;
  try {
    const response = await fetchWithRestartTolerance(
      () => new Request(url, { method: "GET", headers: proxyHeaders(incoming.headers, connection) }),
      fetchImpl,
      incoming.signal,
      5_000,
    );
    if (!response.ok) throw new Error(`CLIProxyAPI model list returned HTTP ${response.status}`);
    const payload = await response.json() as { models?: unknown };
    const models = (Array.isArray(payload.models) ? payload.models : [])
      .filter((model): model is JsonObject => isObject(model) && typeof model.slug === "string" && model.slug.length > 0);
    proxyCatalog = { models, fetchedAt: Date.now(), baseUrl: connection.baseUrl };
    return models;
  } catch (error) {
    // Keep serving the last list while the proxy restarts, so its models do not flicker out.
    if (proxyCatalog?.baseUrl === connection.baseUrl) return proxyCatalog.models;
    throw error;
  }
}

/**
 * Add the proxy's models after the native and ChatGPT Web rows. A slug the native catalog already
 * has stays native: the user's own Codex sign-in serves it.
 */
export function mergeCliProxyModels(catalog: JsonObject, proxyModels: JsonObject[]): { catalog: JsonObject; added: string[] } {
  const models = Array.isArray(catalog.models) ? catalog.models.filter(isObject) : [];
  const present = new Set(models.map(model => model.slug).filter((slug): slug is string => typeof slug === "string"));
  const basePriority = models.reduce((max, model) => (
    typeof model.priority === "number" && Number.isSafeInteger(model.priority) ? Math.max(max, model.priority) : max
  ), 0);
  const added: string[] = [];
  const extra: JsonObject[] = [];
  for (const [index, source] of proxyModels.entries()) {
    const slug = source.slug as string;
    if (present.has(slug) || slug.startsWith(CHATGPT_WEB_MODEL_PREFIX)) continue;
    present.add(slug);
    added.push(slug);
    extra.push({
      ...structuredClone(source),
      // Served by this Responses-compatible bridge; false would drop it from spawn_agent.
      supported_in_api: true,
      priority: basePriority + 1 + index,
    });
  }
  return { catalog: { ...catalog, models: [...models, ...extra] }, added };
}

/** Merge the proxy's models into a catalog Codex is about to receive. Never fails the catalog. */
export async function augmentCatalogWithCliProxy(
  catalog: JsonObject,
  incoming: Request,
  options: { home: string; fetchImpl?: CliProxyFetch; connection?: CliProxyConnection | null },
): Promise<JsonObject> {
  const home = options.home;
  const nativeSlugs = (Array.isArray(catalog.models) ? catalog.models : [])
    .filter(isObject)
    .map(model => model.slug)
    .filter((slug): slug is string => typeof slug === "string" && !slug.startsWith(CHATGPT_WEB_MODEL_PREFIX));
  let connection: CliProxyConnection | null;
  try {
    connection = options.connection === undefined ? readCliProxyConnection(home) : options.connection;
  } catch (error) {
    console.warn(`[codex-chatgpt-web] cliproxy_config_invalid ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}`);
    connection = null;
  }
  if (!connection) {
    saveRoutes(home, { native: nativeSlugs, proxy: [] });
    return catalog;
  }
  try {
    const merged = mergeCliProxyModels(catalog, await fetchProxyCatalog(connection, incoming, options.fetchImpl ?? fetch));
    saveRoutes(home, { native: nativeSlugs, proxy: merged.added });
    return merged.catalog;
  } catch (error) {
    console.warn(`[codex-chatgpt-web] cliproxy_catalog_failed ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}`);
    saveRoutes(home, { native: nativeSlugs, proxy: [...loadRoutes(home).proxy].filter(slug => !nativeSlugs.includes(slug)) });
    return catalog;
  }
}

/** The proxy connection that serves this model, or null when the model is native or unknown. */
export function cliProxyRouteFor(model: string, home: string): CliProxyConnection | null {
  if (model.startsWith(CHATGPT_WEB_MODEL_PREFIX)) return null;
  if (!loadRoutes(home).proxy.has(model)) return null;
  return readCliProxyConnection(home);
}

function summaryMessage(text: string): JsonObject {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

/**
 * History that crossed providers: the bridge's own compaction checkpoints become readable summaries,
 * OpenAI-encrypted checkpoints a short note, and the bridge's reasoning envelopes lose their opaque
 * payload. CLIProxyAPI itself drops reasoning signatures that belong to another provider.
 */
export function scrubHistoryForCliProxy(body: JsonObject): JsonObject {
  if (!Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.flatMap((item) => {
    if (!isObject(item)) return [item];
    if (item.type === "compaction") {
      changed = true;
      const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
      const summary = encrypted.startsWith(BRIDGE_COMPACTION_PREFIX) ? decodeCompactionSummary(encrypted) : null;
      return [summaryMessage(summary ? `${SUMMARY_PREFIX}\n\n${summary}` : OPAQUE_COMPACTION_NOTE)];
    }
    if (item.type === "reasoning"
      && typeof item.encrypted_content === "string"
      && item.encrypted_content.startsWith(BRIDGE_REASONING_PREFIX)) {
      changed = true;
      const clean = { ...item };
      delete clean.encrypted_content;
      return [clean];
    }
    return [item];
  });
  if (!changed) return body;
  const clean: JsonObject = { ...body, input };
  delete clean.previous_response_id;
  return clean;
}

/** Forward one Responses turn to CLIProxyAPI and stream its answer back unchanged. */
export async function forwardCliProxyResponses(
  request: Request,
  body: JsonObject,
  connection: CliProxyConnection,
  fetchImpl: CliProxyFetch = fetch,
): Promise<Response> {
  const payload = JSON.stringify(scrubHistoryForCliProxy(body));
  const headers = proxyHeaders(request.headers, connection);
  headers.set("content-type", "application/json");
  headers.delete("content-encoding");
  const upstream = await fetchWithRestartTolerance(
    () => new Request(`${connection.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: payload,
      signal: request.signal,
    }),
    fetchImpl,
    request.signal,
  );
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders.append(name, value);
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return Response.json({
      error: {
        type: "authentication_error",
        code: "cliproxy_unauthorized",
        message: `CLIProxyAPI rejected the bridge's API key (HTTP ${upstream.status}). Check the key file named in ${CLIPROXY_CONNECTION_FILE}.`,
      },
    }, { status: 502 });
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

function outputText(response: unknown): string {
  if (!isObject(response) || !Array.isArray(response.output)) return "";
  return response.output
    .filter(isObject)
    .filter(item => item.type === "message")
    .flatMap(item => Array.isArray(item.content) ? item.content.filter(isObject) : [])
    .filter(part => part.type === "output_text" && typeof part.text === "string")
    .map(part => part.text as string)
    .join("")
    .trim();
}

/** Read the final response object from a Responses SSE body. */
export function completedResponseFromSse(text: string): JsonObject | null {
  let completed: JsonObject | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as JsonObject;
      if ((event.type === "response.completed" || event.type === "response.incomplete") && isObject(event.response)) {
        completed = event.response;
      }
      if (event.type === "response.failed" || event.type === "error") {
        const failure = isObject(event.response) && isObject(event.response.error) ? event.response.error : event.error;
        throw new Error(isObject(failure) && typeof failure.message === "string" ? failure.message : "the model failed");
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return completed;
}

/**
 * Codex asks the provider to compact; CLIProxyAPI's non-OpenAI upstreams cannot. Ask the model for
 * the summary Codex's own local compaction would request, then return the same replacement history.
 */
export async function summarizeViaCliProxy(
  request: Request,
  body: JsonObject,
  connection: CliProxyConnection,
  fetchImpl: CliProxyFetch = fetch,
): Promise<string> {
  const input = Array.isArray(body.input) ? body.input.filter(item => !(isObject(item) && item.type === "compaction_trigger")) : [];
  const summaryRequest: JsonObject = {
    model: body.model,
    ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
    ...(body.tools !== undefined ? { tools: body.tools } : {}),
    ...(body.reasoning !== undefined ? { reasoning: body.reasoning } : {}),
    ...(body.prompt_cache_key !== undefined ? { prompt_cache_key: body.prompt_cache_key } : {}),
    input: [...input, summaryMessage(COMPACT_PROMPT)],
    parallel_tool_calls: false,
    store: false,
    stream: true,
  };
  const response = await forwardCliProxyResponses(request, summaryRequest, connection, fetchImpl);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`CLIProxyAPI could not summarize the conversation (HTTP ${response.status})`);
  }
  const summary = outputText(completedResponseFromSse(text));
  if (!summary) throw new Error("CLIProxyAPI returned an empty conversation summary");
  return summary;
}

/** `/v1/responses/compact` for a proxy model. */
export async function compactViaCliProxy(
  request: Request,
  body: JsonObject,
  connection: CliProxyConnection,
  fetchImpl: CliProxyFetch = fetch,
): Promise<Response> {
  const summary = await summarizeViaCliProxy(request, body, connection, fetchImpl);
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(body.input), summary) });
}

/** Remote compaction v2: a streamed turn whose only output item is the compaction checkpoint. */
export async function compactionTurnViaCliProxy(
  request: Request,
  body: JsonObject,
  connection: CliProxyConnection,
  fetchImpl: CliProxyFetch = fetch,
): Promise<Response> {
  const summary = await summarizeViaCliProxy(request, body, connection, fetchImpl);
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const item = { type: "compaction", id: `cmp_${crypto.randomUUID().replaceAll("-", "")}`, encrypted_content: encodeCompactionSummary(summary) };
  const response = { id, object: "response", status: "completed", model: body.model, output: [item] };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
