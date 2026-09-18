import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindCompactionContinuationStore,
  ChatGptCompactionContinuationStore,
  isAcceptedCompactionContinuation,
  rememberCompactionContinuation,
} from "../src/adapters/chatgpt-web/compaction-continuation";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "compaction-continuation-"));
  roots.push(root);
  return join(root, "runtime", "compaction-continuations.json");
}

function fixture(oldTurnId: string, currentTurnId: string, summary: string): {
  parsed: CodexParsedRequest;
  identity: { threadId: string; turnId: string };
  source: { turnId: string; content: unknown };
} {
  const threadId = "01a06c66-4232-7ae1-9108-69b5f70e0671";
  const oldContent = [{ type: "input_text", text: "Original instruction" }];
  const parsed: CodexParsedRequest = {
    modelId: "chatgpt-web/high",
    context: { messages: [] },
    stream: true,
    options: {},
    _compactionRequest: true,
    _rawBody: {
      input: [
        { type: "message", role: "user", content: oldContent, id: "msg_old",
          internal_chat_message_metadata_passthrough: { turn_id: oldTurnId } },
        { type: "message", role: "user", id: "msg_checkpoint",
          content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] },
      ],
    },
  };
  return {
    parsed,
    identity: { threadId, turnId: currentTurnId },
    source: { turnId: oldTurnId, content: oldContent },
  };
}

test("a checkpoint remembered by one store instance is accepted by a fresh instance reading the same file, surviving a restart", () => {
  const path = statePath();
  const { parsed, identity, source } = fixture(
    "01a06c66-0000-75c6-a0df-318f890ef6de",
    "01a06c66-1111-75c6-a0df-318f890ef6de",
    "Confirmed restart checkpoint",
  );

  const beforeRestart = new ChatGptCompactionContinuationStore(path);
  beforeRestart.remember(parsed, identity, [source], "Confirmed restart checkpoint");

  // A brand-new instance simulates the daemon process restarting: nothing is shared in memory,
  // only the file on disk.
  const afterRestart = new ChatGptCompactionContinuationStore(path);
  expect(afterRestart.accepts(parsed, identity, source)).toBe(true);
});

test("without a persistence path, evidence is memory-only and does not survive a fresh instance", () => {
  const { parsed, identity, source } = fixture(
    "01a06c66-2222-75c6-a0df-318f890ef6de",
    "01a06c66-3333-75c6-a0df-318f890ef6de",
    "Ephemeral checkpoint",
  );
  const first = new ChatGptCompactionContinuationStore(undefined);
  first.remember(parsed, identity, [source], "Ephemeral checkpoint");
  const second = new ChatGptCompactionContinuationStore(undefined);
  expect(second.accepts(parsed, identity, source)).toBe(false);
});

test("the persisted file never contains the prompt or summary plaintext, only hashes and native identity scope", () => {
  const path = statePath();
  const { parsed, identity, source } = fixture(
    "01a06c66-4444-75c6-a0df-318f890ef6de",
    "01a06c66-5555-75c6-a0df-318f890ef6de",
    "Secret task details must never be written to disk in the clear",
  );
  new ChatGptCompactionContinuationStore(path).remember(parsed, identity, [source], "Secret task details must never be written to disk in the clear");
  const raw = readFileSync(path, "utf8");
  expect(raw).not.toContain("Secret task details");
  expect(raw).not.toContain("Original instruction");
  const payload = JSON.parse(raw) as { version: number; checkpoints: Array<Record<string, unknown>> };
  expect(payload.version).toBe(1);
  expect(payload.checkpoints).toHaveLength(1);
  expect(payload.checkpoints[0]!.summaryHash).toMatch(/^[a-f0-9]{64}$/);
});

test("a corrupted persisted file fails safe: it is treated as empty instead of throwing or trusting partial data", () => {
  const path = statePath();
  mkdirSync(join(path, ".."), { recursive: true });
  for (const raw of [
    "not json at all",
    JSON.stringify({ version: 2, checkpoints: [] }),
    JSON.stringify({ version: 1, checkpoints: [{ key: "not-a-json-array", summaryHash: "a".repeat(64), sourceHashes: ["b".repeat(64)] }] }),
    JSON.stringify({ version: 1, checkpoints: [{ key: JSON.stringify(["t", "u", "m", null]), summaryHash: "short", sourceHashes: ["b".repeat(64)] }] }),
    JSON.stringify({ version: 1, checkpoints: [{ key: JSON.stringify(["t", "u", "m", null]), summaryHash: "a".repeat(64), sourceHashes: [] }] }),
  ]) {
    writeFileSync(path, raw);
    const store = new ChatGptCompactionContinuationStore(path);
    const { parsed, identity, source } = fixture(
      "01a06c66-6666-75c6-a0df-318f890ef6de",
      "01a06c66-7777-75c6-a0df-318f890ef6de",
      "irrelevant",
    );
    expect(() => store.accepts(parsed, identity, source)).not.toThrow();
    expect(store.accepts(parsed, identity, source)).toBe(false);
  }
});

test("bindCompactionContinuationStore routes the free functions to a specific store instance, per parsed request", () => {
  const boundPath = statePath();
  const bound = new ChatGptCompactionContinuationStore(boundPath);
  const { parsed, identity, source } = fixture(
    "01a06c66-8888-75c6-a0df-318f890ef6de",
    "01a06c66-9999-75c6-a0df-318f890ef6de",
    "Bound-store checkpoint",
  );
  bindCompactionContinuationStore(parsed, bound);
  rememberCompactionContinuation(parsed, identity, [source], "Bound-store checkpoint");
  // The bound store, not the module-level default, must have received the write.
  expect(isAcceptedCompactionContinuation(parsed, identity, source)).toBe(true);
  expect(JSON.parse(readFileSync(boundPath, "utf8")).checkpoints).toHaveLength(1);

  // An unbound request (the historical direct-call shape most other tests use) never touches the
  // bound store or its file.
  const { parsed: unbound, identity: unboundIdentity, source: unboundSource } = fixture(
    "01a06c66-aaaa-75c6-a0df-318f890ef6de",
    "01a06c66-bbbb-75c6-a0df-318f890ef6de",
    "Unbound checkpoint",
  );
  rememberCompactionContinuation(unbound, unboundIdentity, [unboundSource], "Unbound checkpoint");
  expect(JSON.parse(readFileSync(boundPath, "utf8")).checkpoints).toHaveLength(1);
});
