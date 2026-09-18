package helps

import (
	"testing"
	"time"
)

// CodexUsageAvailablePayload mirrors a live /wham/usage answer for a Pro
// account with headroom (identifiers replaced). It is shared with the executor
// tests.
const CodexUsageAvailablePayload = `{
  "user_id": "user-test", "account_id": "acct-test", "email": "test@example.com", "plan_type": "pro",
  "rate_limit": {"allowed": true, "limit_reached": false,
    "primary_window": {"used_percent": 9, "limit_window_seconds": 604800, "reset_after_seconds": 512493, "reset_at": 1789812685},
    "secondary_window": null},
  "code_review_rate_limit": null,
  "additional_rate_limits": [{"limit_name": "GPT-5.3-Codex-Spark", "metered_feature": "codex_bengalfox",
    "rate_limit": {"allowed": true, "limit_reached": false,
      "primary_window": {"used_percent": 0, "limit_window_seconds": 18000, "reset_after_seconds": 18000, "reset_at": 1789318192},
      "secondary_window": {"used_percent": 0, "limit_window_seconds": 604800, "reset_after_seconds": 604800, "reset_at": 1789904992}},
    "normal_model_slug": null}],
  "model_usage": {"gpt-6-astra": {"available": true, "available_at": null, "credits_would_enable": false}},
  "credits": {"has_credits": false, "unlimited": false, "overage_limit_reached": false, "balance": "0"},
  "spend_control": {"reached": false, "individual_limit": null},
  "rate_limit_reached_type": null, "promo": null,
  "rate_limit_reset_credits": {"available_count": 0, "applicable_available_count": 0}
}`

func TestParseCodexUsageProbe(t *testing.T) {
	now := time.Unix(1789300000, 0)
	t.Run("available account", func(t *testing.T) {
		result, ok := ParseCodexUsageProbe([]byte(CodexUsageAvailablePayload), now)
		if !ok {
			t.Fatalf("expected payload to parse")
		}
		if !result.Available {
			t.Fatalf("expected credential to be available")
		}
		if !result.ResetAt.IsZero() {
			t.Fatalf("expected no reset time for available credential, got %s", result.ResetAt)
		}
		if got := result.Models["gpt-6-astra"]; !got {
			t.Fatalf("expected gpt-6-astra to be reported available, got %#v", result.Models)
		}
	})

	t.Run("limit reached reports exhausted window reset", func(t *testing.T) {
		payload := `{"rate_limit":{"allowed":false,"limit_reached":true,
		  "primary_window":{"used_percent":12,"reset_at":1789310000},
		  "secondary_window":{"used_percent":100,"reset_at":1789400000}},
		  "model_usage":{"gpt-6-astra":{"available":false,"available_at":1789400000}}}`
		result, ok := ParseCodexUsageProbe([]byte(payload), now)
		if !ok {
			t.Fatalf("expected payload to parse")
		}
		if result.Available {
			t.Fatalf("expected credential to be limited")
		}
		if want := time.Unix(1789400000, 0); !result.ResetAt.Equal(want) {
			t.Fatalf("expected reset of the exhausted weekly window %s, got %s", want, result.ResetAt)
		}
		if available, present := result.Models["gpt-6-astra"]; !present || available {
			t.Fatalf("expected gpt-6-astra to be reported unavailable, got %#v", result.Models)
		}
	})

	t.Run("limit reached without exhausted window falls back to earliest reset", func(t *testing.T) {
		payload := `{"rate_limit":{"limit_reached":true,
		  "primary_window":{"used_percent":95,"reset_after_seconds":600},
		  "secondary_window":{"used_percent":40,"reset_at":1789400000}}}`
		result, ok := ParseCodexUsageProbe([]byte(payload), now)
		if !ok {
			t.Fatalf("expected payload to parse")
		}
		if result.Available {
			t.Fatalf("expected credential to be limited")
		}
		if want := now.Add(600 * time.Second); !result.ResetAt.Equal(want) {
			t.Fatalf("expected reset %s, got %s", want, result.ResetAt)
		}
	})

	t.Run("rejects payloads without rate limit", func(t *testing.T) {
		for _, body := range []string{"", "not json", `{"ok":true}`, `{"rate_limit":"x"}`} {
			if _, ok := ParseCodexUsageProbe([]byte(body), now); ok {
				t.Fatalf("expected %q to be rejected", body)
			}
		}
	})
}

func TestCodexUsageProbeURL(t *testing.T) {
	for _, test := range []struct {
		base string
		want string
		ok   bool
	}{
		{base: "", want: "https://chatgpt.com/backend-api/wham/usage", ok: true},
		{base: "https://chatgpt.com/backend-api/codex", want: "https://chatgpt.com/backend-api/wham/usage", ok: true},
		{base: "https://chatgpt.com/backend-api/codex/", want: "https://chatgpt.com/backend-api/wham/usage", ok: true},
		{base: "https://mirror.example.com/backend-api/codex", want: "https://mirror.example.com/backend-api/wham/usage", ok: true},
		{base: "https://api.example.com/v1", ok: false},
	} {
		got, ok := CodexUsageProbeURL(test.base)
		if ok != test.ok || got != test.want {
			t.Fatalf("CodexUsageProbeURL(%q) = (%q, %v), want (%q, %v)", test.base, got, ok, test.want, test.ok)
		}
	}
}
