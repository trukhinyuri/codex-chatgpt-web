import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRef, cliproxyCommand } from "../src/cliproxy-command";
import { readCliProxyConnection } from "../src/cliproxy";

const KEY = "sk-secret-proxy-key";
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cwg-cliproxy-cmd-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function proxy(status = 200) {
  const seen: Request[] = [];
  const fetchImpl = async (request: Request) => {
    seen.push(request);
    if (new URL(request.url).pathname === "/healthz") return Response.json({ status: "ok" });
    if (status !== 200) return new Response("no", { status });
    return Response.json({ models: [{ slug: "claude-fable-5-1" }, { slug: "glm-5.3" }] });
  };
  return { seen, fetchImpl };
}

async function run(args: string[], options: Partial<Parameters<typeof cliproxyCommand>[1]> = {}) {
  let output = "";
  await cliproxyCommand(args, { home, readKey: async () => `${KEY}\n`, write: text => { output += text; }, ...options });
  return output;
}

test("connect checks the proxy with the key from stdin, stores it privately and never prints it", async () => {
  const { seen, fetchImpl } = proxy();
  const output = await run(["connect", "--api-key-stdin"], { fetchImpl });
  expect(JSON.parse(output)).toMatchObject({ connected: true, baseUrl: "http://127.0.0.1:8317", proxyModels: 2 });
  expect(output).not.toContain(KEY);
  expect(seen.map(request => new URL(request.url).pathname)).toEqual(["/healthz", "/v1/models"]);
  expect(seen[1]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(readCliProxyConnection(home)).toEqual({ baseUrl: "http://127.0.0.1:8317", apiKey: KEY });
  if (process.platform !== "win32") expect(statSync(join(home, "secrets", "cliproxy-api-key")).mode & 0o777).toBe(0o600);
  if (process.platform !== "win32") expect(statSync(join(home, "cliproxy.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(home, "cliproxy.json"), "utf8")).not.toContain(KEY);
});

test("connect refuses a rejected key, a remote address and a key on the command line", async () => {
  await expect(run(["connect", "--api-key-stdin"], { fetchImpl: proxy(401).fetchImpl })).rejects.toThrow(/rejected the API key/);
  expect(existsSync(join(home, "cliproxy.json"))).toBe(false);
  expect(existsSync(join(home, "secrets", "cliproxy-api-key"))).toBe(false);
  await expect(run(["connect", "--base-url", "https://proxy.example.com", "--api-key-stdin"], { fetchImpl: proxy().fetchImpl })).rejects.toThrow(/on this machine/);
  await expect(run(["connect", KEY], { fetchImpl: proxy().fetchImpl })).rejects.toThrow(/standard input/);
});

test("status and disconnect", async () => {
  expect(JSON.parse(await run(["status"], { fetchImpl: proxy().fetchImpl }))).toMatchObject({ configured: false, enabled: false });
  await run(["connect", "--api-key-stdin"], { fetchImpl: proxy().fetchImpl });
  expect(JSON.parse(await run(["status"], { fetchImpl: proxy().fetchImpl }))).toMatchObject({ enabled: true, reachable: true, proxyModels: 2 });
  expect(JSON.parse(await run(["disconnect"]))).toMatchObject({ connected: false });
  expect(readCliProxyConnection(home)).toBeNull();
});

function managedProxy(handlers: Record<string, (request: Request) => Response>) {
  const seen: Request[] = [];
  const fetchImpl = async (request: Request) => {
    seen.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ status: "ok" });
    if (url.pathname === "/v1/models") return Response.json({ models: [{ slug: "claude-fable-5-1" }] });
    const route = `${request.method} ${url.pathname.replace("/v0/management/", "")}`;
    const handler = handlers[route];
    return handler ? handler(request) : new Response("not found", { status: 404 });
  };
  return { seen, fetchImpl };
}

const MGMT = "mgmt-secret-key";
const FILES = { files: [
  { name: "claude-alice@example.com.json", provider: "claude", label: "alice@example.com", status: "active", cooldowns: [] },
  { name: "codex-bob.json", type: "codex", email: "bob@example.org", disabled: true, cooldowns: [{ model: "gpt-6" }] },
] };

test("the management key is checked, stored privately, and accounts are listed with masked e-mails", async () => {
  const proxy = managedProxy({ "GET auth-files": () => Response.json(FILES) });
  await run(["connect", "--api-key-stdin"], { fetchImpl: proxy.fetchImpl });
  const stored = await run(["management-key", "--stdin"], { fetchImpl: proxy.fetchImpl, readKey: async () => MGMT });
  expect(JSON.parse(stored)).toEqual({ management: true, accounts: 2 });
  expect(stored).not.toContain(MGMT);
  if (process.platform !== "win32") expect(statSync(join(home, "secrets", "cliproxy-management-key")).mode & 0o777).toBe(0o600);
  expect(proxy.seen.at(-1)!.headers.get("authorization")).toBe(`Bearer ${MGMT}`);

  const listed = JSON.parse(await run(["accounts"], { fetchImpl: proxy.fetchImpl })) as { accounts: Array<Record<string, unknown>> };
  expect(listed.accounts).toEqual([
    { ref: accountRef("claude-alice@example.com.json"), name: "cl***@example.com.json", provider: "claude", label: "al***@example.com", disabled: false, status: "active", coolingDown: false },
    { ref: accountRef("codex-bob.json"), name: "codex-bob.json", provider: "codex", label: "bo***@example.org", disabled: true, status: "active", coolingDown: true },
  ]);
  expect(JSON.stringify(listed)).not.toContain("alice@");
  const shown = JSON.parse(await run(["accounts", "--show-emails"], { fetchImpl: proxy.fetchImpl })) as { accounts: Array<{ label: string; name: string }> };
  expect(shown.accounts[0]!.label).toBe("alice@example.com");
  expect(shown.accounts[0]!.name).toBe("claude-alice@example.com.json");
});

test("a rejected management key is not kept", async () => {
  const proxy = managedProxy({ "GET auth-files": () => new Response("no", { status: 401 }) });
  await run(["connect", "--api-key-stdin"], { fetchImpl: proxy.fetchImpl });
  await expect(run(["management-key", "--stdin"], { fetchImpl: proxy.fetchImpl, readKey: async () => MGMT })).rejects.toThrow(/rejected the management key/);
  expect(JSON.parse(readFileSync(join(home, "cliproxy.json"), "utf8")).managementKeyFile).toBeUndefined();
  await expect(run(["accounts"], { fetchImpl: proxy.fetchImpl })).rejects.toThrow(/No CLIProxyAPI management key/);
});

test("login opens the provider page and waits for the proxy to finish the sign-in", async () => {
  let polls = 0;
  const proxy = managedProxy({
    "GET auth-files": () => Response.json(FILES),
    "GET anthropic-auth-url": request => {
      expect(new URL(request.url).searchParams.get("is_webui")).toBe("true");
      return Response.json({ status: "ok", url: "https://claude.ai/oauth/authorize?x=1", state: "st-1" });
    },
    "GET get-auth-status": request => {
      expect(new URL(request.url).searchParams.get("state")).toBe("st-1");
      polls += 1;
      return Response.json({ status: polls < 3 ? "wait" : "ok" });
    },
  });
  await run(["connect", "--api-key-stdin"], { fetchImpl: proxy.fetchImpl });
  await run(["management-key", "--stdin"], { fetchImpl: proxy.fetchImpl, readKey: async () => MGMT });
  const opened: string[] = [];
  const output = await run(["login", "claude"], { fetchImpl: proxy.fetchImpl, open: url => opened.push(url), sleep: async () => {} });
  const lines = output.trim().split("\n").map(line => JSON.parse(line));
  expect(lines[0]).toEqual({ provider: "claude", url: "https://claude.ai/oauth/authorize?x=1", waiting: true });
  expect(lines[1]).toEqual({ provider: "claude", signedIn: true });
  expect(opened).toEqual(["https://claude.ai/oauth/authorize?x=1"]);
  expect(polls).toBe(3);
  await expect(run(["login", "gemini"], { fetchImpl: proxy.fetchImpl })).rejects.toThrow(/needs one of/);
});

test("a failed sign-in and removal are reported", async () => {
  const proxy = managedProxy({
    "GET auth-files": () => Response.json(FILES),
    "GET codex-auth-url": () => Response.json({ status: "ok", url: "https://auth.openai.com/x", state: "st-2" }),
    "GET get-auth-status": () => Response.json({ status: "error", error: "access_denied" }),
    "DELETE auth-files": request => {
      expect(new URL(request.url).searchParams.get("name")).toBe("codex-bob.json");
      return Response.json({ status: "ok" });
    },
  });
  await run(["connect", "--api-key-stdin"], { fetchImpl: proxy.fetchImpl });
  await run(["management-key", "--stdin"], { fetchImpl: proxy.fetchImpl, readKey: async () => MGMT });
  await expect(run(["login", "codex", "--no-open"], { fetchImpl: proxy.fetchImpl, sleep: async () => {} })).rejects.toThrow(/codex sign-in failed: access_denied/);
  expect(JSON.parse(await run(["remove", accountRef("codex-bob.json")], { fetchImpl: proxy.fetchImpl }))).toEqual({ removed: accountRef("codex-bob.json") });
  expect(JSON.parse(await run(["remove", "codex-bob.json"], { fetchImpl: proxy.fetchImpl }))).toEqual({ removed: accountRef("codex-bob.json") });
  await expect(run(["remove", "nope"], { fetchImpl: proxy.fetchImpl })).rejects.toThrow(/No such CLIProxyAPI account/);
});
