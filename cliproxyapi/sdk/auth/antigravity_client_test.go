package auth

import "github.com/router-for-me/CLIProxyAPI/v7/internal/auth/antigravity"

// The Antigravity OAuth client is injected at build time. These tests talk to a fake token endpoint,
// so a stand-in client is enough.
func init() {
	if !antigravity.ClientConfigured() {
		antigravity.ClientID = "test-client.apps.example"
		antigravity.ClientSecret = "test-secret"
	}
}
