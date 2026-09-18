package executor

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

// codexUsageProbeMaxBody bounds how much of the usage response is read.
const codexUsageProbeMaxBody = 256 << 10

// ProbeQuota implements cliproxyauth.QuotaProber for ChatGPT OAuth credentials.
// It asks the ChatGPT backend whether the account's rate limit is currently
// reached, so the manager can lift a stale quota cooldown (for example after the
// user purchased a limit reset). API-key credentials and custom upstreams
// without the ChatGPT backend layout are reported as unsupported.
func (e *CodexExecutor) ProbeQuota(ctx context.Context, auth *cliproxyauth.Auth) (cliproxyauth.QuotaProbeResult, error) {
	if auth == nil || codexAuthUsesAPIKey(auth) {
		return cliproxyauth.QuotaProbeResult{}, cliproxyauth.ErrQuotaProbeUnsupported
	}
	accessToken, baseURL := codexCreds(auth)
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return cliproxyauth.QuotaProbeResult{}, cliproxyauth.ErrQuotaProbeUnsupported
	}
	usageURL, ok := helps.CodexUsageProbeURL(baseURL)
	if !ok {
		return cliproxyauth.QuotaProbeResult{}, cliproxyauth.ErrQuotaProbeUnsupported
	}

	httpReq, errReq := http.NewRequestWithContext(ctx, http.MethodGet, usageURL, nil)
	if errReq != nil {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("codex quota probe: build request: %w", errReq)
	}
	httpReq.Header.Set("Authorization", "Bearer "+accessToken)
	httpReq.Header.Set("Accept", "application/json")
	cfgUserAgent, _ := codexHeaderDefaults(e.cfg, auth)
	ensureHeaderWithConfigPrecedence(httpReq.Header, nil, "User-Agent", cfgUserAgent, codexUserAgent)
	httpReq.Header.Set("Originator", codexOriginator)
	if auth.Metadata != nil {
		if accountID, okAccount := auth.Metadata["account_id"].(string); okAccount && strings.TrimSpace(accountID) != "" {
			httpReq.Header.Set("Chatgpt-Account-Id", accountID)
		}
	}
	applyCodexCloakingHeaders(httpReq.Header, e.cfg)

	httpClient := helps.NewUtlsHTTPClient(ctx, e.cfg, auth, 0)
	resp, errDo := httpClient.Do(httpReq)
	if errDo != nil {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("codex quota probe: %w", errDo)
	}
	defer func() {
		if errClose := resp.Body.Close(); errClose != nil {
			log.Debugf("codex quota probe: close response body: %v", errClose)
		}
	}()
	body, errRead := io.ReadAll(io.LimitReader(resp.Body, codexUsageProbeMaxBody))
	if errRead != nil {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("codex quota probe: read response: %w", errRead)
	}
	if resp.StatusCode != http.StatusOK {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("codex quota probe: upstream status %d", resp.StatusCode)
	}
	result, okParse := helps.ParseCodexUsageProbe(body, time.Now())
	if !okParse {
		return cliproxyauth.QuotaProbeResult{}, fmt.Errorf("codex quota probe: unexpected usage payload")
	}
	return result, nil
}
