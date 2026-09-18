const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file) {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  const loaded = { exports: {} };
  new Function("module", "exports", "require", output)(loaded, loaded.exports, require);
  return loaded.exports;
}

const { updateButtonState } = load("update-button.ts");
const { copyFor } = load("i18n.ts");

test("the update button says what the pending update does and stays clickable while it waits", () => {
  const copy = copyFor("en");
  const version = "5.0.8+2222222";
  assert.deepEqual(updateButtonState({ status: "available", version }, copy), { label: null, disabled: false });
  assert.deepEqual(updateButtonState({ status: "downloading", version, step: 3, steps: 4 }, copy), {
    label: "Preparing update · step 3 of 4", title: copy.updatePreparingHint, disabled: false,
  });
  assert.deepEqual(updateButtonState({ status: "installing", version, waitingForIdle: true }, copy), {
    label: "Update ready — click to install", title: copy.updateReadyHint, disabled: false,
  });
  assert.deepEqual(updateButtonState({ status: "installing", version, waitingForIdle: true, requested: true, activeTurns: 2 }, copy), {
    label: "Update waits for 2 Codex task(s)", title: copy.updateReadyHint, disabled: false,
  });
  assert.deepEqual(updateButtonState({ status: "installing", version, waitingForIdle: true, requested: true, activeTurns: 0 }, copy), {
    label: "Installing update…", disabled: true,
  });
  assert.equal(updateButtonState({ status: "installing", version }, copy).disabled, true);
});

test("every language has the update button texts with their placeholders", () => {
  for (const language of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
    const copy = copyFor(language);
    assert.match(copy.updatePreparing, /\{step\}[\s\S]*\{steps\}/, language);
    assert.match(copy.updateWaitingTasks, /\{count\}/, language);
    for (const key of ["updateReady", "updateReadyHint", "updatePreparingHint", "updateInstallingSoon"]) assert.ok(copy[key], `${language} ${key}`);
  }
});
