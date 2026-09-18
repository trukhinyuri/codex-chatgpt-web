const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveLauncherProfile } = require("../electron/profile.cjs");

test("DEV launcher profile isolates every durable home from production", () => {
  const homeDir = path.resolve("/Users/tester");
  const production = resolveLauncherProfile({
    argv: ["electron", "."],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(production.kind, "production");
  assert.equal(development.kind, "development");
  assert.notEqual(development.coreHome, production.coreHome);
  assert.notEqual(development.codexHome, production.codexHome);
  assert.notEqual(development.userData, production.userData);
  assert.notEqual(development.browserPartition, production.browserPartition);
  assert.equal(development.userData, path.join(development.coreHome, "launcher"));
  assert.equal(development.codexHome, path.join(development.coreHome, "codex-home"));
});

test("DEV launcher refuses an explicit home collision with production", () => {
  const homeDir = path.resolve("/Users/tester");
  const shared = path.join(homeDir, "shared");
  assert.throws(() => resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODEX_WEB_GPT_DEV_HOME: shared,
      CODEX_CHATGPT_WEB_HOME: shared,
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  }), /must differ from the production/);
});

test("DEV launcher ignores generic production path overrides", () => {
  const homeDir = path.resolve("/Users/tester");
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODEX_CHATGPT_WEB_HOME: path.join(homeDir, "production-core"),
      CODEX_HOME: path.join(homeDir, "production-codex"),
      CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(homeDir, "production-launcher"),
      CODEX_WEB_GPT_DEV_HOME: path.join(homeDir, "isolated-dev"),
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(development.coreHome, path.join(homeDir, "isolated-dev"));
  assert.equal(development.codexHome, path.join(homeDir, "isolated-dev", "codex-home"));
  assert.equal(development.userData, path.join(homeDir, "isolated-dev", "launcher"));
});

test("the visible name is Codex Superpower while the durable identities keep their Codex Web GPT names", () => {
  const homeDir = path.resolve("/Users/tester");
  const appData = path.join(homeDir, "Library", "Application Support");
  const production = resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData });
  const development = resolveLauncherProfile({ argv: ["electron", ".", "--dev-profile"], env: {}, homeDir, appData });

  assert.equal(production.displayName, "Codex Superpower");
  assert.equal(development.displayName, "Codex Superpower DEV");
  // The sign-in cookies, update state, rollback copies and the runtime home stay where they were:
  // none of them is derived from the name the app shows.
  assert.equal(production.userData, path.join(appData, "Codex Web GPT"));
  assert.equal(production.browserPartition, "persist:codex-web-gpt-chatgpt");
  assert.equal(production.coreHome, path.join(homeDir, ".codex-chatgpt-web"));
  assert.equal(production.codexHome, path.join(homeDir, ".codex"));
  assert.equal(development.browserPartition, "persist:codex-web-gpt-dev-chatgpt");
  assert.equal(development.coreHome, path.join(homeDir, ".codex-chatgpt-web-dev"));
  for (const profile of [production, development]) {
    for (const key of ["userData", "browserPartition", "coreHome", "codexHome"]) {
      assert.doesNotMatch(profile[key], /Superpower/i, `${profile.kind}.${key}`);
    }
  }
});
