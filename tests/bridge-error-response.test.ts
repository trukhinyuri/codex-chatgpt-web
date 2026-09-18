import { expect, test } from "bun:test";
import { formatErrorResponse } from "../src/bridge";

interface ErrorBody {
  message: string;
  type: string;
  code: string;
}

async function errorBody(response: Response): Promise<ErrorBody> {
  return (await response.json() as { error: ErrorBody }).error;
}

test("formatErrorResponse strips control characters and joins a multi-line upstream message onto one line", async () => {
  const message = "line one\nline two\tline three\x00\x1b[31mred\x1b[0mend";
  const response = formatErrorResponse(502, "upstream_error", message);
  const error = await errorBody(response);
  expect(error.message).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);
  expect(error.message).not.toContain("\n");
  expect(error.message).not.toContain("\t");
  expect(error.message).toContain("line one line two line three");
  expect(error.message).toContain("red");
});

test("formatErrorResponse bounds an oversized upstream message instead of passing it through unbounded", async () => {
  const message = "x".repeat(10_000);
  const response = formatErrorResponse(502, "upstream_error", message);
  const error = await errorBody(response);
  expect(error.message.length).toBeLessThanOrEqual(4_001);
  expect(error.message.endsWith("…")).toBe(true);
});

test("formatErrorResponse keeps enough of a real error message for classification to still recognize it", async () => {
  const response = formatErrorResponse(
    400,
    "invalid_request_error",
    "upstream said: context_length_exceeded for this request",
  );
  const error = await errorBody(response);
  expect(error.code).toBe("context_length_exceeded");
});

test("formatErrorResponse falls back to a generic message when the sanitized text is empty", async () => {
  const response = formatErrorResponse(500, "server_error", "\x00\x01\x02");
  const error = await errorBody(response);
  expect(error.message).toBe("An error occurred");
});
