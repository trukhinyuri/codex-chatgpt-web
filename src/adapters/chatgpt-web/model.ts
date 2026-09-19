import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  chatGptWebRetiredProModelError,
} from "../../chatgpt-web-models";

export const CHATGPT_WEB_MODEL_ID = CHATGPT_WEB_BACKEND_MODEL;
export const CHATGPT_WEB_LUNA_MODEL_ID = CHATGPT_WEB_LUNA_BACKEND_MODEL;

export interface ChatGptWebCapabilities {
  localToolsEnabled: boolean;
  solAvailable: boolean;
  extraHighAvailable: boolean;
}

export interface ChatGptWebModelMode {
  modelId: string;
  effort: "low" | "medium" | "high" | "xhigh";
  displayLabel: "Luna" | "Think" | "Instant" | "Medium" | "High" | "Extra High";
  uiEffortIndex: 0 | 1 | 2 | 3 | null;
  thinkEnabled: boolean;
  localTools: boolean;
  /**
   * The effort Codex asked for when the account does not offer it and High was used instead.
   * A level the account does not have cannot be selected however often a turn is retried
   * (upstream codex-chatgpt-web issue #564: Extra High failed at every prompt attachment on a
   * Plus account while High worked), so the turn runs at High and says so instead of failing.
   */
  degradedFrom?: "xhigh";
}

/** The level the account does have, when the one Codex asked for is missing. */
function chatGptEffortDegradedToHigh(
  modelId: string,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebModelMode {
  return {
    modelId,
    effort: "high",
    displayLabel: "High",
    uiEffortIndex: 2,
    thinkEnabled: false,
    localTools: capabilities.localToolsEnabled,
    degradedFrom: "xhigh",
  };
}

/** What a person is told about a degraded level: one sentence, no action needed from them. */
export function chatGptEffortDegradedMessage(mode: ChatGptWebModelMode): string | undefined {
  if (!mode.degradedFrom) return undefined;
  return "This ChatGPT account does not offer Extra High; the task runs at High.";
}

export function resolveChatGptWebModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    if (capabilities.solAvailable) {
      throw new Error("ChatGPT Luna is not available while the account exposes the Sol model selector");
    }
    const effort = reasoning ?? "low";
    if (effort !== "low" && effort !== "medium") {
      throw new Error(`ChatGPT Luna mode is not supported: ${effort}`);
    }
    const thinkEnabled = effort === "medium";
    return {
      modelId,
      effort,
      displayLabel: thinkEnabled ? "Think" : "Luna",
      uiEffortIndex: null,
      thinkEnabled,
      localTools: capabilities.localToolsEnabled,
    };
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`);
  }
  if (!capabilities.solAvailable) {
    throw new Error("ChatGPT Sol modes are not available for this Luna-only account");
  }
  const effort = reasoning ?? "high";
  switch (effort) {
    case "low":
      return { modelId, effort, displayLabel: "Instant", uiEffortIndex: 0, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "medium":
      return { modelId, effort, displayLabel: "Medium", uiEffortIndex: 1, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "high":
      return { modelId, effort, displayLabel: "High", uiEffortIndex: 2, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "xhigh":
      if (!capabilities.extraHighAvailable) return chatGptEffortDegradedToHigh(modelId, capabilities);
      return { modelId, effort, displayLabel: "Extra High", uiEffortIndex: 3, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "max":
    case "ultra":
      // The retired Pro mode. A thread still pinned to it gets one action, not a silent upgrade.
      throw chatGptWebRetiredProModelError("ChatGPT Web — Pro");
    default:
      throw new Error(`ChatGPT web effort is not supported: ${effort}`);
  }
}
