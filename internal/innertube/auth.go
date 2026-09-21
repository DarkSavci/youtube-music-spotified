package innertube

import (
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Credentials is the user's YouTube Music authentication material.
//
// It never leaves the Device. No server endpoint accepts it, and it is not
// carried on any request routed through the Catalog or Control planes.
type Credentials struct {
	// Cookie is the raw Cookie header value from a signed-in session.
	Cookie string `json:"cookie"`

	// Extra carries any additional headers captured alongside the cookie,
	// such as x-goog-authuser for brand accounts. Keys are lower-cased.
	Extra map[string]string `json:"extra,omitempty"`

	mu sync.RWMutex
}

// LoadCredentials reads Credentials from a local file.
//
// The file is either {"cookie": "...", "extra": {...}} or a flat header map
// with a "cookie" key, which is the shape browser export tooling produces.
func LoadCredentials(path string) (*Credentials, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read credentials: %w", err)
	}
	var c Credentials
	if err := json.Unmarshal(b, &c); err == nil && c.Cookie != "" {
		return &c, nil
	}
	// Fall back to a flat header map.
	var flat map[string]string
	if err := json.Unmarshal(b, &flat); err != nil {
		return nil, fmt.Errorf("parse credentials: %w", err)
	}
	lower := make(map[string]string, len(flat))
	for k, v := range flat {
		lower[strings.ToLower(k)] = v
	}
	cookie := lower["cookie"]
	if cookie == "" {
		return nil, fmt.Errorf("credentials contain no cookie")
	}
	delete(lower, "cookie")
	return &Credentials{Cookie: cookie, Extra: lower}, nil
}

// cookie returns the Cookie header value, ensuring the cookie-consent value is
// present. Without SOCS some responses are served in a degraded consent mode.
func (c *Credentials) cookie() string {
	if c == nil {
		return socsOnly
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.Cookie == "" {
		return socsOnly
	}
	if strings.Contains(c.Cookie, "SOCS=") {
		return c.Cookie
	}
	return c.Cookie + "; " + socsOnly
}

const socsOnly = "SOCS=CAI"

// sapisid extracts the session identifier the request signature is computed
// over. YouTube issues several equivalent variants; any one will do.
func (c *Credentials) sapisid() string {
	if c == nil {
		return ""
	}
	c.mu.RLock()
	raw := c.Cookie
	c.mu.RUnlock()

	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		for _, name := range []string{"__Secure-3PAPISID=", "__Secure-1PAPISID=", "SAPISID="} {
			if after, ok := strings.CutPrefix(part, name); ok && after != "" {
				return after
			}
		}
	}
	return ""
}

// authorization computes the per-request SAPISIDHASH.
//
// The hash covers a timestamp, the session identifier, and the origin — so it
// must be recomputed for every request, and an origin mismatch fails
// authorization even with a valid cookie.
func (c *Credentials) authorization(origin string) string {
	sid := c.sapisid()
	if sid == "" {
		return ""
	}
	ts := time.Now().Unix()
	sum := sha1.Sum([]byte(fmt.Sprintf("%d %s %s", ts, sid, origin)))
	return fmt.Sprintf("SAPISIDHASH %d_%x", ts, sum)
}

// authenticated reports whether these Credentials look usable at all. It is a
// shape check, not a liveness check — use Client.SessionState for that.
func (c *Credentials) authenticated() bool {
	return c != nil && c.sapisid() != "" && strings.Contains(c.Cookie, "LOGIN_INFO=")
}

// Update replaces the cookie, for when a session is re-captured after expiry.
func (c *Credentials) Update(cookie string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Cookie = cookie
}
