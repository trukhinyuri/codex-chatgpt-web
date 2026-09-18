import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { failedActionAfterCleanup } from "../src/adapters/chatgpt-web/mcp-server";
import { defaultBrokerEndpoint, isWindowsPipeEndpoint } from "../src/config";

const testTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const root = mkdtempSync(join(testTempRoot, "cgw-mcp-claim-cleanup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CLAIM_INVALID = "turn token is invalid, expired, or revoked";
const CLEANUP_MASK = "Codex Native claim failed and its broker activity could not be retired";

function mcpErrorText(response: unknown): string {
  return JSON.stringify(response);
}

async function withMcpClient<T>(
  socketPath: string,
  action: (call: (name: string, args: Record<string, unknown>) => ReturnType<Client["callTool"]>) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-mcp-claim-cleanup-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await action((name, args) => client.callTool({ name, arguments: args }));
  } finally {
    await client.close().catch(() => {});
  }
}

/** A broker fixture that answers every request with a scripted, always-erroring reply. */
function scriptedBroker(
  name: string,
  reply: (request: { method: string }) => { error?: string; result?: unknown },
) {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  const socketPath = defaultBrokerEndpoint(home);
  if (!isWindowsPipeEndpoint(socketPath)) mkdirSync(dirname(socketPath), { recursive: true });
  const methods: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffered += String(chunk);
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffered.slice(0, newline)) as { id: string; method: string };
      methods.push(request.method);
      socket.end(`${JSON.stringify({ id: request.id, ...reply(request) })}\n`);
    });
  });
  return {
    socketPath,
    methods,
    listen: () => new Promise<void>(ready => server.listen(socketPath, ready)),
    close: async () => {
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}

test("failedActionAfterCleanup keeps the original action's message as the visible AggregateError message", () => {
  const thrown = failedActionAfterCleanup(
    new Error(CLAIM_INVALID),
    new Error("broker activity cleanup exploded"),
  );
  expect(thrown).toBeInstanceOf(AggregateError);
  expect(thrown.message).toBe(CLAIM_INVALID);
  expect(thrown.message).not.toBe(CLEANUP_MASK);
  expect(thrown.errors.map(error => error instanceof Error ? error.message : String(error)))
    .toEqual([CLAIM_INVALID, "broker activity cleanup exploded"]);
});

test("a claim error stays visible when its compensating activity cleanup also fails", async () => {
  const broker = scriptedBroker("dual-fail", request => (
    request.method === "claim"
      ? { error: CLAIM_INVALID }
      : { error: "broker activity cleanup exploded" }
  ));
  await broker.listen();
  try {
    const response = await withMcpClient(broker.socketPath, call => call("codex_tool_inventory", {
      turn_token: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
    expect(response.isError).toBe(true);
    const text = mcpErrorText(response);
    expect(text).toContain(CLAIM_INVALID);
    expect(text).not.toContain(CLEANUP_MASK);
    expect(broker.methods[0]).toBe("claim");
    expect(broker.methods.slice(1).every(method => method === "activity_complete")).toBe(true);
  } finally {
    await broker.close();
  }
}, 15_000);
