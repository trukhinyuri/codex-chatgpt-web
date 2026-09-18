// What the About panel shows. Without these options macOS would build it from Info.plist, where the
// copyright comes from package.json at packaging time. electron-builder drops the `build` section from
// the packaged manifest, so the running app keeps its own copy of build.copyright; a packaging contract
// test keeps the two equal.
const PRODUCT_NAME = "Codex Superpower";
const PRODUCT_COPYRIGHT = "Copyright © 2026 Yuri Trukhin. Based on Codex Web GPT by miuuyy and contributors. MIT License.";
const PROJECT_URL = "https://github.com/trukhinyuri/codex-superpower";
const ORIGINAL_PROJECT_URL = "https://github.com/miuuyy/codex-chatgpt-web";
const AUTHORS = Object.freeze(["Yuri Trukhin", "miuuyy and the Codex Web GPT contributors"]);

/** Options for app.setAboutPanelOptions: the fork and its author first, then the original project. */
function aboutPanelOptions({ displayName = PRODUCT_NAME, version, commit = null } = {}) {
  const build = /^[0-9a-f]{40}$/.test(String(commit || "")) ? String(commit).slice(0, 7) : null;
  return {
    applicationName: displayName,
    applicationVersion: String(version || ""),
    // macOS shows this in parentheses after the version; without it AppKit shows CFBundleVersion.
    ...(build ? { version: build } : {}),
    copyright: PRODUCT_COPYRIGHT,
    credits: [
      `${PRODUCT_NAME} by Yuri Trukhin`,
      PROJECT_URL,
      "",
      "Based on Codex Web GPT by miuuyy and contributors",
      ORIGINAL_PROJECT_URL,
    ].join("\n"),
    authors: [...AUTHORS],
    website: PROJECT_URL,
  };
}

module.exports = {
  AUTHORS,
  ORIGINAL_PROJECT_URL,
  PRODUCT_COPYRIGHT,
  PRODUCT_NAME,
  PROJECT_URL,
  aboutPanelOptions,
};
