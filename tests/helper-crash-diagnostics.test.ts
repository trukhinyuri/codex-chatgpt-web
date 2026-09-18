import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";

// Before this fix, browser-helper-main.ts's requestShutdown() closed diagnosticOutput (stderr)
// immediately, before closeChatGptBrowserWorkers() cleanup ran. If that cleanup then failed and
// tried to report the reason via diagnostic(), the write went to an already-closed stream,
// erasing the only explanation for a status-1 helper exit.
test("browser helper keeps diagnostics writable until shutdown cleanup is reported", () => {
  const source = readFileSync("src/adapters/chatgpt-web/browser-helper-main.ts", "utf8");
  const cleanup = source.indexOf("shutdown cleanup failed");
  const closeAfterCleanup = source.indexOf("diagnosticOutput.close()", cleanup);
  const firstProtocolClose = source.indexOf("protocolOutput.close()");
  const firstDiagnosticClose = source.indexOf("diagnosticOutput.close()", firstProtocolClose);
  expect(cleanup).toBeGreaterThan(-1);
  expect(closeAfterCleanup).toBeGreaterThan(cleanup);
  // diagnosticOutput.close() must not appear until after protocolOutput.close(): the historical bug
  // closed both together, right at the top of requestShutdown(), before cleanup ran.
  expect(firstDiagnosticClose).toBeGreaterThan(firstProtocolClose);
  expect(source).toContain('process.once("uncaughtException"');
  expect(source).toContain('process.once("unhandledRejection"');
  expect(source).toContain("active operation(s)");
});

test("helper exit errors include bounded stderr and lifecycle tails", () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    recordHelperDiagnostic(line: string): void;
    recordHelperLifecycle(event: string): void;
    helperFailureWithContext(error: Error): Error;
    helperDiagnosticTail: string[];
    helperLifecycleTail: string[];
  };
  for (let index = 0; index < 80; index += 1) {
    internal.recordHelperDiagnostic(`stderr-${index}`);
    internal.recordHelperLifecycle(`event-${index}`);
  }
  const error = internal.helperFailureWithContext(new Error("Launcher browser helper exited with status 1"));
  expect(error.message).toContain("Launcher browser helper exited with status 1");
  expect(error.message).toContain("helper stderr tail:");
  expect(error.message).toContain("stderr-79");
  expect(error.message).not.toContain("stderr-0\n");
  expect(error.message).toContain("helper lifecycle tail:");
  expect(error.message).toContain("event-79");
  expect(internal.helperDiagnosticTail.length).toBeLessThanOrEqual(48);
  expect(internal.helperLifecycleTail.length).toBeLessThanOrEqual(96);
});

test("helper lifecycle breadcrumbs never serialize protocol payload text", () => {
  const source = readFileSync("src/adapters/chatgpt-web/launcher-helper-client.ts", "utf8");
  const sendTo = source.slice(source.indexOf("  private async sendTo("));
  expect(sendTo).toContain("tx type=${type}");
  expect(sendTo).not.toContain("JSON.stringify(frame)");
  expect(source).toContain("MAX_HELPER_DIAGNOSTIC_LINE_CHARS");
});
