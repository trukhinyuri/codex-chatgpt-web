import { expect, test } from "bun:test";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  activateChatGptEffortMenu,
  detectChatGptAccountCapabilities,
  readChatGptEffortSliderState,
} from "../src/chatgpt-session";

test("composer and effort selectors exclude unrelated editable fields and menu buttons", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body><form>
    <div contenteditable="true" id="unrelated-editor"></div>
    <textarea placeholder="Search" id="search"></textarea>
    <button aria-haspopup="menu" id="attachments"></button>
    <div data-testid="prompt-textarea" id="composer-testid"></div>
    <div id="prompt-textarea"></div>
    <div contenteditable="true" data-lexical-editor="true" id="composer-lexical"></div>
    <button aria-haspopup="menu" data-tone="neutral" id="effort"></button>
    <button aria-haspopup="menu" data-testid="model-switcher-dropdown-button" id="model"></button>
  </form></body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_COMPOSER_SELECTOR)).toEqual(["composer-testid", "prompt-textarea", "composer-lexical"]);
  expect(matches(CHATGPT_EFFORT_CONTROL_SELECTOR)).toEqual(["effort", "model"]);
});

test("the composer selector also recognizes the ProseMirror and textbox DOM variants (TAY0123 fix)", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body><form>
    <div contenteditable="true" id="unrelated-editor"></div>
    <div class="ProseMirror" contenteditable="true" id="composer-prosemirror"></div>
    <div role="textbox" aria-label="Chat with ChatGPT" contenteditable="true" id="composer-textbox"></div>
    <div role="textbox" aria-label="Something else" contenteditable="true" id="unrelated-textbox"></div>
  </form></body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_COMPOSER_SELECTOR)).toEqual(["composer-prosemirror", "composer-textbox"]);
});

test("effort activation binds the owned menu after the control opens", async () => {
  let opened = false;
  const ownedMenu = { isVisible: async () => opened };
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return opened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return opened ? "true" : "false";
      if (name === "data-state") return opened ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      expect(options).toEqual({ force: true, timeout: 1 });
      opened = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="radix-effort-menu"]') return ownedMenu;
      return hiddenSurface;
    },
    keyboard: { press: async () => {} },
  };

  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("click");
  expect(activation.menu).toBe(ownedMenu as never);
});

test.each(["aria-expanded", "data-state"])("effort activation does not bind a closing menu (%s)", async attribute => {
  let opened = false;
  let clicks = 0;
  // Escape closes the control immediately, but the outgoing menu remains visible
  // through its exit animation. Its stale range must not authorize a new selection.
  const surface = {
    filter() { return this; }, last() { return this; }, locator() { return this; },
    isVisible: async () => true,
  };
  const control = {
    getAttribute: async (name: string) => name === attribute
      ? attribute === "aria-expanded" ? String(opened) : opened ? "open" : "closed"
      : null,
    click: async () => { clicks++; opened = true; },
  };
  const page = { locator: () => surface, keyboard: { press: async () => {} } };
  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("click");
  expect(clicks).toBe(1);
});

test("effort activation retries one ghost click with a primary pointerdown", async () => {
  let ghostOpen = false;
  let pointerOpened = false;
  const events: unknown[] = [];
  const ownedMenu = { isVisible: async () => pointerOpened };
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return pointerOpened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return ghostOpen ? "true" : "false";
      if (name === "data-state") return ghostOpen ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      events.push(["click", options]);
      ghostOpen = true;
    },
    dispatchEvent: async (name: string, detail: unknown) => {
      events.push([name, detail]);
      ghostOpen = true;
      pointerOpened = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="radix-effort-menu"]') return ownedMenu;
      return hiddenSurface;
    },
    keyboard: {
      press: async (key: string) => {
        events.push(["keyboard", key]);
        ghostOpen = false;
      },
    },
  };

  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("pointerdown");
  expect(activation.menu).toBe(ownedMenu as never);
  expect(events).toEqual([
    ["click", { force: true, timeout: 1 }],
    ["keyboard", "Escape"],
    ["pointerdown", { button: 0, buttons: 1, pointerType: "mouse", isPrimary: true }],
  ]);
});

