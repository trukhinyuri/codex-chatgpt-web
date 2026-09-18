# Competitive analysis

Kept current every release cycle (see [engineering-process.md](engineering-process.md#staying-ahead) and requirement R10). The first full review is in progress; until it lands, this table records what is known.

| Parameter | Codex Superpower | codex-chatgpt-web (upstream) | CLIProxyAPI (upstream) |
| --- | --- | --- | --- |
| Routes in one Codex model list | ChatGPT Web, native OpenAI, CLIProxyAPI providers | ChatGPT Web, native OpenAI | Provider accounts (no ChatGPT Web) |
| Codex keeps its OpenAI provider and features | Yes (bridge on `openai_base_url`) | Yes | No, when used as a custom provider |
| Self-update | From `main`, CI-gated, full tests on the user's Mac, health check, automatic rollback, private build home | Release installer | Manual |
| Delivers fixes to a failing installation | Yes (one quiet minute when turns only fail) | No | No |
| Invalid proxy model cannot empty the catalog | Yes | Not applicable | Not applicable |
| Secrets in the source tree | None (pinned build-time inputs) | None | Antigravity OAuth client embedded |
| Problem reports | Automatic, consent-based, closed allowlists, no user data | Manual issues | Manual issues |

Ported from upstream pull requests and forks so far: about 30 fixes (see [roadmap.md](roadmap.md) and the git history of releases R6–R8).
