# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
Codex prompts, tool results, or local filesystem paths. Redact diagnostic bundles before sharing.

The daemon binds only to loopback. If another local user can access your account or application
home, treat the browser session and tunnel key as compromised and rotate them.

Read the complete [security model](docs/security-model.md) before enabling full mode. In particular,
full mode lets an untrusted model response request tools from the current Codex turn; keep connector
action control, Codex sandboxing, and approvals aligned with the workspace's risk.

The stable MCP v1 SDK currently declares the vulnerable `@hono/node-server` 1.x range even though
this project uses only its stdio transport. The lockfile explicitly resolves that unused HTTP
adapter to patched 2.0.12. `bun audit`, the MCP protocol test, and the compiled-binary smoke test are
release gates; remove the override when the stable SDK itself moves to the patched major.

## Reporting a vulnerability

Report vulnerabilities privately, never in a public issue, pull request or discussion:

- GitHub private advisory: <https://github.com/trukhinyuri/codex-superpower/security/advisories/new>
- E-mail: Yuri Trukhin, <yuri@trukhin.com>

The e-mail address always works; use it if GitHub does not offer the advisory form. Describe the
affected version (**Codex Superpower → About**) and the steps to reproduce, and leave out real
credentials, cookies, tunnel IDs and prompts. Do not publish a proof of concept that exposes
credentials or arbitrary local tool execution before a fix is released.
