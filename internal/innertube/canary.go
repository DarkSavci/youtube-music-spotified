package innertube

import (
	"context"
	"encoding/json"
	"errors"
)

// SessionState is the result of a liveness check on the attached Credentials.
type SessionState string

const (
	// SignedIn means the account header parsed: the session is live.
	SignedIn SessionState = "signed_in"

	// LoggedOut means the server answered normally but served logged-out
	// content. This is the Silent logout case and the reason a status-code
	// check is not sufficient.
	LoggedOut SessionState = "logged_out"

	// Unknown means we could not tell — a network failure, a timeout, a
	// malformed response. Callers must treat this as "probably fine" rather
	// than prompting for re-authentication.
	Unknown SessionState = "unknown"
)

// Account identifies the signed-in user.
type Account struct {
	Name      string `json:"name"`
	Handle    string `json:"handle,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// SessionState checks whether the attached Credentials still authenticate.
//
// Expired Credentials do not produce an auth error. YouTube answers HTTP 200
// and serves logged-out content, so liveness can only be established by
// inspecting the response's shape — hence this canary rather than a status
// check anywhere else in the codebase.
//
// The three-state result is deliberate. Collapsing Unknown into LoggedOut would
// tell an offline user their session expired and send them through a needless
// re-login; collapsing it into SignedIn would hide a real expiry. Callers that
// prompt for re-authentication must act only on LoggedOut.
//
// Note: this endpoint carries no subscription information. Premium status is
// determined from the audio formats a player response offers, not from here.
func (c *Client) SessionState(ctx context.Context) (SessionState, *Account, error) {
	if !c.creds.authenticated() {
		return LoggedOut, nil, nil
	}

	raw, err := c.Call(ctx, "account/account_menu", map[string]any{})
	if err != nil {
		var he *HTTPError
		if errors.As(err, &he) && (he.Status == 401 || he.Status == 403) {
			return LoggedOut, nil, nil
		}
		// Network failure, timeout, 5xx: cannot verify, so do not claim expiry.
		return Unknown, nil, err
	}

	acct := parseAccount(raw)
	if acct == nil {
		return LoggedOut, nil, nil
	}
	return SignedIn, acct, nil
}

// parseAccount walks to the active account header. Its absence in an otherwise
// valid response is the logged-out signal.
//
// The search is structural rather than path-based: the header's position in the
// response has moved before and the exact nesting is not load-bearing.
func parseAccount(raw json.RawMessage) *Account {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	node := findNode(doc, "activeAccountHeaderRenderer")
	if node == nil {
		return nil
	}
	name := runsText(node["accountName"])
	if name == "" {
		return nil
	}
	return &Account{
		Name:      name,
		Handle:    runsText(node["channelHandle"]),
		AvatarURL: firstThumbnail(node["accountPhoto"]),
	}
}

// findNode searches a decoded JSON tree for the first object under the given
// key, at any depth.
func findNode(v any, key string) map[string]any {
	switch t := v.(type) {
	case map[string]any:
		if hit, ok := t[key].(map[string]any); ok {
			return hit
		}
		for _, sub := range t {
			if found := findNode(sub, key); found != nil {
				return found
			}
		}
	case []any:
		for _, sub := range t {
			if found := findNode(sub, key); found != nil {
				return found
			}
		}
	}
	return nil
}

// runsText reads the {"runs":[{"text":...}]} or {"simpleText":...} idiom,
// returning empty rather than failing on an unexpected shape.
func runsText(v any) string {
	node, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	if s, ok := node["simpleText"].(string); ok {
		return s
	}
	runs, ok := node["runs"].([]any)
	if !ok || len(runs) == 0 {
		return ""
	}
	first, ok := runs[0].(map[string]any)
	if !ok {
		return ""
	}
	s, _ := first["text"].(string)
	return s
}

// firstThumbnail reads the smallest image URL out of a thumbnail container.
func firstThumbnail(v any) string {
	node, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	thumbs, ok := node["thumbnails"].([]any)
	if !ok || len(thumbs) == 0 {
		return ""
	}
	first, ok := thumbs[0].(map[string]any)
	if !ok {
		return ""
	}
	s, _ := first["url"].(string)
	return s
}
