import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

// A genuine 2x2 pixel PNG -- deliberately NOT the 1x1 stub PNG used elsewhere as a placeholder
// (isOnePixelPngDataUrl in src/responses/compaction.ts), because the compiler never attaches a
// one-pixel placeholder at all, which would make it a poor fixture for testing that a real image
// is actually validated and attached.
const validPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";

function webTurnRequest(input: unknown[]): Request {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/light", stream: false, input }),
  });
}

test("rejects a remote image URL before constructing the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  let adapterConstructions = 0;
  const response = await responseRequest(webTurnRequest([{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "describe" }, { type: "input_image", image_url: "https://example.com/cat.png" }],
  }]), config, () => {
    adapterConstructions += 1;
    throw new Error("browser adapter must not be constructed");
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      message: expect.stringContaining("must be an inline base64 data URL"),
    },
  });
  expect(adapterConstructions).toBe(0);
});

test("rejects an inline image with an unsupported media type before constructing the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  let adapterConstructions = 0;
  const response = await responseRequest(webTurnRequest([{
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: "data:image/bmp;base64,Qk0=" }],
  }]), config, () => {
    adapterConstructions += 1;
    throw new Error("browser adapter must not be constructed");
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      message: expect.stringContaining("unsupported media type: image/bmp"),
    },
  });
  expect(adapterConstructions).toBe(0);
});

test("accepts a valid inline base64 image and reaches the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  let adapterConstructions = 0;
  const response = await responseRequest(webTurnRequest([{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "describe" }, { type: "input_image", image_url: validPng }],
  }]), config, () => {
    adapterConstructions += 1;
    return {
      name: "stub",
      runTurn: async (_parsed, _incoming, emit) => {
        emit({ type: "error", message: "stub turn ended" });
      },
    };
  });

  expect(response.status).toBe(200);
  expect(adapterConstructions).toBe(1);
});

// This is the regression PR #488 introduced upstream and the maintainer rejected it for: an image
// the compiler will correctly omit from this turn's outgoing attachments (here, dropped for
// exceeding ChatGPT's 10-images-per-turn budget, oldest first) must never be rejected at the HTTP
// boundary just because it happens to be malformed. Only images chatGptWebAttachedInputImages
// proves will actually be attached are validated early (see findInvalidChatGptWebInputImage in
// src/server.ts); an older, budget-dropped image's own validity is irrelevant.
test("does not reject a malformed image the compiler drops for exceeding the per-turn image budget", async () => {
  const config = defaultConfig("browser-only");
  let adapterConstructions = 0;
  const oldestMalformedImage = {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: "https://example.com/never-attached.png" }],
  };
  const tenValidImages = {
    type: "message",
    role: "user",
    content: Array.from({ length: 10 }, () => ({ type: "input_image", image_url: validPng })),
  };
  const response = await responseRequest(webTurnRequest([oldestMalformedImage, tenValidImages]), config, () => {
    adapterConstructions += 1;
    return {
      name: "stub",
      runTurn: async (_parsed, _incoming, emit) => {
        emit({ type: "error", message: "stub turn ended" });
      },
    };
  });

  expect(response.status).toBe(200);
  expect(adapterConstructions).toBe(1);
});
