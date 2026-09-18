package antigravity

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The OAuth client is injected at build time; a build without it must refuse Antigravity sign-in
// instead of sending an empty client to Google.
func TestClientNotConfiguredRefusesTokenExchange(t *testing.T) {
	savedID, savedSecret := ClientID, ClientSecret
	t.Cleanup(func() { ClientID, ClientSecret = savedID, savedSecret })

	ClientID, ClientSecret = "", ""
	if ClientConfigured() {
		t.Fatal("ClientConfigured() = true without a client")
	}
	auth := NewAntigravityAuth(nil, nil)
	if _, err := auth.ExchangeCodeForTokens(context.Background(), "code", "http://localhost/cb"); !errors.Is(err, ErrClientNotConfigured) {
		t.Fatalf("ExchangeCodeForTokens error = %v, want ErrClientNotConfigured", err)
	}

	ClientID, ClientSecret = "  ", "secret"
	if ClientConfigured() {
		t.Fatal("ClientConfigured() = true with a blank client ID")
	}

	ClientID, ClientSecret = "test-client.apps.example", "test-secret"
	if !ClientConfigured() {
		t.Fatal("ClientConfigured() = false with a client")
	}
	if url := auth.BuildAuthURL("state", ""); !strings.Contains(url, "client_id=test-client.apps.example") {
		t.Fatalf("BuildAuthURL does not carry the injected client: %s", url)
	}
}
