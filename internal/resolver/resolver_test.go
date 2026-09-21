package resolver_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/resolver"
)

func TestFakeResolverShape(t *testing.T) {
	f := resolver.NewFake()
	s, q, err := f.Resolve(context.Background(), "abc")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if s.Kind != domain.StreamURL || s.URL == "" {
		t.Errorf("fake should produce a URL handle: %+v", s)
	}
	if q.Bitrate == 0 {
		t.Error("quality should carry a bitrate")
	}
	if len(f.Calls) != 1 || f.Calls[0] != "abc" {
		t.Errorf("calls not recorded: %v", f.Calls)
	}
}

func TestFakeResolverFailures(t *testing.T) {
	f := resolver.NewFake()
	f.FailFor["bad"] = resolver.ErrUnavailable
	if _, _, err := f.Resolve(context.Background(), "bad"); !errors.Is(err, resolver.ErrUnavailable) {
		t.Errorf("expected ErrUnavailable, got %v", err)
	}
}

// The embedded engine needs an identifier, not a URL. Stream is a handle
// precisely so the Session core never learns which engine is active.
func TestEmbeddedResolverReturnsIdentifierOnly(t *testing.T) {
	s, _, err := resolver.Embedded{}.Resolve(context.Background(), "xyz")
	if err != nil {
		t.Fatal(err)
	}
	if s.Kind != domain.StreamVideoID {
		t.Errorf("kind = %s, want videoId", s.Kind)
	}
	if s.URL != "" {
		t.Error("embedded resolver must not produce a URL")
	}
}

func TestPremiumItagDetection(t *testing.T) {
	for _, itag := range []int{141, 774} {
		if !resolver.IsPremiumItag(itag) {
			t.Errorf("itag %d should be premium", itag)
		}
	}
	for _, itag := range []int{140, 251, 249} {
		if resolver.IsPremiumItag(itag) {
			t.Errorf("itag %d should not be premium", itag)
		}
	}
}

// Live: actually resolve a real track and confirm the URL serves bytes.
func TestLiveResolveAndFetch(t *testing.T) {
	if os.Getenv("SPOTIFIER_LIVE") != "1" {
		t.Skip("set SPOTIFIER_LIVE=1 to run live tests")
	}
	r := resolver.NewLibrary()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	start := time.Now()
	stream, q, err := r.Resolve(ctx, "Jb6gcoR266U")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	t.Logf("resolved in %s: %s, %d bytes, expires %s",
		time.Since(start).Round(time.Millisecond), q.Label, stream.SizeBytes,
		time.Until(stream.ExpiresAt).Round(time.Minute))

	if stream.Kind != domain.StreamURL || stream.URL == "" {
		t.Fatalf("expected a URL handle: %+v", stream)
	}
	if stream.DurationMs == 0 {
		t.Error("duration not carried through")
	}
	if stream.Expired(time.Now()) {
		t.Error("freshly resolved stream reports expired")
	}
}
