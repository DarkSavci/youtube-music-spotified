package api

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"spotifier/internal/resolver"
)

/*
network tracks whether YouTube can be reached at all (#7).

Offline, every track fails to resolve, and the session used to treat each as
broken: it greyed out and skipped a run of the queue, and the engine switched
to the embedded player, which then could not play either once the connection
came back. Knowing the difference lets playback wait instead.

A failure only counts as a lost connection when it is a transport error and a
probe confirms it: a refused or rate-limited stream is an answer, and means
the connection works.
*/
type network struct {
	probe    func(ctx context.Context) error
	onChange func(online bool)
	every    time.Duration

	mu        sync.Mutex
	offline   bool
	polling   bool
	checkedAt time.Time
	checkedOK bool
}

// probeTimeout bounds one reachability check; offline, DNS usually fails at
// once, but a dropped route only times out.
const probeTimeout = 4 * time.Second

// ioUnexpectedEOF is a transfer cut short, which a probe decides the meaning of.
var ioUnexpectedEOF = io.ErrUnexpectedEOF

func newNetwork(probe func(context.Context) error, onChange func(bool)) *network {
	return &network{probe: probe, onChange: onChange, every: 3 * time.Second}
}

// Offline reports whether upstream is known to be unreachable.
func (n *network) Offline() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.offline
}

/*
Failed looks at an upstream error and reports whether it was a lost
connection. A transport error is checked with a probe before the connection is
declared lost, so one bad server does not stop playback.
*/
func (n *network) Failed(err error) bool {
	if !isNetworkError(err) {
		return false
	}
	if n.Offline() {
		return true
	}
	if n.reachable() {
		return false
	}
	n.setOffline(true)
	return true
}

// Succeeded records that upstream answered.
func (n *network) Succeeded() {
	if n.Offline() {
		n.setOffline(false)
	}
}

// reachable probes upstream, reusing a result from the last two seconds so a
// burst of failing requests probes once.
func (n *network) reachable() bool {
	n.mu.Lock()
	if time.Since(n.checkedAt) < 2*time.Second {
		ok := n.checkedOK
		n.mu.Unlock()
		return ok
	}
	n.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	ok := n.probe(ctx) == nil
	n.mu.Lock()
	n.checkedAt, n.checkedOK = time.Now(), ok
	n.mu.Unlock()
	return ok
}

func (n *network) setOffline(offline bool) {
	n.mu.Lock()
	if n.offline == offline {
		n.mu.Unlock()
		return
	}
	n.offline = offline
	if !offline {
		n.checkedAt, n.checkedOK = time.Now(), true
	}
	start := offline && !n.polling
	if start {
		n.polling = true
	}
	n.mu.Unlock()
	if n.onChange != nil {
		n.onChange(!offline)
	}
	if start {
		go n.poll()
	}
}

// poll checks for the connection coming back while offline, so held playback
// resumes without anyone pressing anything.
func (n *network) poll() {
	for {
		time.Sleep(n.every)
		if !n.Offline() {
			break
		}
		ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
		err := n.probe(ctx)
		cancel()
		if err == nil {
			n.setOffline(false)
			break
		}
	}
	n.mu.Lock()
	n.polling = false
	again := n.offline
	if again {
		n.polling = true
	}
	n.mu.Unlock()
	if again {
		go n.poll()
	}
}

// probeYouTube asks YouTube's connectivity endpoint. Any HTTP answer means it
// is reachable. It has its own transport, with the same proxy settings but no
// kept-alive connections: after a silent drop a pooled connection is frozen,
// and a probe reusing it said nothing for as long as it stayed in the pool.
func probeYouTube() func(context.Context) error {
	client := &http.Client{
		Timeout: probeTimeout,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
			TLSHandshakeTimeout:   3 * time.Second,
			ResponseHeaderTimeout: 3 * time.Second,
			DisableKeepAlives:     true,
		},
	}
	return func(ctx context.Context) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.youtube.com/generate_204", nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		_ = resp.Body.Close()
		return nil
	}
}

// isNetworkError reports whether err is a failure to reach upstream at all,
// as opposed to an answer from it. Failing to reach this machine is not a
// lost connection.
func isNetworkError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, resolver.ErrRateLimited) {
		return false
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		if u, perr := url.Parse(ue.URL); perr == nil && isLoopback(u.Hostname()) {
			return false
		}
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return true
	}
	var op *net.OpError
	if errors.As(err, &op) {
		return true
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	// A transfer cut short is a candidate too; Failed only believes it once a
	// probe agrees.
	if errors.Is(err, ioUnexpectedEOF) {
		return true
	}
	return resolver.IsTransportError(err)
}

// handleNetwork answers whether YouTube is reachable, for a client deciding
// what a failure meant before the projection saying so has arrived.
func (s *Server) handleNetwork(w http.ResponseWriter, _ *http.Request) {
	s.write(w, http.StatusOK, map[string]bool{"offline": s.net.Offline()})
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
