package innertube

import (
	"context"
	"errors"
	"sync"
	"time"
)

// configFailTTL is how long a failed scrape is remembered. Without it, a
// homepage that answered with a consent page or a 429 was fetched again
// before every call — doubling the traffic exactly when YouTube was asking
// for less.
const configFailTTL = 2 * time.Minute

// configScrapeTimeout bounds a scrape that callers share.
const configScrapeTimeout = 30 * time.Second

/*
configStore holds scraped configs and makes sure each is fetched once.

Every call needs a config, and a launch starts a dozen calls at once. Each of
them used to find no config and scrape the homepage for itself. Now the first
one scrapes and the rest wait for it; the result is shared by every Client
built from the same cookies, the catalog's and the account's alike.
*/
type configStore struct {
	mu      sync.Mutex
	entries map[string]*configEntry
	now     func() time.Time
}

type configEntry struct {
	cfg      *Config
	err      error
	failedAt time.Time
	inflight chan struct{}
}

func newConfigStore() *configStore {
	return &configStore{entries: map[string]*configEntry{}, now: time.Now}
}

func (s *configStore) get(ctx context.Context, key string, scrape func(context.Context) (*Config, error)) (*Config, error) {
	for {
		s.mu.Lock()
		e := s.entries[key]
		if e == nil {
			e = &configEntry{}
			s.entries[key] = e
		}
		now := s.now()
		if e.cfg != nil && now.Sub(e.cfg.scrapedAt) < configTTL {
			s.mu.Unlock()
			return e.cfg, nil
		}
		if wait := e.inflight; wait != nil {
			s.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if e.err != nil && now.Sub(e.failedAt) < configFailTTL {
			// A stale config still works for a while; better than failing.
			cfg, err := e.cfg, e.err
			s.mu.Unlock()
			if cfg != nil {
				return cfg, nil
			}
			return nil, err
		}
		done := make(chan struct{})
		e.inflight = done
		s.mu.Unlock()

		// Shared by everyone waiting, so not tied to this caller's context.
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), configScrapeTimeout)
		cfg, err := scrape(sctx)
		cancel()

		s.mu.Lock()
		if err == nil {
			e.cfg, e.err = cfg, nil
		} else if upstreamFailure(err) {
			e.err, e.failedAt = err, s.now()
		}
		e.inflight = nil
		close(done)
		stale := e.cfg
		s.mu.Unlock()
		if err != nil {
			if stale != nil {
				return stale, nil
			}
			return nil, err
		}
		return cfg, nil
	}
}

// scrapeFailure marks a scrape that reached YouTube and got a bad answer —
// an error status or a page with no config. Only those are remembered: a
// network fault or a refusal during a local cooldown sent nothing, and the
// next call should simply try.
type scrapeFailure struct{ err error }

func (e *scrapeFailure) Error() string { return e.err.Error() }
func (e *scrapeFailure) Unwrap() error { return e.err }

func upstreamFailure(err error) bool {
	var sf *scrapeFailure
	return errors.As(err, &sf)
}
