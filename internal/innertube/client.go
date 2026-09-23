// Package innertube is the transport to YouTube Music's private JSON API.
//
// It is a shared internal module: catalog, identity and resolver all build on
// it. It is not a Plane and appears in no public interface — callers outside
// those three should be talking to a domain module instead.
//
// The package deliberately returns raw JSON. Translating renderer nodes into
// domain types is the renderers package's job, and keeping the two separate
// means transport can be exercised against recorded responses.
package innertube

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	// Origin is the value request signatures are computed over. A signature
	// computed for a different origin will not authorize, even with valid
	// Credentials.
	Origin = "https://music.youtube.com"

	// ClientName identifies the YouTube Music web client.
	ClientName = "WEB_REMIX"

	defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

	// configTTL bounds how long a scraped config is reused. The client version
	// changes on YouTube's release cadence; a stale one is tolerated by the
	// server for a while but not indefinitely.
	configTTL = 6 * time.Hour
)

// Config is the per-session configuration scraped from the web client.
//
// None of it is secret: the API key is the public web-client key, identical
// for every user. It is scraped rather than hardcoded so that a rotation does
// not require shipping a new build.
type Config struct {
	APIKey        string
	ClientVersion string
	VisitorData   string
	scrapedAt     time.Time
}

// Client performs InnerTube calls.
//
// The zero value is not usable; construct with New. A Client is safe for
// concurrent use.
type Client struct {
	http      *http.Client
	creds     *Credentials
	userAgent string
	language  string
	region    string

	mu  sync.RWMutex
	cfg *Config
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient injects the transport. Tests use this to serve recorded
// responses; production leaves it alone.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.http = h }
}

// WithCredentials attaches a signed-in session. Without it the Client makes
// signed-out calls, which is correct for the Catalog plane.
func WithCredentials(creds *Credentials) Option {
	return func(c *Client) { c.creds = creds }
}

// WithLocale sets the language and region sent in the request context. These
// also form part of every cache key upstream of this package.
func WithLocale(language, region string) Option {
	return func(c *Client) { c.language, c.region = language, region }
}

