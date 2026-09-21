package innertube

import (
	"fmt"
	"os"
	"strings"
)

/*
Netscape cookie export.

yt-dlp takes cookies as a file, not as a header, and applies them to the player
request the way a browser would. That is what reaches the subscriber-only audio
tiers: the pure-Go extractor drives its own client identity and turns a working
stream into a 403 when the same cookies are folded into it.

The file is the credential in plain text, so it is written with owner-only
permissions to a caller-chosen path — in practice a temporary directory the
process cleans up — and never to the project or to anywhere shareable.
*/

// WriteCookieFile writes the credentials as a Netscape cookie file and returns
// the number of cookies written.
//
// The format is positional and unforgiving: seven tab-separated fields, with a
// leading "#HttpOnly_" prefix being the only decoration any reader accepts.
func WriteCookieFile(c *Credentials, path string) (int, error) {
	if c == nil {
		return 0, fmt.Errorf("cookie file: no credentials")
	}
	c.mu.RLock()
	header := c.Cookie
	c.mu.RUnlock()
	if header == "" {
		return 0, fmt.Errorf("cookie file: credentials carry no cookie")
	}

	var b strings.Builder
	b.WriteString("# Netscape HTTP Cookie File\n")
	b.WriteString("# Written by spotifier. Contains a live session.\n")

	n := 0
	for _, pair := range strings.Split(header, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if !ok || name == "" {
			continue
		}
		// domain, includeSubdomains, path, secure, expiry, name, value.
		// A far-future expiry: these are session cookies whose real lifetime
		// is decided upstream, and an expired line is simply ignored.
		fmt.Fprintf(&b, ".youtube.com\tTRUE\t/\tTRUE\t2147483647\t%s\t%s\n", name, value)
		n++
	}
	if n == 0 {
		return 0, fmt.Errorf("cookie file: no cookies parsed from header")
	}

	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		return 0, fmt.Errorf("cookie file: %w", err)
	}
	return n, nil
}
