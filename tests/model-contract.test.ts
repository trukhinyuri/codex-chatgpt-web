import { expect, test } from "bun:test";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, chatGptEffortDegradedMessage, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

test("the browser adapter maps fixed routed efforts to the visible ChatGPT modes", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities)).toMatchObject({
    displayLabel: "Instant",
    uiEffortIndex: 0,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "medium", capabilities)).toMatchObject({
    uiEffortIndex: 1,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", capabilities)).toMatchObject({
    uiEffortIndex: 2,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", capabilities)).toMatchObject({
    uiEffortIndex: 3,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", capabilities)).toMatchObject({
    uiEffortIndex: 4,
    localTools: true,
  });
});

test("capabilities gate tools and Pro-only efforts explicitly without changing the selected model", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toMatchObject({ localTools: false });
  // An account without Extra High or Pro cannot select them however often Codex retries (upstream
  // codex-chatgpt-web issue #564), so the turn runs at High and says which level it lost.
  const plusOnly = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const pro = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", plusOnly);
  expect(pro).toMatchObject({ effort: "high", displayLabel: "High", uiEffortIndex: 2, degradedFrom: "max" });
  expect(chatGptEffortDegradedMessage(pro)).toBe("This ChatGPT account does not offer Pro; the task runs at High.");
  const extraHigh = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", { ...plusOnly, localToolsEnabled: true });
  expect(extraHigh).toMatchObject({ effort: "high", displayLabel: "High", localTools: true, degradedFrom: "xhigh" });
  expect(chatGptEffortDegradedMessage(extraHigh)).toBe("This ChatGPT account does not offer Extra High; the task runs at High.");
  // An account that does have them keeps them, and an ordinary High turn says nothing.
  const full = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", full)).toMatchObject({ effort: "xhigh", displayLabel: "Extra High" });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", full)).toMatchObject({ effort: "max", displayLabel: "Pro" });
  expect(chatGptEffortDegradedMessage(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", full))).toBeUndefined();
  expect(() => resolveChatGptWebModelMode("unknown", "high", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toThrow("model is not supported");
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "turbo", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toThrow("effort is not supported");
});

test("Luna-only capability binds the default model without a UI effort selector", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "low", {
    localToolsEnabled: true,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toEqual({
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    effort: "low",
    displayLabel: "Luna",
    uiEffortIndex: null,
    thinkEnabled: false,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "medium", {
    localToolsEnabled: true,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toEqual({
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    effort: "medium",
    displayLabel: "Think",
    uiEffortIndex: null,
    thinkEnabled: true,
    localTools: true,
  });
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", {
    localToolsEnabled: false,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toThrow("Luna-only account");
});
