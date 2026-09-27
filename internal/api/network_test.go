package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/ratelimit"
	"spotifier/internal/resolver"
)

func TestIsNetworkErrorTellsALostConnectionFromAnAnswer(t *testing.T) {
	lost := []error{
		&net.DNSError{Err: "no such host", Name: "music.youtube.com", IsNotFound: true},
		&url.Error{Op: "Get", URL: "https://rr1.googlevideo.com/x", Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connectex: refused")}},
		errors.New(`yt-dlp: exit status 1: ERROR: [youtube] abc: Unable to download API page: ('Connection aborted.', RemoteDisconnected('Remote end closed connection without response'))`),
		errors.New(`yt-dlp: exit status 1: ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>`),
		fmt.Errorf("innertube: %w", context.DeadlineExceeded),
		fmt.Errorf("stream copy: %w", io.ErrUnexpectedEOF),
	}
	for _, err := range lost {
		if !isNetworkError(err) {
			t.Errorf("not recognised as a lost connection: %v", err)
		}
	}
	answers := []error{
		nil,
		context.Canceled,
		fmt.Errorf("stream: %w", resolver.ErrRateLimited),
		errors.New("yt-dlp: exit status 1: ERROR: [youtube] abc: Video unavailable"),
		errors.New("HTTP 403: Forbidden"),
		// This machine not answering is not the internet going away.
		&url.Error{Op: "Get", URL: "http://127.0.0.1:1/x", Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("refused")}},
	}
	for _, err := range answers {
		if isNetworkError(err) {
			t.Errorf("an answer taken for a lost connection: %v", err)
		}
	}
}

type probeStub struct {
	ok    atomic.Bool
	calls atomic.Int32
}

func (p *probeStub) probe(context.Context) error {
	p.calls.Add(1)
	if p.ok.Load() {
		return nil
	}
	return errors.New("unreachable")
}

type changes struct {
	mu  sync.Mutex
	got []bool
}

func (c *changes) record(online bool) {
	c.mu.Lock()
	c.got = append(c.got, online)
	c.mu.Unlock()
}

func (c *changes) list() []bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]bool(nil), c.got...)
}

var lostConnection = &net.DNSError{Err: "no such host", Name: "music.youtube.com", IsNotFound: true}

// A transport error only counts once a probe agrees; then the connection is
// watched until it comes back, and that is announced too.
func TestNetworkConfirmsALossAndNoticesTheReturn(t *testing.T) {
	p := &probeStub{}
	var ch changes
	n := newNetwork(p.probe, ch.record)
	n.every = 10 * time.Millisecond

	if !n.Failed(lostConnection) || !n.Offline() {
		t.Fatal("a confirmed transport error did not mark the connection lost")
	}
	if got := ch.list(); len(got) != 1 || got[0] {
		t.Fatalf("changes %v, want [false]", got)
	}
	p.ok.Store(true)
	deadline := time.Now().Add(2 * time.Second)
	for n.Offline() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n.Offline() {
		t.Fatal("the connection coming back was not noticed")
	}
	if got := ch.list(); len(got) != 2 || !got[1] {
		t.Fatalf("changes %v, want [false true]", got)
	}
}

// One server failing while the probe still gets through is not a lost
// connection, and an answer from upstream is never probed at all.
func TestNetworkIgnoresFailuresTheProbeDisagreesWith(t *testing.T) {
	p := &probeStub{}
	p.ok.Store(true)
	n := newNetwork(p.probe, nil)
	if n.Failed(lostConnection) || n.Offline() {
		t.Fatal("a failure the probe disagrees with marked the connection lost")
	}
	calls := p.calls.Load()
	if n.Failed(errors.New("HTTP 403: Forbidden")) || p.calls.Load() != calls {
		t.Fatal("an answer from upstream was probed or counted")
	}
}

// A cut-short transfer only means a lost connection when a probe agrees.
func TestACutShortTransferNeedsTheProbeToAgree(t *testing.T) {
	p := &probeStub{}
	p.ok.Store(true)
	n := newNetwork(p.probe, nil)
	if n.Failed(fmt.Errorf("copy: %w", io.ErrUnexpectedEOF)) || n.Offline() {
		t.Fatal("an unexpected EOF with the probe getting through marked the connection lost")
	}
}

// The engine only waits on a probe for failures that could be the network.
func TestOnlyNetworkShapedEngineFailuresAreProbed(t *testing.T) {
	for reason, want := range map[string]bool{
		"stalled": true, "media_error_2": true, "embedded_no_start": true,
		"media_error_3": false, "media_error_4": false, "NotSupportedError": false, "player_error_150": false,
	} {
		if got := mayBeNetwork(reason); got != want {
			t.Errorf("mayBeNetwork(%q) = %v, want %v", reason, got, want)
		}
	}
}

