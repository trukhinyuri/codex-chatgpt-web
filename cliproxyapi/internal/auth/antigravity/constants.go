// Package antigravity provides OAuth2 authentication functionality for the Antigravity provider.
package antigravity

import (
	"errors"
	"strings"
)

// OAuth client credentials of the public Antigravity desktop client. They are not stored in this
// source tree: the build sets them with
//
//	-ldflags "-X github.com/router-for-me/CLIProxyAPI/v7/internal/auth/antigravity.ClientID=...
//	          -X github.com/router-for-me/CLIProxyAPI/v7/internal/auth/antigravity.ClientSecret=..."
//
// A build without them serves every other provider; Antigravity sign-in and token refresh report
// ErrClientNotConfigured instead of sending an empty client to Google.
var (
	ClientID     string
	ClientSecret string
)

// CallbackPort is the local port of the OAuth redirect.
const CallbackPort = 51121

// ErrClientNotConfigured reports a build that was made without the Antigravity OAuth client.
var ErrClientNotConfigured = errors.New("antigravity: this build has no OAuth client; rebuild with the Antigravity client ID and secret")

// ClientConfigured reports whether the build carries the Antigravity OAuth client.
func ClientConfigured() bool {
	return strings.TrimSpace(ClientID) != "" && strings.TrimSpace(ClientSecret) != ""
}

// Scopes defines the OAuth scopes required for Antigravity authentication
var Scopes = []string{
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
}

// OAuth2 endpoints for Google authentication
const (
	TokenEndpoint    = "https://oauth2.googleapis.com/token"
	AuthEndpoint     = "https://accounts.google.com/o/oauth2/v2/auth"
	UserInfoEndpoint = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json"
)

// Antigravity API configuration
const (
	APIEndpoint      = "https://cloudcode-pa.googleapis.com"
	DailyAPIEndpoint = "https://daily-cloudcode-pa.googleapis.com"
	APIVersion       = "v1internal"
)