test("effort activation fails closed when neither event exposes a structural surface", async () => {
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async () => null,
    click: async () => {},
    dispatchEvent: async () => {},
  };
  const page = {
    locator: () => hiddenSurface,
    keyboard: { press: async () => {} },
  };

  await expect(activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 }))
    .rejects.toThrow("did not expose its owned menu or structural slider");
});

test("a complete authenticated composer with no effort selector is Luna-only", async () => {
  const effortButton = {
    last() { return this; },
    isVisible: async () => false,
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composer = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composer,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, extraHighAvailable: false });
});

test("a transient effort control does not turn a Luna-only account into Sol", async () => {
  let visibilityReads = 0;
  const effortButton = {
    last() { return this; },
    isVisible: async () => {
      visibilityReads += 1;
      return visibilityReads === 1;
    },
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composers = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composers,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, extraHighAvailable: false });
  expect(visibilityReads).toBe(2);
});

test("capability detection reopens the effort menu behind a stale aria-expanded flag (Gao327 fix)", async () => {
  let opened = false;
  const events: string[] = [];
  const modelRows = { count: async () => 3 };
  const menu = {
    filter() { return this; }, last() { return this; },
    isVisible: async () => opened,
    locator: () => modelRows,
  };
  const sliderControl = { press: async () => {} };
  const slider = {
    filter() { return this; }, last() { return this; },
    waitFor: async ({ state }: { state: string }) => {
      if (!opened) throw new Error("timed out waiting for the effort slider to attach");
      expect(state).toBe("attached");
    },
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": "4", "aria-valuenow": "2" } as Record<string, string>)[name] ?? null,
    locator: () => sliderControl,
  };
  const sliderContainer = {
    filter() { return this; }, last() { return this; },
    isVisible: async () => opened,
    waitFor: async ({ state }: { state: string }) => {
      if (!opened) throw new Error("timed out waiting for the effort container to become visible");
      expect(state).toBe("visible");
    },
    locator: () => slider,
  };
  const effortButton = {
    last() { return this; },
    isVisible: async () => true,
    // The account's picker reports aria-expanded="true" even though the menu is actually
    // closed (e.g. left over on a background surface). The old code trusted this attribute
    // and never reopened the menu, so the capability probe hung waiting on a closed surface.
    getAttribute: async (name: string) => (name === "aria-expanded" ? "true" : null),
    click: async () => { events.push("click"); opened = true; },
    dispatchEvent: async () => { events.push("pointerdown"); opened = true; },
  };
  const composerForm = { count: async () => 1, locator: () => effortButton };
  const composers = {
    filter() { return this; }, last() { return this; }, count: async () => 1, locator: () => composerForm,
  };
  const hidden = { filter() { return this; }, last() { return this; }, isVisible: async () => false };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composers;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return sliderContainer;
      return hidden;
    },
    keyboard: { press: async () => { events.push("escape"); } },
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, { selectorTimeoutMs: 500 }))
    .resolves.toEqual({ solAvailable: true, extraHighAvailable: true });
  expect(events).toContain("click");
});

function reasoningPicker(options: { max?: string; delay?: number; missing?: boolean } = {}) {
  let value = 0;
  const keys: string[] = [];
  const hidden = {
    filter() { return this; }, last() { return this; }, getByText() { return this; },
    isVisible: async () => false,
    waitFor: ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  };
  const sliderControl = { press: async (key: string) => { keys.push(key); value += key === "ArrowRight" ? 1 : -1; } };
  const slider = {
    isVisible: async () => false, // Live DOM: aria-hidden=true, zero-width semantic span.
    filter: () => { throw new Error("Semantic input must not be visibility-filtered"); },
    waitFor: async ({ state }: { state: string }) => { expect(state).toBe("attached"); },
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": options.max ?? "4", "aria-valuenow": String(value), "aria-hidden": "true" })[name] ?? null,
    evaluate: async () => ({ min: "0", max: options.max ?? "4", value: String(value) }),
    locator: () => sliderControl,
  };
  const container = {
    filter() { return this; }, last() { return this; },
    locator: () => slider,
    isVisible: async () => true,
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      if (options.missing) throw new Error("effort container never hydrated");
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    },
  };
  const control = {
    last() { return this; }, waitFor: async () => {}, isVisible: async () => true,
    getAttribute: async (name: string) => name === "aria-expanded" ? "true" : null,
  };
  const composer = { filter() { return this; }, last() { return this; }, locator: () => ({ locator: () => control }) };
  const modelRows = { count: async () => 3, first() { return this; }, waitFor: async () => {}, nth: () => { throw new Error("Model rows are not effort choices"); } };
  const menu = { filter() { return this; }, last() { return this; }, isVisible: async () => true, locator: () => modelRows };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return container;
      return hidden;
    },
    keyboard: { press: async () => {} },
  };
  return { page, composer, keys, value: () => value };
}

