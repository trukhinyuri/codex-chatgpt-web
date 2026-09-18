// Electron builds the User-Agent of every page the launcher's browser opens from the app name without
// spaces and the app version, next to the Chrome and Electron versions:
//   Mozilla/5.0 (Macintosh; …) AppleWebKit/537.36 (KHTML, like Gecko) CodexWebGPT/5.0.8 Chrome/… Electron/… Safari/537.36
// app.setName("Codex Superpower") would turn that product token into CodexSuperpower. chatgpt.com is
// behind Cloudflare, which binds its clearance cookie to the User-Agent: a different one makes it
// challenge the browser again, and a turn running at that moment can fail. So the embedded browser
// keeps the product token it has always sent. Only that token is replaced; the Chrome and Electron
// tokens and everything else stay, and the browser remains exactly as identifiable as this Electron
// app as before (docs/requirements.md R7.5).

/** The token Electron derives from an app name: the name without spaces. */
function userAgentProductToken(appName) {
  return String(appName || "").replace(/ /g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `userAgent` with the product token of `appName` replaced by that of `userAgentName`. A User-Agent
 * without that token (set elsewhere, or built differently by a future Electron) is returned unchanged.
 */
function keepUserAgentProduct(userAgent, { appName, userAgentName }) {
  const current = userAgentProductToken(appName);
  const kept = userAgentProductToken(userAgentName);
  if (typeof userAgent !== "string" || !current || !kept || current === kept) return userAgent;
  const token = new RegExp(`(^| )${escapeRegExp(current)}/(?=\\S)`);
  return token.test(userAgent) ? userAgent.replace(token, `$1${kept}/`) : userAgent;
}

module.exports = {
  keepUserAgentProduct,
  userAgentProductToken,
};
