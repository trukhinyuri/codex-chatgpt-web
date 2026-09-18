package executor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

const codexUsageProbeAvailableBody = `{"plan_type":"pro",
  "rate_limit":{"allowed":true,"limit_reached":false,
    "primary_window":{"used_percent":9,"limit_window_seconds":604800,"reset_after_seconds":512493,"reset_at":1789812685},
    "secondary_window":null},
  "model_usage":{"gpt-6-astra":{"available":true,"available_at":null,"credits_would_enable":false}}}`

func TestCodexExecutorProbeQuota(t *testing.T) {
	var gotAuth, gotAccount, gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAccount = r.Header.Get("Chatgpt-Account-Id")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(codexUsageProbeAvailableBody))
	}))
	defer server.Close()

	executor := NewCodexExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{
		ID:       "codex-test",
		Provider: "codex",
		Attributes: map[string]string{
			"base_url": server.URL + "/backend-api/codex",
		},
		Metadata: map[string]any{
			"access_token": "token-123",
			"account_id":   "acct-test",
			"type":         "codex",
		},
	}
	result, err := executor.ProbeQuota(context.Background(), auth)
	if err != nil {
		t.Fatalf("probe quota: %v", err)
	}
	if !result.Available {
		t.Fatalf("expected available credential")
	}
	if got := result.Models["gpt-6-astra"]; !got {
		t.Fatalf("expected model availability to be forwarded, got %#v", result.Models)
	}
	if gotPath != "/backend-api/wham/usage" {
		t.Fatalf("unexpected probe path %q", gotPath)
	}
	if gotAuth != "Bearer token-123" {
		t.Fatalf("unexpected authorization header %q", gotAuth)
	}
	if gotAccount != "acct-test" {
		t.Fatalf("unexpected account header %q", gotAccount)
	}
	if _, ok := any(executor).(cliproxyauth.QuotaProber); !ok {
		t.Fatalf("codex executor must implement QuotaProber")
	}
}

func TestCodexExecutorProbeQuotaUpstreamErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Header.Get("Authorization") {
		case "Bearer expired":
			w.WriteHeader(http.StatusUnauthorized)
		default:
			_, _ = w.Write([]byte(`{"unexpected":true}`))
		}
	}))
	defer server.Close()

	executor := NewCodexExecutor(&config.Config{})
	for name, token := range map[string]string{"upstream status": "expired", "unexpected payload": "ok"} {
		t.Run(name, func(t *testing.T) {
			auth := &cliproxyauth.Auth{
				ID: "codex-" + token, Provider: "codex",
				Attributes: map[string]string{"base_url": server.URL + "/backend-api/codex"},
				Metadata:   map[string]any{"access_token": token, "type": "codex"},
			}
			if _, err := executor.ProbeQuota(context.Background(), auth); err == nil {
				t.Fatalf("expected probe error")
			} else if err == cliproxyauth.ErrQuotaProbeUnsupported {
				t.Fatalf("upstream failures must not be reported as unsupported")
			}
		})
	}
}

func TestCodexExecutorProbeQuotaUnsupported(t *testing.T) {
	executor := NewCodexExecutor(&config.Config{})
	for name, auth := range map[string]*cliproxyauth.Auth{
		"nil auth": nil,
		"api key credential": {
			ID: "codex-key", Provider: "codex",
			Attributes: map[string]string{"api_key": "sk-test", "base_url": "https://api.example.com/v1"},
		},
		"missing access token": {
			ID: "codex-empty", Provider: "codex",
			Metadata: map[string]any{"type": "codex"},
		},
		"custom upstream without usage endpoint": {
			ID: "codex-custom", Provider: "codex",
			Attributes: map[string]string{"base_url": "https://mirror.example.com/v1"},
			Metadata:   map[string]any{"access_token": "token", "type": "codex"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := executor.ProbeQuota(context.Background(), auth); err != cliproxyauth.ErrQuotaProbeUnsupported {
				t.Fatalf("expected ErrQuotaProbeUnsupported, got %v", err)
			}
		})
	}
}