// New builds a Client.
func New(opts ...Option) *Client {
	c := &Client{
		http:      &http.Client{Timeout: 30 * time.Second},
		userAgent: defaultUserAgent,
		language:  "en",
		region:    "US",
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// Authenticated reports whether Credentials are attached and well-formed. It
// does not prove the session is live — see SessionState.
func (c *Client) Authenticated() bool { return c.creds.authenticated() }

/*
GetSigned performs a plain authenticated GET.

YouTube's playback reporting does not go through InnerTube: the player
response hands out pre-signed URLs on s.youtube.com and the client pings them
directly. They carry their own parameters and need only the session cookies,
so this is deliberately thin — no JSON body, no client context, no parsing.

The one thing added is the client's identity. The signed URLs do not say which
player they were issued to, and a ping that does not name one is attributed to
plain YouTube — so the play lands in YouTube's watch history rather than
YouTube Music's. YouTube Music's own player sends c and cver, and so does this.

Returns the status so the caller can tell a refusal from a network fault; the
body is discarded because these endpoints answer with nothing worth reading.
*/
func (c *Client) GetSigned(ctx context.Context, rawURL string) (int, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return 0, err
	}
	q := u.Query()
	q.Set("c", ClientName)
	// A missing version degrades to an unversioned ping rather than none.
	if cfg, err := c.config(ctx); err == nil && cfg.ClientVersion != "" {
		q.Set("cver", cfg.ClientVersion)
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Cookie", c.creds.cookie())
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Origin", Origin)
	req.Header.Set("Referer", Origin+"/")
	if auth := c.creds.authorization(Origin); auth != "" {
		req.Header.Set("Authorization", auth)
		req.Header.Set("X-Origin", Origin)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	return resp.StatusCode, nil
}

// ---------- errors ----------

// HTTPError is a non-2xx response from InnerTube.
type HTTPError struct {
	Status   int
	Endpoint string
	Message  string
}

func (e *HTTPError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("innertube %s: HTTP %d: %s", e.Endpoint, e.Status, e.Message)
	}
	return fmt.Sprintf("innertube %s: HTTP %d", e.Endpoint, e.Status)
}

// ---------- config ----------

var (
	reAPIKey      = regexp.MustCompile(`"INNERTUBE_API_KEY":"([^"]+)"`)
	reClientVer   = regexp.MustCompile(`"INNERTUBE_CLIENT_VERSION":"([^"]+)"`)
	reVisitorData = regexp.MustCompile(`"VISITOR_DATA":"([^"]+)"`)
)

// config returns a usable Config, scraping and caching as needed.
func (c *Client) config(ctx context.Context) (*Config, error) {
	c.mu.RLock()
	cfg := c.cfg
	c.mu.RUnlock()
	if cfg != nil && time.Since(cfg.scrapedAt) < configTTL {
		return cfg, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, Origin+"/", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept-Language", c.language)
	req.Header.Set("Cookie", c.creds.cookie())

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("scrape config: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("scrape config: %w", err)
	}
	html := string(body)

	pick := func(re *regexp.Regexp) string {
		if m := re.FindStringSubmatch(html); len(m) > 1 {
			return m[1]
		}
		return ""
	}
	next := &Config{
		APIKey:        pick(reAPIKey),
		ClientVersion: pick(reClientVer),
		VisitorData:   pick(reVisitorData),
		scrapedAt:     time.Now(),
	}
	if next.ClientVersion == "" {
		// Reuse a stale config rather than failing outright: an unparseable
		// homepage should degrade, not take the app down.
		if cfg != nil {
			return cfg, nil
		}
		return nil, fmt.Errorf("scrape config: no client version in %d bytes", len(html))
	}

	c.mu.Lock()
	c.cfg = next
	c.mu.Unlock()
	return next, nil
}

// ---------- calls ----------

/*
ClientContext identifies the client a request claims to be.

Almost everything is asked for as the web client, but not everything is served
to it: timed lyrics are returned only to YouTube's mobile clients, and asking
as the web client gets the same words with no timings at all. The difference is
the request context, so it has to be selectable per call.
*/
type ClientContext struct {
	Name      string
	Version   string
	UserAgent string
	// Extra carries the device fields a mobile context is expected to have.
	Extra map[string]any
}

// MobileMusic is the context that receives timed lyrics.
var MobileMusic = ClientContext{
	Name:      "IOS_MUSIC",
	Version:   "7.21.1",
	UserAgent: "com.google.ios.youtubemusic/7.21.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)",
	Extra: map[string]any{
		"deviceMake":  "Apple",
		"deviceModel": "iPhone16,2",
		"osName":      "iPhone",
		"osVersion":   "17.5.1.21F90",
	},
}

// Call posts to an InnerTube endpoint and returns the raw JSON response.
//
// body is merged with the request context; callers supply only the
// endpoint-specific fields. The context always wins on key collisions.
func (c *Client) Call(ctx context.Context, endpoint string, body map[string]any) (json.RawMessage, error) {
	return c.CallAs(ctx, endpoint, body, nil)
}

// CallAs is Call, as a different client. A nil context means the web client.
func (c *Client) CallAs(ctx context.Context, endpoint string, body map[string]any, as *ClientContext) (json.RawMessage, error) {
	cfg, err := c.config(ctx)
	if err != nil {
		return nil, err
	}

	payload := make(map[string]any, len(body)+1)
	for k, v := range body {
		payload[k] = v
	}
	client := map[string]any{
		"clientName":    ClientName,
		"clientVersion": cfg.ClientVersion,
		"hl":            c.language,
		"gl":            c.region,
	}
	if cfg.VisitorData != "" {
		client["visitorData"] = cfg.VisitorData
	}
	if as != nil {
		client["clientName"] = as.Name
		client["clientVersion"] = as.Version
		for k, v := range as.Extra {
			client[k] = v
		}
		// A mobile context with the web client's visitor data is inconsistent,
		// and the response is served without timings.
		delete(client, "visitorData")
	}
	payload["context"] = map[string]any{"client": client}

	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	url := Origin + "/youtubei/v1/" + endpoint + "?alt=json"
	// The key belongs to the web client. Sending it with a mobile context is
	// the contradiction upstream rejects with "invalid argument".
	if cfg.APIKey != "" && as == nil {
		url += "&key=" + cfg.APIKey
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if as != nil && as.UserAgent != "" {
		req.Header.Set("User-Agent", as.UserAgent)
	} else {
		// A mobile context served by a browser user agent is refused the timed
		// payload, so the two have to travel together.
		if as != nil && as.UserAgent != "" {
			req.Header.Set("User-Agent", as.UserAgent)
		} else {
			req.Header.Set("User-Agent", c.userAgent)
		}
	}
	req.Header.Set("Origin", Origin)
	req.Header.Set("Referer", Origin+"/")
	req.Header.Set("Accept-Language", c.language)
	req.Header.Set("Cookie", c.creds.cookie())
	/*
	 * A mobile context travels with cookies alone.
	 *
	 * The visitor id, the API key and the request signature all identify the
	 * web client, and sending them alongside a mobile context is a
	 * contradiction upstream answers with HTTP 400. Cookies are enough: they
	 * authenticate the account, which is all the mobile lyrics call needs.
	 */
	if as == nil {
		if cfg.VisitorData != "" {
			req.Header.Set("X-Goog-Visitor-Id", cfg.VisitorData)
		}
		if auth := c.creds.authorization(Origin); auth != "" {
			req.Header.Set("Authorization", auth)
			req.Header.Set("X-Origin", Origin)
		}
		if c.creds != nil {
			for k, v := range c.creds.Extra {
				if strings.HasPrefix(k, "x-goog-") {
					req.Header.Set(k, v)
				}
			}
		}
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("innertube %s: %w", endpoint, err)
	}
	defer resp.Body.Close()

	out, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("innertube %s: read: %w", endpoint, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{
			Status:   resp.StatusCode,
			Endpoint: endpoint,
			Message:  errorMessage(out),
		}
	}
	return out, nil
}

// Continue fetches the next page of a paginated response.
//
// Every list surface pages this way, so it lives here rather than being
// reimplemented per parser.
func (c *Client) Continue(ctx context.Context, endpoint, token string) (json.RawMessage, error) {
	if token == "" {
		return nil, fmt.Errorf("innertube %s: empty continuation", endpoint)
	}
	return c.Call(ctx, endpoint, map[string]any{"continuation": token})
}

// errorMessage lifts error.message out of an InnerTube error body, if present.
func errorMessage(body []byte) string {
	var doc struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return ""
	}
	return doc.Error.Message
}
