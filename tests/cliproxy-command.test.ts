import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliproxyCommand } from "../src/cliproxy-command";
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
  expect(statSync(join(home, "secrets", "cliproxy-api-key")).mode & 0o777).toBe(0o600);
  expect(statSync(join(home, "cliproxy.json")).mode & 0o777).toBe(0o600);
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
