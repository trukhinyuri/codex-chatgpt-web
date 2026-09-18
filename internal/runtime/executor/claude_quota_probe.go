package executor

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	claudeauth "github.com/router-for-me/CLIProxyAPI/v7/internal/auth/claude"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

// claudeUsageProbeMaxBody bounds how much of the usage response is read.
const claudeUsageProbeMaxBody = 256 << 10

// claudeUsageProbeURL is overridable so tests can point the probe at a local
// server; production always uses helps.ClaudeUsageProbeURL.
var claudeUsageProbeURL = helps.ClaudeUsageProbeURL

// ProbeQuota implements cliproxyauth.QuotaProber for Claude.ai OAuth
// credentials. It asks Anthropic's usage endpoint whether the subscription
// windows still have headroom, so the manager can lift a stale quota cooldown
// (for example when a 429 carried a weekly reset while only the five-hour
// window was actually exhausted). API-key credentials are reported as
// unsupported: they have no subscription windows to probe.
func (e *ClaudeExecutor) ProbeQuota(ctx context.Context, auth *cliproxyauth.Auth) (cliproxyauth.QuotaProbeResult, error) {
	if auth == nil {
		return cliproxyauth.QuotaProbeResult{}, cliproxyauth.ErrQuotaProbeUnsupported
	}
	if auth.Attributes != nil && strings.TrimSpace(auth.Attributes["api_key"]) != "" {
		return cliproxyauth.QuotaProbeResult{}, cliproxyauth.ErrQuotaProbeUnsupported
	}
	accessToken := strings.TrimSpace(claudeauth.ReadMetadataString(&auth.Metadata, "access_token"))
	if accessToken == "" {
		return cliproxyauth.QuotaProbeResult{}, cliproxyauth.ErrQuotaProbeUnsupported
	}

	httpReq, errReq := http.NewRequestWithContext(ctx, http.MethodGet, claudeUsageProbeURL, nil)
	if errReq != nil {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("claude quota probe: build request: %w", errReq)
	}
	httpReq.Header.Set("Authorization", "Bearer "+accessToken)
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("anthropic-beta", claudeOAuthBeta)
	userAgent := ""
	if e.cfg != nil {
		userAgent = strings.TrimSpace(e.cfg.ClaudeHeaderDefaults.UserAgent)
	}
	if userAgent == "" {
		userAgent = claudeQuotaProbeUserAgent
	}
	httpReq.Header.Set("User-Agent", userAgent)

	httpClient := helps.NewUtlsHTTPClient(ctx, e.cfg, auth, 0)
	resp, errDo := httpClient.Do(httpReq)
	if errDo != nil {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("claude quota probe: %w", errDo)
	}
	defer func() {
		if errClose := resp.Body.Close(); errClose != nil {
			log.Debugf("claude quota probe: close response body: %v", errClose)
		}
	}()
	body, errRead := io.ReadAll(io.LimitReader(resp.Body, claudeUsageProbeMaxBody))
	if errRead != nil {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("claude quota probe: read response: %w", errRead)
	}
	if resp.StatusCode != http.StatusOK {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("claude quota probe: upstream status %d", resp.StatusCode)
	}
	result, okParse := helps.ParseClaudeUsageProbe(body, time.Now())
	if !okParse {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("claude quota probe: unexpected usage payload")
	}
	return result, nil
}

// claudeQuotaProbeUserAgent is the fallback client identity when no Claude
// header baseline is configured; it mirrors the current Claude Code CLI.
const claudeQuotaProbeUserAgent = "claude-cli/2.1.258 (external, cli)"
