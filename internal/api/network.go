package api

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
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

	mu      sync.Mutex
	offline bool
	// lastAnswer is when upstream last answered anything; a probe that only
	// times out soon after is not taken as the connection being gone.
	lastAnswer time.Time
	// offlineSince is when the current outage began.
	offlineSince time.Time
	polling      bool
	checkedAt    time.Time
	checkedOK    bool
}

// errOffline answers any lookup or download asked for while the connection
// is known to be gone.
var errOffline = errors.New("offline: YouTube cannot be reached")

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

// recentAnswer is how long after any answer from upstream a probe that times
// out is inconclusive rather than proof of a lost connection. Short: it is
// for other traffic getting through right now, not for a connection that
// worked before it went silent — that is exactly the drop to detect.
const recentAnswer = 5 * time.Second

// Succeeded records that upstream answered: a stream, a lookup, a catalogue
// call. Any of them ends an outage, not just the probe.
func (n *network) Succeeded() { n.AnsweredSince(time.Now()) }

// AnsweredSince records an answer to a request sent at started. An answer to
// one sent before the outage began proves nothing about the connection now:
// a lookup that set off just before a drop and finished just after it once
// flipped the core back online for a moment.
func (n *network) AnsweredSince(started time.Time) {
	n.mu.Lock()
	n.lastAnswer = time.Now()
	offline := n.offline
	stale := offline && started.Before(n.offlineSince)
	n.mu.Unlock()
	if offline && !stale {
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
	err := n.probe(ctx)
	ok := err == nil
	n.mu.Lock()
	// A probe that only timed out, while other traffic got answers moments
	// ago, is a slow probe on a working link, not an outage.
	if !ok && isTimeout(err) && time.Since(n.lastAnswer) < recentAnswer {
		ok = true
	}
	n.checkedAt, n.checkedOK = time.Now(), ok
	n.mu.Unlock()
	return ok
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func (n *network) setOffline(offline bool) {
	n.mu.Lock()
	if n.offline == offline {
		n.mu.Unlock()
		return
	}
	n.offline = offline
	if offline {
		n.offlineSince = time.Now()
	}
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
	ask := func(ctx context.Context, url string) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
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
	// Two hosts, so one slow or blocked endpoint does not read as the whole
	// connection gone: reachable if either answers.
	return func(ctx context.Context) error {
		errs := make(chan error, 2)
		for _, url := range []string{"https://www.youtube.com/generate_204", "https://music.youtube.com/"} {
			go func() { errs <- ask(ctx, url) }()
		}
		first := <-errs
		if first == nil {
			return nil
		}
		if second := <-errs; second == nil {
			return nil
		}
		return first
	}
}

/*
newStreamTransport builds the transport audio is fetched with. No total
deadline — a three-hour mix is one transfer — but a connection that never
answers, or answers and then stops, must not hang playback: dial, handshake
and headers are bounded, every body is read through a stall guard, and an
HTTP/2 connection that goes quiet is pinged and dropped if it does not answer.
*/
func newStreamTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   8,
		ForceAttemptHTTP2:     true,
		HTTP2: &http.HTTP2Config{
			SendPingTimeout: 15 * time.Second,
			PingTimeout:     5 * time.Second,
		},
	}
}

// swappableTransport lets the stream transport be replaced while requests
// are in flight: after an outage every connection it holds is suspect.
type swappableTransport struct {
	make func() *http.Transport
	cur  atomic.Pointer[http.Transport]
}

func newSwappableTransport(make func() *http.Transport) *swappableTransport {
	t := &swappableTransport{make: make}
	t.cur.Store(make())
	return t
}

func (t *swappableTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return t.cur.Load().RoundTrip(r)
}

// CloseIdleConnections lets http.Client.CloseIdleConnections reach it.
func (t *swappableTransport) CloseIdleConnections() { t.cur.Load().CloseIdleConnections() }

// renew starts a fresh transport; the old one's idle connections close now,
// and those still in use close as their requests finish.
func (t *swappableTransport) renew() {
	old := t.cur.Swap(t.make())
	old.CloseIdleConnections()
}

// UpstreamAnswered tells the server some other call reached YouTube, which
// ends an outage as surely as a probe does.
func (s *Server) UpstreamAnswered(started time.Time) { s.net.AnsweredSince(started) }

// isNetworkError reports whether err is a failure to reach upstream at all,
// as opposed to an answer from it. Failing to reach this machine is not a
// lost connection.
func isNetworkError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, resolver.ErrRateLimited) {
		return false
	}
	if errors.Is(err, errOffline) {
		return true
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
