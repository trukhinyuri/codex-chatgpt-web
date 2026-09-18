package executor

import antigravityauth "github.com/router-for-me/CLIProxyAPI/v7/internal/auth/antigravity"

// The Antigravity OAuth client is injected at build time. These tests talk to fake token endpoints,
// so a stand-in client is enough.
func init() {
	if !antigravityauth.ClientConfigured() {
		antigravityauth.ClientID = "test-client.apps.example"
		antigravityauth.ClientSecret = "test-secret"
	}
}