test.each([0, 50])("capabilities wait for the visible container and read its hidden semantic input (delay=%s)", async delay => {
  const fixture = reasoningPicker({ delay });
  await expect(detectChatGptAccountCapabilities(fixture.page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: true });
});

test("an absent effort slider cannot turn three model rows into a saved non-Pro capability", async () => {
  const fixture = reasoningPicker({ missing: true });
  await expect(detectChatGptAccountCapabilities(fixture.page as never)).rejects.toThrow("never hydrated");
});

test("the authoritative three-step range is non-Pro; a malformed range fails closed", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "2" }).page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: false });
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "bad" }).page as never)).rejects.toThrow("model controls are unavailable");
});

test("the four-step browser range keeps Extra High available when Pro is unavailable", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "3" }).page as never))
    .resolves.toEqual({ solAvailable: true, extraHighAvailable: true });
});

test("Extra High selection changes the hidden slider through its visible owner, never through model rows", async () => {
  const fixture = reasoningPicker({ delay: 50 });
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<unknown>;
  }).selectModelAndEffort;
  await select.call({ activeComposer: async () => fixture.composer }, fixture.page, "gpt-5.6-sol", "xhigh", { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true });
  expect(fixture.keys).toEqual(["ArrowRight", "ArrowRight", "ArrowRight"]);
  expect(fixture.value()).toBe(3);
});

test("an effort step the account stopped offering degrades to the highest step it still has", async () => {
  // Upstream miuuyy/codex-chatgpt-web#564: the range shrinks from four steps to three, and every
  // Extra High turn used to fail on a level that is no longer there. Repeating into it is exactly
  // the traffic that gets an account held, so the turn takes the step the account still offers.
  const fixture = reasoningPicker({ max: "2" });
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<{ displayLabel: string; uiEffortIndex: number | null }>;
  }).selectModelAndEffort;
  const mode = await select.call(
    { activeComposer: async () => fixture.composer },
    fixture.page,
    "gpt-5.6-sol",
    "xhigh",
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true },
  );
  expect(mode).toMatchObject({ displayLabel: "High", uiEffortIndex: 2, effort: "high" });
  expect(fixture.keys).toEqual(["ArrowRight", "ArrowRight"]);
  expect(fixture.value()).toBe(2);
});

test("an effort control without any usable range stops the account instead of retrying", async () => {
  const fixture = reasoningPicker({ max: "bad" });
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<unknown>;
  }).selectModelAndEffort;
  await expect(select.call(
    { activeComposer: async () => fixture.composer },
    fixture.page,
    "gpt-5.6-sol",
    "high",
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true },
  )).rejects.toMatchObject({
    errorType: "chatgpt_security_hold",
    code: "invalid_prompt",
    retryable: false,
  });
});

test("readChatGptEffortSliderState distinguishes a detached popover from a valid or invalid ARIA read", async () => {
  const detached = { evaluate: async () => { throw new Error("element is not attached to the DOM"); } };
  await expect(readChatGptEffortSliderState(detached as unknown as Locator)).resolves.toBe("detached");

  const valid = { evaluate: async () => ({ min: "0", max: "4", value: "2" }) };
  await expect(readChatGptEffortSliderState(valid as unknown as Locator)).resolves.toEqual({ min: 0, max: 4, value: 2 });

  const invalid = { evaluate: async () => ({ min: "0", max: "9", value: "2" }) };
  await expect(readChatGptEffortSliderState(invalid as unknown as Locator)).resolves.toBeUndefined();
});

