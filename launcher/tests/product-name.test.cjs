// Everything a person reads names the product Codex Superpower, in every launcher language, and the
// About panel credits both the fork and the original project. Text sent to ChatGPT keeps the old name
// until the connector and prompt contract are migrated on their own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const languages = require("../electron/languages.json");
const { aboutPanelOptions, PRODUCT_COPYRIGHT } = require("../electron/about.cjs");
const { linuxDesktopEntry } = require("../electron/autostart.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");
const OLD_NAME = /Codex Web GPT/;

function loadI18nModule() {
  const output = ts.transpileModule(read("launcher", "src", "i18n.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const loaded = { exports: {} };
  Function("module", "exports", "require", output)(loaded, loaded.exports, require);
  return loaded.exports;
}

function nativeCopy() {
  const main = read("launcher", "electron", "main.cjs");
  const start = main.indexOf("const NATIVE_COPY = Object.freeze(");
  const end = main.indexOf("\nfunction nativeCopyFor(", start);
  assert.ok(start >= 0 && end > start, "main.cjs defines the native dialog and menu text");
  const context = {};
  vm.runInNewContext(`${main.slice(start, end)}\nglobalThis.NATIVE_COPY = NATIVE_COPY;`, context);
  return context.NATIVE_COPY;
}

test("every launcher language names the product Codex Superpower and never Codex Web GPT", () => {
  const { copyFor } = loadI18nModule();
  const locales = Object.keys(languages);
  assert.deepEqual(locales.sort(), ["en", "ja", "ko", "zh-CN", "zh-TW"]);
  for (const language of locales) {
    const copy = copyFor(language);
    assert.equal(copy.product, "Codex Superpower", language);
    assert.match(copy.setupTitle, /Codex Superpower/, language);
    assert.match(copy.supportBody, /Codex Superpower/, language);
    for (const [key, value] of Object.entries(copy)) {
      assert.doesNotMatch(String(value), OLD_NAME, `${language}.${key}`);
    }
  }
});

test("native menus and dialogs name Codex Superpower in all five languages", () => {
  const copy = nativeCopy();
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(languages).sort());
  for (const [language, entries] of Object.entries(copy)) {
    for (const key of ["openLauncher", "removeTitle", "startupTitle", "quitRunningTitle"]) {
      assert.match(entries[key], /Codex Superpower/, `${language}.${key}`);
    }
    for (const [key, value] of Object.entries(entries)) {
      assert.doesNotMatch(value, OLD_NAME, `${language}.${key}`);
    }
  }
});

test("window, tray, menu name, page title, heading and Linux autostart entry say Codex Superpower", () => {
  const main = read("launcher", "electron", "main.cjs");
  assert.doesNotMatch(main, OLD_NAME);
  assert.match(main, /app\.setName\(LAUNCHER_PROFILE\.displayName\)/);
  assert.match(main, /tray\.setToolTip\(LAUNCHER_PROFILE\.displayName\)/);
  assert.match(main, /title: LAUNCHER_PROFILE\.displayName,/);
  assert.match(main, /codex-superpower-diagnostics-\$\{date\}\.jsonl/);
  assert.match(read("launcher", "index.html"), /<title>Codex Superpower<\/title>/);
  const app = read("launcher", "src", "App.tsx");
  assert.match(app, /<h1>Codex Superpower<\/h1>/);
  assert.doesNotMatch(app, OLD_NAME);
  const entry = linuxDesktopEntry({ getPath: () => "/opt/codex/launcher" }, "/opt/codex/launcher");
  assert.match(entry, /^Name=Codex Superpower$/m);
  assert.doesNotMatch(entry, OLD_NAME);
  assert.doesNotMatch(read("launcher", "electron", "runtime.cjs"), OLD_NAME);
});

test("bridge and CLI messages that name the app say Codex Superpower", () => {
  for (const file of [
    ["src", "adapters", "chatgpt-web", "browser-worker.ts"],
    ["src", "browser-login.ts"],
    ["src", "cli.ts"],
    ["src", "setup.ts"],
    ["src", "service.ts"],
    ["src", "adapters", "chatgpt-web", "turn-broker.ts"],
    ["src", "dev-chat", "cli.ts"],
    // The "Local tools unavailable" notice is shown to the user in Codex; it is not sent to ChatGPT.
    ["src", "adapters", "chatgpt-web", "prompt.ts"],
  ]) {
    const source = read(...file);
    assert.doesNotMatch(source, OLD_NAME, file.join("/"));
  }
  assert.match(read("src", "adapters", "chatgpt-web", "browser-worker.ts"), /Sign in again in Codex Superpower\./);
  assert.match(read("src", "adapters", "chatgpt-web", "prompt.ts"), /Open `MCP` in `Codex Superpower`/);
});

test("text sent to ChatGPT keeps its wording, and both ends of the smoke phrase still agree", () => {
  const mcpServer = read("src", "adapters", "chatgpt-web", "mcp-server.ts");
  assert.match(mcpServer, /For each pasted Codex Web GPT request, begin with codex_turn_start/);
  assert.match(mcpServer, /Connect the request_id included in the pasted Codex Web GPT request/);
  const worker = read("src", "adapters", "chatgpt-web", "browser-worker.ts");
  const expected = /const CHATGPT_SMOKE_EXPECTED = "([^"]+)";/.exec(worker)?.[1];
  assert.equal(expected, "CODEX WEB GPT READY");
  assert.ok(read("launcher", "electron", "browser-host.cjs").includes(`evidence.response !== ${JSON.stringify(expected)}`));
});

test("the About panel names the fork, its author and the original project", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const options = aboutPanelOptions({ displayName: "Codex Superpower", version: "5.0.8", commit });
  assert.equal(options.applicationName, "Codex Superpower");
  assert.equal(options.applicationVersion, "5.0.8");
  assert.equal(options.version, "0123456");
  assert.equal(options.copyright, PRODUCT_COPYRIGHT);
  assert.match(options.copyright, /Yuri Trukhin/);
  assert.match(options.copyright, /miuuyy/);
  assert.match(options.credits, /Codex Superpower by Yuri Trukhin/);
  assert.match(options.credits, /https:\/\/github\.com\/trukhinyuri\/codex-superpower/);
  assert.match(options.credits, /Based on Codex Web GPT by miuuyy and contributors/);
  assert.match(options.credits, /https:\/\/github\.com\/miuuyy\/codex-chatgpt-web/);
  assert.ok(options.authors.includes("Yuri Trukhin"));
  assert.ok(options.authors.some(author => /miuuyy/.test(author)));
  assert.equal(options.website, "https://github.com/trukhinyuri/codex-superpower");

  const dev = aboutPanelOptions({ displayName: "Codex Superpower DEV", version: "5.0.8", commit: "dirty" });
  assert.equal(dev.applicationName, "Codex Superpower DEV");
  assert.equal("version" in dev, false, "without a commit AppKit shows CFBundleVersion");

  const main = read("launcher", "electron", "main.cjs");
  assert.match(main, /app\.setAboutPanelOptions\(aboutPanelOptions\(\{\s*displayName: LAUNCHER_PROFILE\.displayName,\s*version: app\.getVersion\(\),\s*commit: LAUNCHER_MANIFEST\.sourceCommit,/);
  assert.ok(main.indexOf("app.setAboutPanelOptions(") > main.indexOf("await app.whenReady();"), "set once the app is ready");
});
