const test = require("node:test");
const assert = require("node:assert/strict");
const { openedAtLoginOnMac } = require("../electron/autostart.cjs");

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// app.setLoginItemSettings({ args }) is Windows-only (Electron's documented behavior); macOS
// ignores `args` entirely, so the launcher's "--hidden" flag never reaches process.argv on a real
// macOS login launch, and the legacy `openAsHidden` setting stopped working on macOS 13+. This is
// the one still-functional macOS signal (wasOpenedAtLogin) that main.cjs's startHidden computation
// falls back to; see the "fix(launcher): actually start hidden on a macOS login launch" commit.
test("openedAtLoginOnMac reports true only on macOS when the OS itself launched this app at login", () => {
  withPlatform("darwin", () => {
    assert.equal(
      openedAtLoginOnMac({ getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) }),
      true,
    );
    assert.equal(
      openedAtLoginOnMac({ getLoginItemSettings: () => ({ wasOpenedAtLogin: false }) }),
      false,
    );
    assert.equal(
      openedAtLoginOnMac({ getLoginItemSettings: () => ({}) }),
      false,
    );
  });
});

test("openedAtLoginOnMac never reports true on a platform where args works and wasOpenedAtLogin is macOS-only", () => {
  for (const platform of ["win32", "linux"]) {
    withPlatform(platform, () => {
      assert.equal(
        openedAtLoginOnMac({ getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) }),
        false,
        `${platform} must not consult wasOpenedAtLogin`,
      );
    });
  }
});
