package helps

import (
	"testing"
	"time"
)

// ClaudeUsageExhaustedPayload mirrors a live /api/oauth/usage answer captured
// 2026-09-16 for a subscription whose five-hour window is exhausted while the
// weekly window still has headroom (identifiers removed).
const ClaudeUsageExhaustedPayload = `{
  "five_hour":{"utilization":100.0,"resets_at":"2026-09-17T00:40:00.478640+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},
  "seven_day":{"utilization":58.0,"resets_at":"2026-09-18T19:00:00.478667+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},
  "seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,"seven_day_cowork":null,
  "nimbus_quill":{"utilization":0.0,"resets_at":null,"limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null}
}`

// ClaudeUsageAvailablePayload is the same account after the five-hour window
// reset.
const ClaudeUsageAvailablePayload = `{
  "five_hour":{"utilization":12.0,"resets_at":"2026-09-17T05:00:00+00:00","locked_reason":null},
  "seven_day":{"utilization":58.0,"resets_at":"2026-09-18T19:00:00+00:00","locked_reason":null},
  "seven_day_opus":{"utilization":100.0,"resets_at":"2026-09-18T19:00:00+00:00","locked_reason":null}
}`

func TestParseClaudeUsageProbe(t *testing.T) {
	now := time.Date(2026, 9, 16, 22, 0, 0, 0, time.UTC)

	t.Run("five hour window exhausted", func(t *testing.T) {
		result, ok := ParseClaudeUsageProbe([]byte(ClaudeUsageExhaustedPayload), now)
		if !ok {
			t.Fatalf("expected payload to parse")
		}
		if result.Available {
			t.Fatalf("expected credential to be limited")
		}
		want := time.Date(2026, 9, 17, 0, 40, 0, 478640000, time.UTC)
		if !result.ResetAt.Equal(want) {
			t.Fatalf("expected five-hour reset %s, got %s", want, result.ResetAt)
		}
		if len(result.Models) != 0 {
			t.Fatalf("expected no model states, got %v", result.Models)
		}
	})

	t.Run("reset already passed counts as available", func(t *testing.T) {
		later := time.Date(2026, 9, 17, 1, 0, 0, 0, time.UTC)
		result, ok := ParseClaudeUsageProbe([]byte(ClaudeUsageExhaustedPayload), later)
		if !ok {
			t.Fatalf("expected payload to parse")
		}
		if !result.Available {
			t.Fatalf("expected credential to be available once the window reset passed")
		}
	})

	t.Run("model window keeps only that family cooled", func(t *testing.T) {
		result, ok := ParseClaudeUsageProbe([]byte(ClaudeUsageAvailablePayload), now)
		if !ok {
			t.Fatalf("expected payload to parse")
		}
		if !result.Available {
			t.Fatalf("expected credential to be available, got reset %s", result.ResetAt)
		}
		if available, present := result.Models["claude-opus"]; !present || available {
			t.Fatalf("expected claude-opus to stay unavailable, got %v", result.Models)
		}
	})

	t.Run("locked window is exhausted", func(t *testing.T) {
		body := `{"five_hour":{"utilization":3.0,"resets_at":"2026-09-17T03:00:00+00:00","locked_reason":"overage"}}`
		result, ok := ParseClaudeUsageProbe([]byte(body), now)
		if !ok || result.Available {
			t.Fatalf("expected locked window to make the credential unavailable (ok=%v, result=%+v)", ok, result)
		}
	})

	t.Run("unknown payload", func(t *testing.T) {
		if _, ok := ParseClaudeUsageProbe([]byte(`{"error":"nope"}`), now); ok {
			t.Fatalf("expected payload without windows to be rejected")
		}
		if _, ok := ParseClaudeUsageProbe([]byte(`not json`), now); ok {
			t.Fatalf("expected invalid JSON to be rejected")
		}
	})
}
