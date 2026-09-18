// The rename to Codex Superpower must not change what the embedded ChatGPT browser sends: Cloudflare
// binds its clearance on chatgpt.com to the User-Agent, and a new one is challenged again. The strings
// below are what Electron 41.10.7 reported on macOS with app.setName("Codex Web GPT") and
// app.setName("Codex Superpower"), with the app version of the packaged launcher.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { keepUserAgentProduct, userAgentProductToken } = require("../electron/user-agent.cjs");
const { resolveLauncherProfile } = require("../electron/profile.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const PLATFORM = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";
const ENGINE = "Chrome/146.0.7680.216 Electron/41.10.7 Safari/537.36";
const BEFORE_RENAME = `${PLATFORM} CodexWebGPT/5.0.8 ${ENGINE}`;
const AFTER_SET_NAME = `${PLATFORM} CodexSuperpower/5.0.8 ${ENGINE}`;

function profiles() {
  const homeDir = path.resolve("/Users/tester");
  const appData = path.join(homeDir, "Library", "Application Support");
  const legacy = require("./fixtures/updater-86f2d311/profile.cjs").resolveLauncherProfile;
  return {
    production: resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData }),
    development: resolveLauncherProfile({ argv: ["electron", ".", "--dev-profile"], env: {}, homeDir, appData }),
    legacyProduction: legacy({ argv: ["electron", "."], env: {}, homeDir, appData }),
    legacyDevelopment: legacy({ argv: ["electron", ".", "--dev-profile"], env: {}, homeDir, appData }),
  };
}

test("Electron's product token is the app name without spaces", () => {
  assert.equal(userAgentProductToken("Codex Web GPT"), "CodexWebGPT");
  assert.equal(userAgentProductToken("Codex Superpower DEV"), "CodexSuperpowerDEV");
});

test("the renamed launcher sends exactly the User-Agent it sent before the rename", () => {
  const { production } = profiles();
  const kept = keepUserAgentProduct(AFTER_SET_NAME, { appName: production.displayName, userAgentName: production.userAgentName });
  assert.equal(kept, BEFORE_RENAME);
  // Nothing but the product token changed: the browser still says it is Chrome inside Electron.
  assert.ok(kept.endsWith(` ${ENGINE}`));
  assert.match(kept, / Electron\/41\.10\.7 /);
  assert.match(kept, / Chrome\/146\.0\.7680\.216 /);
  assert.equal(kept.replace("CodexWebGPT/", "CodexSuperpower/"), AFTER_SET_NAME);
});

test("each profile keeps the product token its launcher sent before the rename", () => {
  const { production, development, legacyProduction, legacyDevelopment } = profiles();
  assert.equal(userAgentProductToken(production.userAgentName), userAgentProductToken(legacyProduction.displayName));
  assert.equal(userAgentProductToken(development.userAgentName), userAgentProductToken(legacyDevelopment.displayName));
  const developmentAgent = `${PLATFORM} CodexSuperpowerDEV/5.0.8 ${ENGINE}`;
  assert.equal(
    keepUserAgentProduct(developmentAgent, { appName: development.displayName, userAgentName: development.userAgentName }),
    `${PLATFORM} CodexWebGPTDEV/5.0.8 ${ENGINE}`,
  );
});

test("a User-Agent without the app's own token is left alone", () => {
  const names = { appName: "Codex Superpower", userAgentName: "Codex Web GPT" };
  for (const userAgent of [
    BEFORE_RENAME,
    `${PLATFORM} ${ENGINE}`,
    `${PLATFORM} XCodexSuperpower/5.0.8 ${ENGINE}`,
    "custom agent",
    "",
  ]) {
    assert.equal(keepUserAgentProduct(userAgent, names), userAgent);
  }
  assert.equal(keepUserAgentProduct(AFTER_SET_NAME, { appName: "Codex Web GPT", userAgentName: "Codex Web GPT" }), AFTER_SET_NAME);
  assert.equal(keepUserAgentProduct(undefined, names), undefined);
});

test("main.cjs keeps the token right after setName, and nothing else in the launcher sets a User-Agent", () => {
  const main = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
  const setName = main.indexOf("app.setName(LAUNCHER_PROFILE.displayName);");
  const fallback = main.search(/app\.userAgentFallback = keepUserAgentProduct\(app\.userAgentFallback, \{\s*appName: LAUNCHER_PROFILE\.displayName,\s*userAgentName: LAUNCHER_PROFILE\.userAgentName,\s*\}\);/);
  assert.ok(setName >= 0 && fallback > setName, "the fallback is set after the name it corrects");
  const between = main.slice(setName, fallback);
  assert.doesNotMatch(between, /BrowserWindow|session\.|whenReady/, "no page or session exists before the fallback");
  for (const marker of ["new BrowserWindow(", "session.fromPartition(", "await app.whenReady()"]) {
    const index = main.indexOf(marker);
    assert.ok(index < 0 || index > fallback, `${marker} comes after the User-Agent fallback`);
  }
  // No other User-Agent anywhere in the launcher: nothing disguises the browser (requirements R7.5).
  const electronFiles = fs.readdirSync(path.join(launcherRoot, "electron")).filter(name => /\.c?js$/.test(name));
  for (const name of electronFiles) {
    const source = fs.readFileSync(path.join(launcherRoot, "electron", name), "utf8");
    assert.doesNotMatch(source, /setUserAgent|userAgent\s*:|Network\.setUserAgentOverride|Emulation\.setUserAgentOverride/, name);
    const assignments = source.match(/userAgentFallback\s*=/g) || [];
    assert.equal(assignments.length, name === "main.cjs" ? 1 : 0, name);
  }
});
