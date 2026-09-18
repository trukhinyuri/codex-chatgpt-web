package executor

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

const claudeUsageProbeExhaustedBody = `{
  "five_hour":{"utilization":100.0,"resets_at":"2099-09-17T00:40:00.478640+00:00","locked_reason":null},
  "seven_day":{"utilization":58.0,"resets_at":"2099-09-18T19:00:00.478667+00:00","locked_reason":null},
  "seven_day_opus":null,"seven_day_sonnet":null}`

func TestClaudeExecutorProbeQuota(t *testing.T) {
	var gotAuth, gotBeta, gotUA string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotBeta = r.Header.Get("anthropic-beta")
		gotUA = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(claudeUsageProbeExhaustedBody))
	}))
	defer server.Close()

	previous := claudeUsageProbeURL
	claudeUsageProbeURL = server.URL + "/api/oauth/usage"
	defer func() { claudeUsageProbeURL = previous }()

	executor := NewClaudeExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{
		ID:       "claude-test",
		Provider: "claude",
		Metadata: map[string]any{"access_token": "sk-ant-oat-test", "email": "test@example.com"},
	}
	result, err := executor.ProbeQuota(context.Background(), auth)
	if err != nil {
		t.Fatalf("ProbeQuota returned error: %v", err)
	}
	if result.Available {
		t.Fatalf("expected exhausted payload to report the credential as limited")
	}
	if result.ResetAt.IsZero() {
		t.Fatalf("expected reset time from the exhausted window")
	}
	if gotAuth != "Bearer sk-ant-oat-test" {
		t.Fatalf("unexpected Authorization header %q", gotAuth)
	}
	if gotBeta != claudeOAuthBeta {
		t.Fatalf("expected anthropic-beta %q, got %q", claudeOAuthBeta, gotBeta)
	}
	if gotUA == "" {
		t.Fatalf("expected a User-Agent header")
	}
}

func TestClaudeExecutorProbeQuotaUnsupported(t *testing.T) {
	executor := NewClaudeExecutor(&config.Config{})
	cases := map[string]*cliproxyauth.Auth{
		"nil auth": nil,
		"api key":  {ID: "k", Provider: "claude", Attributes: map[string]string{"api_key": "sk-ant-api"}},
		"no token": {ID: "n", Provider: "claude", Metadata: map[string]any{"email": "x@example.com"}},
	}
	for name, auth := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := executor.ProbeQuota(context.Background(), auth)
			if !errors.Is(err, cliproxyauth.ErrQuotaProbeUnsupported) {
				t.Fatalf("expected ErrQuotaProbeUnsupported, got %v", err)
			}
		})
	}
}

func TestClaudeExecutorProbeQuotaUpstreamError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	previous := claudeUsageProbeURL
	claudeUsageProbeURL = server.URL
	defer func() { claudeUsageProbeURL = previous }()

	executor := NewClaudeExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{ID: "c", Provider: "claude", Metadata: map[string]any{"access_token": "sk-ant-oat-test"}}
	if _, err := executor.ProbeQuota(context.Background(), auth); err == nil {
		t.Fatalf("expected an error for a non-200 upstream status")
	}
}
