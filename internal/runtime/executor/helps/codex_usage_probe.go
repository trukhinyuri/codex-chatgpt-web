package helps

import (
	"strings"
	"time"

	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/tidwall/gjson"
)

const (
	// codexUsageProbePath is the ChatGPT backend endpoint that reports the
	// current rate-limit windows for a ChatGPT-authenticated Codex account. It is
	// the same endpoint the official Codex client polls for its /status view.
	codexUsageProbePath = "/wham/usage"
	// codexBackendCodexSuffix is the path suffix of the default Codex base URL;
	// the usage endpoint lives one level above it.
	codexBackendCodexSuffix = "/backend-api/codex"
	// codexDefaultBackendBase is the ChatGPT backend root used when a credential
	// carries no custom base URL.
	codexDefaultBackendBase = "https://chatgpt.com/backend-api"
)

// CodexUsageProbeURL derives the account usage endpoint from a Codex credential
// base URL. An empty base URL means the default ChatGPT backend. A custom base
// URL is only accepted when it follows the ChatGPT backend layout
// (…/backend-api/codex), because other upstreams do not expose the endpoint.
func CodexUsageProbeURL(baseURL string) (string, bool) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return codexDefaultBackendBase + codexUsageProbePath, true
	}
	if !strings.HasSuffix(baseURL, codexBackendCodexSuffix) {
		return "", false
	}
	return strings.TrimSuffix(baseURL, "/codex") + codexUsageProbePath, true
}

// ParseCodexUsageProbe converts a /wham/usage payload into a QuotaProbeResult.
//
// Payload shape observed 2026-09:
//
//	{"rate_limit":{"allowed":true,"limit_reached":false,
//	  "primary_window":{"used_percent":9,"reset_at":1789812685,...},
//	  "secondary_window":null},
//	 "model_usage":{"gpt-6-astra":{"available":true,"available_at":null}}, ...}
//
// The credential is available when the top-level rate limit is not reached and
// requests are allowed. When limited, the earliest reset of a window that is
// actually exhausted is reported; windows with headroom are ignored so a short
// 5-hour window cannot mask a longer weekly limit. The boolean ok result is
// false for payloads that do not carry a rate_limit object.
func ParseCodexUsageProbe(body []byte, now time.Time) (cliproxyauth.QuotaProbeResult, bool) {
	if len(body) == 0 || !gjson.ValidBytes(body) {
		return cliproxyauth.QuotaProbeResult{}, false
	}
	root := gjson.ParseBytes(body)
	rateLimit := root.Get("rate_limit")
	if !rateLimit.Exists() || !rateLimit.IsObject() {
		return cliproxyauth.QuotaProbeResult{}, false
	}
	limitReached := rateLimit.Get("limit_reached").Bool()
	allowed := true
	if allowedField := rateLimit.Get("allowed"); allowedField.Exists() {
		allowed = allowedField.Bool()
	}

	result := cliproxyauth.QuotaProbeResult{Available: allowed && !limitReached}
	if !result.Available {
		result.ResetAt = earliestExhaustedCodexWindowReset(rateLimit, now)
	}

	if modelUsage := root.Get("model_usage"); modelUsage.Exists() && modelUsage.IsObject() {
		models := make(map[string]bool)
		modelUsage.ForEach(func(key, value gjson.Result) bool {
			name := strings.TrimSpace(key.String())
			if name == "" || !value.IsObject() {
				return true
			}
			available := value.Get("available")
			if !available.Exists() {
				return true
			}
			models[name] = available.Bool()
			return true
		})
		if len(models) > 0 {
			result.Models = models
		}
	}
	return result, true
}

// earliestExhaustedCodexWindowReset returns the soonest reset time among the
// primary/secondary windows whose used_percent reports exhaustion. When no
// window reports exhaustion but the limit is still flagged as reached, the
// soonest reset of any window is used as a conservative fallback.
func earliestExhaustedCodexWindowReset(rateLimit gjson.Result, now time.Time) time.Time {
	var earliestExhausted, earliestAny time.Time
	consider := func(window gjson.Result) {
		if !window.Exists() || !window.IsObject() {
			return
		}
		resetAt := codexWindowResetTime(window, now)
		if resetAt.IsZero() {
			return
		}
		if earliestAny.IsZero() || resetAt.Before(earliestAny) {
			earliestAny = resetAt
		}
		if window.Get("used_percent").Float() >= 100 {
			if earliestExhausted.IsZero() || resetAt.Before(earliestExhausted) {
				earliestExhausted = resetAt
			}
		}
	}
	consider(rateLimit.Get("primary_window"))
	consider(rateLimit.Get("secondary_window"))
	if !earliestExhausted.IsZero() {
		return earliestExhausted
	}
	return earliestAny
}

func codexWindowResetTime(window gjson.Result, now time.Time) time.Time {
	if resetAt := window.Get("reset_at").Int(); resetAt > 0 {
		return time.Unix(resetAt, 0)
	}
	if resetAfter := window.Get("reset_after_seconds").Int(); resetAfter > 0 {
		return now.Add(time.Duration(resetAfter) * time.Second)
	}
	return time.Time{}
}
