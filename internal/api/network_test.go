package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/resolver"
)

func TestIsNetworkErrorTellsALostConnectionFromAnAnswer(t *testing.T) {
	lost := []error{
		&net.DNSError{Err: "no such host", Name: "music.youtube.com", IsNotFound: true},
		&url.Error{Op: "Get", URL: "https://rr1.googlevideo.com/x", Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connectex: refused")}},
		errors.New(`yt-dlp: exit status 1: ERROR: [youtube] abc: Unable to download API page: ('Connection aborted.', RemoteDisconnected('Remote end closed connection without response'))`),
		errors.New(`yt-dlp: exit status 1: ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>`),
		fmt.Errorf("innertube: %w", context.DeadlineExceeded),
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
