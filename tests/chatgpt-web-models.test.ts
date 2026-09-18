import { describe, expect, test } from "bun:test";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_RETIRED_MODEL_SLUGS,
  CHATGPT_WEB_MODEL_ROUTES,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { routeChatGptWebRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

function parsed(modelId: string, reasoning = "medium"): CodexParsedRequest {
  return {
    modelId,
    context: { messages: [] },
    stream: false,
    options: { reasoning },
    _rawBody: { model: modelId, reasoning: { effort: reasoning } },
  };
}

describe("fixed ChatGPT Web model routes", () => {
  const plus = { solAvailable: true, extraHighAvailable: false };
  const pro = { solAvailable: true, extraHighAvailable: true };

  test("uses unique stable slugs and one explicit adapter effort per model", () => {
    expect(new Set(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug)).size).toBe(CHATGPT_WEB_MODEL_ROUTES.length);
    expect(CHATGPT_WEB_MODEL_ROUTES.map(route => [route.slug, route.codexEffort, route.adapterEffort])).toEqual([
      ["chatgpt-web/light", "low", "low"],
      ["chatgpt-web/medium", "medium", "medium"],
      ["chatgpt-web/high", "high", "high"],
      ["chatgpt-web/extra-high", "xhigh", "xhigh"],
    ]);
    expect(CHATGPT_WEB_MODEL_ROUTES[0]?.displayName).toBe("ChatGPT Web — Instant");
  });

  test("never publishes a Pro row and answers a Pro thread with one action", () => {
    // ChatGPT Web - Pro is retired; Extra High is the top of the list.
    expect(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug)).not.toContain("chatgpt-web/pro");
    expect(CHATGPT_WEB_MODEL_ROUTES.at(-1)?.slug).toBe("chatgpt-web/extra-high");
    expect(CHATGPT_WEB_MODEL_ROUTES.map(route => route.codexEffort)).not.toContain("ultra");
    for (const capabilities of [plus, pro]) {
      expect(availableChatGptWebModelRoutes(capabilities).map(route => route.slug)).not.toContain("chatgpt-web/pro");
      expect(availableChatGptWebModelRoutes(capabilities).map(route => route.slug))
        .not.toContain("chatgpt-web/zero-risk-pro");
    }
    for (const slug of CHATGPT_WEB_RETIRED_MODEL_SLUGS) {
      try {
        requireChatGptWebModelRoute(slug, pro);
        throw new Error(`expected ${slug} to be refused`);
      } catch (error) {
        expect(error).toMatchObject({
          name: "ChatGptWebAdapterError",
          code: "invalid_prompt",
          errorType: "chatgpt_model_retired",
          retryable: false,
        });
        expect(String(error)).toContain("Select ChatGPT Web — Extra High");
      }
    }
  });

  test("exposes only Plus-eligible routes without the Extra High account capability", () => {
    expect(availableChatGptWebModelRoutes(plus).map(route => route.slug)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
    ]);
    expect(availableChatGptWebModelRoutes({ solAvailable: true, extraHighAvailable: true }))
      .toEqual(CHATGPT_WEB_MODEL_ROUTES);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", plus))
      .toThrow("Extra High is not available for this account");
  });

  test("Extra High stays routable without granting Pro or Pro-sized context", () => {
    const config = { ...defaultConfig("full"), extraHighAvailable: true };
    expect(availableChatGptWebModelRoutes(config).map(route => route.slug))
      .toEqual(["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high"]);
    const request = parsed("chatgpt-web/extra-high", "low");
    expect(routeChatGptWebRequest(request, config).adapterEffort).toBe("xhigh");
    expect(request.options.reasoning).toBe("xhigh");
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", config))
      .toEqual(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", config));
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", config))
      .toEqual(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "high", config));
    expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", config)).toThrow("no longer available");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", { ...config, extraHighAvailable: undefined }))
      .toThrow("not available");
  });

  test("exposes Luna and Think when the authenticated account has no Sol selector", () => {
    const free = { solAvailable: false, extraHighAvailable: false };
    expect(availableChatGptWebModelRoutes(free)).toEqual(CHATGPT_WEB_LUNA_MODEL_ROUTES);
    expect(requireChatGptWebModelRoute("chatgpt-web/luna", free).backendModel)
      .toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(requireChatGptWebModelRoute("chatgpt-web/think", free))
      .toBe(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/light", free))
      .toThrow("Luna-only account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", {
      solAvailable: true,
      extraHighAvailable: false, })).toThrow("only available for Luna-only accounts");
  });

  test("Zero Risk exposes one generic route independent of account capabilities", () => {
    const manual = {
      solAvailable: false,
      extraHighAvailable: false, browserInteractionMode: "manual" as const,
    };
    expect(availableChatGptWebModelRoutes(manual)).toEqual([CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE]);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk", manual))
      .toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manual))
      .toThrow("no longer available");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", manual))
      .toThrow("not available while Zero Risk is enabled");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk", plus))
      .toThrow("only available while Zero Risk is enabled");
  });

  test("Zero Risk always publishes its fixed three-turn compaction interval and rejects multipart Bigger Context", () => {
    const manual = {
      solAvailable: true,
      extraHighAvailable: true, browserInteractionMode: "manual" as const,
    };
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual)).toEqual({
      contextWindow: 123_000,
      effectiveContextWindowPercent: 78,
      autoCompactTokenLimit: 96_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual)).toEqual({});
    expect(() => availableChatGptWebModelRoutes({
      ...manual,
      experimentalBiggerContext: true,
    })).toThrow("does not support Bigger Context");
  });

  test("publishes measured Plus browser windows and compacts before the transport ceiling", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      contextWindow: 41_000,
      effectiveContextWindowPercent: 78,
      autoCompactTokenLimit: 32_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      contextWindow: 90_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 80_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", plus)).toEqual({
      contextWindow: 90_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 80_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      browserComposerCharLimit: 211_256,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      browserComposerCharLimit: 1_048_572,
    });
    expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", plus))
      .toThrow("unavailable effort");
  });

  test("publishes Luna's real model window without early native compaction", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", {
      solAvailable: false,
      extraHighAvailable: false, })).toEqual({
      contextWindow: 1_050_000,
      effectiveContextWindowPercent: 100,
      autoCompactTokenLimit: 1_050_000,
    });
  });

  test("triples Sol context and compaction limits only when Bigger Context is enabled", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", {
      ...pro,
      experimentalBiggerContext: true,
    })).toEqual({
      contextWindow: 270_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 240_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", {
      solAvailable: false,
      extraHighAvailable: false, experimentalBiggerContext: true,
    })).toEqual({
      contextWindow: 1_050_000,
      effectiveContextWindowPercent: 100,
      autoCompactTokenLimit: 1_050_000,
    });
  });

  test("binds the selected model authoritatively and ignores a conflicting request effort", () => {
    const request = parsed("chatgpt-web/high", "low");
    const rawSnapshot = structuredClone(request._rawBody);
    const route = routeChatGptWebRequest(request, defaultConfig("browser-only"));

    expect(route.slug).toBe("chatgpt-web/high");
    expect(request.modelId).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("high");
    expect(request._rawBody).toEqual(rawSnapshot);
  });

  test("refuses a routed Pro request and fails closed for unknown routes", () => {
    const config = defaultConfig("full");
    config.extraHighAvailable = true;
    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/pro", "low"), config))
      .toThrow("Select ChatGPT Web — Extra High");
    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/not-enabled"), config))
      .toThrow("model is not enabled");
  });

  test("binds the Luna route to Luna without a selectable effort", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    const request = parsed("chatgpt-web/luna", "high");
    const route = routeChatGptWebRequest(request, config);
    expect(route).toBe(CHATGPT_WEB_LUNA_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");
  });

  test("binds the Think route to the Luna backend with explicit Think mode", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    const request = parsed("chatgpt-web/think", "high");
    const route = routeChatGptWebRequest(request, config);
    expect(route).toBe(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("medium");
  });

  test("Zero Risk routing preserves its internal backend identity and only a technical Codex effort", () => {
    const config = defaultConfig("full");
    config.browserInteractionMode = "manual";
    const request = parsed("chatgpt-web/zero-risk", "ultra");
    const route = routeChatGptWebRequest(request, config);

    expect(route).toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");

    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/zero-risk-pro", "ultra"), config))
      .toThrow("Select ChatGPT Web — Extra High");
  });
});
