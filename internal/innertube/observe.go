package innertube

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"spotifier/internal/ratelimit"
)

// CallRecord describes one request this package sent, or refused to send.
type CallRecord struct {
	// Kind is the InnerTube endpoint ("browse", "next", "search", "player"…),
	// or "config" for the homepage scrape, "signed" for a playback ping and
	// "channels" for the account list.
	Kind string
	// Detail narrows it down: the browse id, "continuation", a video id.
	Detail string
	// Route is the /v1 route the call served, or "background".
	Route string
	// Status is the HTTP status; zero when nothing was received.
	Status   int
	Duration time.Duration
	// RetryAfter is the cooldown a refusal asked for, or the one still left
	// when this call was refused without being sent.
	RetryAfter time.Duration
	// Refused means the call was never sent: a cooldown was in force.
	Refused bool
	Err     error
}

var observer atomic.Pointer[func(CallRecord)]

// SetObserver installs the function told about every call. It must be quick;
// logging is what it is for.
func SetObserver(f func(CallRecord)) {
	if f == nil {
		observer.Store(nil)
		return
	}
	observer.Store(&f)
}

var answered atomic.Pointer[func()]

// OnAnswered installs a function told whenever YouTube answers a call at all,
// whatever the status: proof the connection works.
func OnAnswered(f func()) {
	if f == nil {
		answered.Store(nil)
		return
	}
	answered.Store(&f)
}

func observe(r CallRecord) {
	if f := observer.Load(); f != nil {
		(*f)(r)
	}
	if r.Status > 0 {
		if f := answered.Load(); f != nil {
			(*f)()
		}
	}
}

type routeKey struct{}

// WithRoute tags ctx with the /v1 route a request is serving, so the calls it
// makes upstream can be attributed to it in the logs.
func WithRoute(ctx context.Context, route string) context.Context {
	return context.WithValue(ctx, routeKey{}, route)
}

// RouteOf reads the tag set by WithRoute.
func RouteOf(ctx context.Context) string {
	if r, ok := ctx.Value(routeKey{}).(string); ok && r != "" {
		return r
	}
	return "background"
}

/*
Program-wide defaults.

The catalog client and the account's client are built in different places, at
different times, and the account's is rebuilt on every sign-in. They must still
share one Governor, since YouTube counts their calls together, and one scraped
config, since each used to fetch the homepage for its own. The binary installs
both here before building any client; tests that build clients without calling
it get neither pacing nor sharing, which keeps them independent of each other.
*/
var defaults struct {
	mu       sync.Mutex
	governor *ratelimit.Governor
	configs  *configStore
}

// SetDefaultGovernor makes every Client built afterwards use g.
func SetDefaultGovernor(g *ratelimit.Governor) {
	defaults.mu.Lock()
	defaults.governor = g
	defaults.mu.Unlock()
}

// ShareConfig makes every Client built afterwards share one config cache, so
// the homepage is scraped once per session rather than once per client.
func ShareConfig() {
	defaults.mu.Lock()
	if defaults.configs == nil {
		defaults.configs = newConfigStore()
	}
	defaults.mu.Unlock()
}

// WithGovernor overrides the default Governor for one Client.
func WithGovernor(g *ratelimit.Governor) Option {
	return func(c *Client) { c.gov = g }
}

/*
send performs one request through the Governor, and records it.

Refused at once while a cooldown is in force. A 429 or 503 starts one and comes
back as a *ratelimit.Error; the caller is handed the response otherwise, with
its body unread.
*/
func (c *Client) send(req *http.Request, kind, detail string) (*http.Response, error) {
	ctx := req.Context()
	rec := CallRecord{Kind: kind, Detail: detail, Route: RouteOf(ctx)}
	release, err := c.gov.Acquire(ctx)
	if err != nil {
		rec.Refused = ratelimit.RetryAfterOf(err) > 0 || isRateLimited(err)
		rec.RetryAfter = ratelimit.RetryAfterOf(err)
		rec.Err = err
		if rec.Refused {
			observe(rec)
		}
		return nil, err
	}
	defer release()
	start := time.Now()
	resp, err := c.http.Do(req)
	rec.Duration = time.Since(start)
	if err != nil {
		rec.Err = err
		observe(rec)
		return nil, err
	}
	rec.Status = resp.StatusCode
	if rl := c.gov.Observe(resp.StatusCode, resp.Header, nil); rl != nil {
		rec.RetryAfter = ratelimit.RetryAfterOf(rl)
		observe(rec)
		return resp, rl
	}
	observe(rec)
	return resp, nil
}

func isRateLimited(err error) bool { return errors.Is(err, ratelimit.ErrRateLimited) }