// Any answer from upstream ends an outage, not only the probe.
func TestAnyAnswerFromUpstreamEndsAnOutage(t *testing.T) {
	p := &probeStub{}
	var ch changes
	n := newNetwork(p.probe, ch.record)
	n.every = time.Hour // the poll must not be what notices
	n.Failed(lostConnection)
	if !n.Offline() {
		t.Fatal("setup: not offline")
	}
	n.Succeeded()
	if n.Offline() {
		t.Fatal("an answer from upstream did not end the outage")
	}
	if got := ch.list(); len(got) != 2 || !got[1] {
		t.Fatalf("changes %v, want [false true]", got)
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

// A probe that only times out while other traffic got answers moments ago is
// a slow probe, not an outage; long after the last answer it counts.
func TestAProbeTimeoutIsInconclusiveRightAfterAnAnswer(t *testing.T) {
	n := newNetwork(func(context.Context) error { return timeoutErr{} }, nil)
	n.every = time.Hour
	n.Succeeded()
	if n.Failed(lostConnection) || n.Offline() {
		t.Fatal("a probe timeout right after an answer marked the connection lost")
	}
	n.mu.Lock()
	n.lastAnswer = time.Now().Add(-time.Minute)
	n.checkedAt = time.Time{}
	n.mu.Unlock()
	if !n.Failed(lostConnection) {
		t.Fatal("a probe timeout long after the last answer was not believed")
	}
}

// Renewing the stream transport replaces it, so no connection from before an
// outage — idle or frozen mid-transfer — is used again.
func TestRenewingTheStreamTransportReplacesIt(t *testing.T) {
	st := newSwappableTransport(newStreamTransport)
	before := st.cur.Load()
	st.renew()
	if st.cur.Load() == before {
		t.Fatal("renew kept the same transport")
	}
	if h2 := st.cur.Load().HTTP2; h2 == nil || h2.SendPingTimeout <= 0 || h2.PingTimeout <= 0 {
		t.Fatal("the stream transport does not health-check quiet HTTP/2 connections")
	}
}

// An outage is not a rate limit: it answers before the cooldown check and
// starts no cooldown; and a cooldown is not an outage.
func TestOfflineAndRateLimitsStayApart(t *testing.T) {
	g := ratelimit.New("streams", ratelimit.Settings{})
	r := &failingResolver{err: errors.New("never called")}
	s := New(Deps{Resolver: r, StreamGovernor: g, NetworkProbe: func(context.Context) error { return errors.New("unreachable") }})
	s.net.every = time.Hour
	s.net.setOffline(true)
	if _, err := s.resolveCached(context.Background(), "vid00000009"); !errors.Is(err, errOffline) {
		t.Fatalf("offline lookup: %v", err)
	}
	if cooling, _ := g.Cooling(); cooling || r.calls.Load() != 0 {
		t.Fatal("an outage started a cooldown or ran the resolver")
	}
	s.net.Succeeded()
	g.CoolDown(0)
	if s.net.Failed(fmt.Errorf("%w: slow down", resolver.ErrRateLimited)) || s.net.Offline() {
		t.Fatal("a rate limit was taken for a lost connection")
	}
}

// A connection that answered until it went silent is not "other traffic
// getting through": once the answers stop, a timing-out probe is believed.
func TestASilentDropIsNotExcusedByAnswersFromBeforeIt(t *testing.T) {
	n := newNetwork(func(context.Context) error { return timeoutErr{} }, nil)
	n.every = time.Hour
	n.mu.Lock()
	n.lastAnswer = time.Now().Add(-20 * time.Second)
	n.mu.Unlock()
	if !n.Failed(lostConnection) {
		t.Fatal("answers from 20 s before a silent drop kept the connection counted as working")
	}
}

// Offline, a track's health says so and never "rate limited", even with a
// rate limit remembered from before: the engine must not report "blocked"
// and have the session pause instead of wait (#7).
func TestTrackHealthWhileOfflineIsNotARateLimit(t *testing.T) {
	s := New(Deps{NetworkProbe: func(context.Context) error { return errors.New("unreachable") }})
	s.net.every = time.Hour
	s.lastFailure.Store("vid00000010", fmt.Errorf("%w: earlier", resolver.ErrRateLimited))
	s.net.setOffline(true)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/tracks/vid00000010/health", nil))
	var body struct {
		RateLimited bool `json:"rateLimited"`
		Offline     bool `json:"offline"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.RateLimited || !body.Offline {
		t.Fatalf("health offline: %s", rec.Body.String())
	}
}

// An answer to a request sent before the outage began does not end it.
func TestAnAnswerFromBeforeTheOutageDoesNotEndIt(t *testing.T) {
	n := newNetwork(func(context.Context) error { return errors.New("unreachable") }, nil)
	n.every = time.Hour
	sent := time.Now()
	time.Sleep(2 * time.Millisecond)
	n.Failed(lostConnection)
	n.AnsweredSince(sent)
	if !n.Offline() {
		t.Fatal("a lookup sent before the drop ended the outage")
	}
	n.AnsweredSince(time.Now())
	if n.Offline() {
		t.Fatal("an answer to a request sent during the outage did not end it")
	}
}
