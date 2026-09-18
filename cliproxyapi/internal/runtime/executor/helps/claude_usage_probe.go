package helps

import (
	"strings"
	"time"

	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/tidwall/gjson"
)

// ClaudeUsageProbeURL is the Anthropic OAuth endpoint that reports the
// subscription rate-limit windows for a Claude.ai account. It is the same
// endpoint the official Claude Code client polls for its /usage view.
const ClaudeUsageProbeURL = "https://api.anthropic.com/api/oauth/usage"

// claudeUsageWindows lists the unified rate-limit windows carried by the usage
// payload. Every window that is present and exhausted makes the credential
// unavailable; model-scoped windows (opus/sonnet) are mapped to model families
// so an exhausted Opus window keeps only Opus models cooled down.
var claudeUsageWindows = []struct {
	key         string
	modelPrefix string
}{
	{key: "five_hour"},
	{key: "seven_day"},
	{key: "seven_day_oauth_apps"},
	{key: "seven_day_opus", modelPrefix: "claude-opus"},
	{key: "seven_day_sonnet", modelPrefix: "claude-sonnet"},
}

// ParseClaudeUsageProbe converts an /api/oauth/usage payload into a
// QuotaProbeResult.
//
// Payload shape observed 2026-09:
//
//	{"five_hour":{"utilization":100.0,"resets_at":"2026-09-17T00:40:00.478640+00:00",...},
//	 "seven_day":{"utilization":58.0,"resets_at":"2026-09-18T19:00:00.478667+00:00",...},
//	 "seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,...}
//
// A window counts as exhausted when its utilization reaches 100 percent (or it
// carries a locked_reason) and its reset time is still in the future; a window
// whose reset already passed is treated as free. The credential is available
// when no account-wide window is exhausted. When limited, the earliest reset
// among the exhausted windows is reported. The boolean ok result is false for
// payloads that carry none of the known windows.
func ParseClaudeUsageProbe(body []byte, now time.Time) (cliproxyauth.QuotaProbeResult, bool) {
	if len(body) == 0 || !gjson.ValidBytes(body) {
		return cliproxyauth.QuotaProbeResult{}, false
	}
	root := gjson.ParseBytes(body)
	if !root.IsObject() {
		return cliproxyauth.QuotaProbeResult{}, false
	}

	known := 0
	accountAvailable := true
	var earliestReset time.Time
	models := make(map[string]bool)
	for _, window := range claudeUsageWindows {
		value := root.Get(window.key)
		if !value.Exists() || !value.IsObject() {
			continue
		}
		known++
		exhausted, resetAt := claudeWindowExhausted(value, now)
		if !exhausted {
			continue
		}
		if window.modelPrefix != "" {
			models[window.modelPrefix] = false
			continue
		}
		accountAvailable = false
		if !resetAt.IsZero() && (earliestReset.IsZero() || resetAt.Before(earliestReset)) {
			earliestReset = resetAt
		}
	}
	if known == 0 {
		return cliproxyauth.QuotaProbeResult{}, false
	}

	result := cliproxyauth.QuotaProbeResult{Available: accountAvailable}
	if !accountAvailable {
		result.ResetAt = earliestReset
	}
	if len(models) > 0 {
		result.Models = models
	}
	return result, true
}

// claudeWindowExhausted reports whether one usage window blocks requests and
// when it resets. A window with a reset time in the past is never exhausted,
// regardless of the stale utilization it may still carry.
func claudeWindowExhausted(window gjson.Result, now time.Time) (bool, time.Time) {
	resetAt := claudeWindowResetTime(window)
	if !resetAt.IsZero() && !resetAt.After(now) {
		return false, time.Time{}
	}
	locked := strings.TrimSpace(window.Get("locked_reason").String()) != ""
	if window.Get("utilization").Float() >= 100 || locked {
		return true, resetAt
	}
	return false, time.Time{}
}

func claudeWindowResetTime(window gjson.Result) time.Time {
	raw := strings.TrimSpace(window.Get("resets_at").String())
	if raw == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed
		}
	}
	return time.Time{}
}