/**
 * ChatGPT can replace or close the effort popover between locating the slider and reading its
 * ARIA state (upstream PR #133). The old code read `aria-valuemin`/`-valuemax`/`-valuenow` as
 * three separate `getAttribute` round-trips, so this fixture always fails `getAttribute` on the
 * slider element -- exactly the pattern the port removes -- while `evaluate` (the new atomic
 * read) succeeds except on the call indexes the test asks it to simulate as detached.
 */
function detachRacingReasoningPicker(options: { detachOnEvaluateCalls: number[] }) {
  let value = 0;
  let evaluateCalls = 0;
  const keys: string[] = [];
  const hidden = {
    filter() { return this; }, last() { return this; }, getByText() { return this; },
    isVisible: async () => false,
    waitFor: ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  };
  const sliderControl = { press: async (key: string) => { keys.push(key); value += key === "ArrowRight" ? 1 : -1; } };
  const slider = {
    isVisible: async () => false,
    filter: () => { throw new Error("Semantic input must not be visibility-filtered"); },
    waitFor: async ({ state }: { state: string }) => { expect(state).toBe("attached"); },
    getAttribute: async () => { throw new Error("ChatGPT effort slider element is not attached to the DOM"); },
    evaluate: async () => {
      evaluateCalls += 1;
      if (options.detachOnEvaluateCalls.includes(evaluateCalls)) {
        throw new Error("ChatGPT effort slider element is not attached to the DOM");
      }
      return { min: "0", max: "4", value: String(value) };
    },
    locator: () => sliderControl,
  };
  const container = {
    filter() { return this; }, last() { return this; },
    locator: () => slider,
    isVisible: async () => true,
    waitFor: async ({ state }: { state: string }) => { expect(state).toBe("visible"); },
  };
  const control = {
    last() { return this; }, waitFor: async () => {}, isVisible: async () => true,
    getAttribute: async (name: string) => name === "aria-expanded" ? "true" : null,
  };
  const composer = { filter() { return this; }, last() { return this; }, locator: () => ({ locator: () => control }) };
  const modelRows = { count: async () => 3, first() { return this; }, waitFor: async () => {}, nth: () => { throw new Error("Model rows are not effort choices"); } };
  const menu = { filter() { return this; }, last() { return this; }, isVisible: async () => true, locator: () => modelRows };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return container;
      return hidden;
    },
    keyboard: { press: async () => {} },
  };
  return { page, composer, keys };
}

test("effort selection reopens the popover when ChatGPT detaches it before the first ARIA read (PR #133)", async () => {
  const fixture = detachRacingReasoningPicker({ detachOnEvaluateCalls: [1] });
  const diagnostics: string[] = [];
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<unknown>;
  }).selectModelAndEffort;
  const mode = await select.call(
    { activeComposer: async () => fixture.composer },
    fixture.page,
    "gpt-5.6-sol",
    "high",
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true },
    async (checkpoint: string) => { diagnostics.push(checkpoint); },
  );
  expect(mode).toMatchObject({ displayLabel: "High", uiEffortIndex: 2 });
  expect(fixture.keys).toEqual(["ArrowRight", "ArrowRight"]);
  expect(diagnostics).toContain("effort-slider-reopen-retry");
});

test("effort selection reopens the popover when ChatGPT detaches it right after a keypress (PR #133)", async () => {
  // Call 2 is the post-keypress read that discovers the detachment; call 3 is the recovery
  // helper's own first attempt, also detached, so it must actually reopen the menu (not just
  // get lucky on a second read) before call 4 succeeds.
  const fixture = detachRacingReasoningPicker({ detachOnEvaluateCalls: [2, 3] });
  const diagnostics: string[] = [];
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<unknown>;
  }).selectModelAndEffort;
  const mode = await select.call(
    { activeComposer: async () => fixture.composer },
    fixture.page,
    "gpt-5.6-sol",
    "high",
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true },
    async (checkpoint: string) => { diagnostics.push(checkpoint); },
  );
  expect(mode).toMatchObject({ displayLabel: "High", uiEffortIndex: 2 });
  expect(fixture.keys).toEqual(["ArrowRight", "ArrowRight"]);
  expect(diagnostics).toContain("effort-slider-reopen-retry");
});
