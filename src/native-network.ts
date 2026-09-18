import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

function proxyError(message: string): Error {
  return Object.assign(new Error(message), { code: "NativeProxyConfigurationError" });
}

/**
 * Where a native request failed before the upstream answered: reading the launcher descriptor,
 * asking the launcher for the OS proxy route, the upstream fetch itself, or reading its body.
 * Logged as a structural field so a catalog failure can be told apart without its message, which
 * may carry a local path.
 */
export type NativeFailureOrigin = "descriptor" | "proxy_resolve" | "upstream_fetch" | "body";

const nativeFailureOrigins = new WeakMap<object, NativeFailureOrigin>();

export function tagNativeFailureOrigin<T>(error: T, origin: NativeFailureOrigin): T {
  if (error !== null && typeof error === "object" && !nativeFailureOrigins.has(error)) {
    nativeFailureOrigins.set(error, origin);
  }
  return error;
}

export function nativeFailureOrigin(error: unknown): NativeFailureOrigin | undefined {
  return error !== null && typeof error === "object" ? nativeFailureOrigins.get(error) : undefined;
}

function launcherStepError(
  error: unknown,
  code: "LauncherDescriptorUnavailable" | "LauncherProxyResolveFailed",
  origin: NativeFailureOrigin,
): Error {
  const existingCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const wrapped = typeof existingCode === "string" && existingCode === "NativeProxyConfigurationError"
    ? error as Error
    : Object.assign(
      new Error(error instanceof Error ? error.message : String(error), { cause: error }),
      { code },
    );
  return tagNativeFailureOrigin(wrapped, origin);
}

/** Use the first route selected by Chromium, without guessing another proxy protocol or retrying. */
export function nativeProxyFromPac(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
  const first = value.split(";")[0]!.trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS) ([^\s/;]+)$/.exec(first);
  if (!match) {
    throw proxyError("Native Codex requires an HTTP(S) system proxy; the selected proxy protocol is unsupported");
  }
  try {
    const proxy = new URL(`${match[1] === "HTTPS" ? "https" : "http"}://${match[2]}`);
    if (!proxy.hostname || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error();
    return proxy.href;
  } catch {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
}

async function upstreamFetch(request: Request, init?: { proxy: string }): Promise<Response> {
  try {
    return await fetch(request, init);
  } catch (error) {
    throw tagNativeFailureOrigin(error, "upstream_fetch");
  }
}

/** Native Codex keeps its own auth and Bun transport, but shares the launcher's OS proxy policy. */
export async function fetchNativeCodex(request: Request): Promise<Response> {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  // Standalone CLI and explicitly configured proxy environments retain Bun's existing semantics,
  // including NO_PROXY. No proxy variables or machine-wide settings are rewritten.
  if (!descriptorPath || ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
    .some(key => process.env[key]?.trim())) return upstreamFetch(request);

  let descriptor: ReturnType<typeof readLauncherBrowserHostDescriptor>;
  try {
    descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  } catch (error) {
    throw launcherStepError(error, "LauncherDescriptorUnavailable", "descriptor");
  }
  let proxy: string | undefined;
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/network/resolve-proxy`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: request.url }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
    });
    if (!response.ok) throw proxyError(`Launcher native proxy resolution failed (HTTP ${response.status})`);
    const result = await response.json() as { proxy?: unknown };
    proxy = nativeProxyFromPac(result.proxy);
  } catch (error) {
    // The caller's own abort stays an abort; only a launcher-side failure becomes a coded error.
    if (request.signal.aborted) throw tagNativeFailureOrigin(error, "proxy_resolve");
    throw launcherStepError(error, "LauncherProxyResolveFailed", "proxy_resolve");
  }
  return upstreamFetch(request, proxy ? { proxy } : undefined);
}
