package resolver

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"spotifier/internal/domain"
)

type stub struct {
	id   string
	err  error
	hits int
}

func (s *stub) Name() string { return s.id }
func (s *stub) Resolve(context.Context, string) (domain.Stream, Quality, error) {
	s.hits++
	if s.err != nil {
		return domain.Stream{}, Quality{}, s.err
	}
	return domain.Stream{Kind: domain.StreamURL, URL: "https://x/" + s.id},
		Quality{Label: s.id}, nil
}

func quiet() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestChainPrefersTheFirstAdapter(t *testing.T) {
	a, b := &stub{id: "ytdlp"}, &stub{id: "library"}
	got, _, err := NewChain(a, b, quiet()).Resolve(context.Background(), "v")
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != "https://x/ytdlp" {
		t.Fatalf("resolved via %q, want the preferred adapter", got.URL)
	}
	if b.hits != 0 {
		t.Fatal("fallback was called although the preferred adapter worked")
	}
}

func TestChainFallsBackWhenThePreferredAdapterIsBroken(t *testing.T) {
	a := &stub{id: "ytdlp", err: errors.New("exec: not found")}
	b := &stub{id: "library"}
	c := NewChain(a, b, quiet())

	got, _, err := c.Resolve(context.Background(), "v")
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != "https://x/library" {
		t.Fatalf("resolved via %q, want the fallback", got.URL)
	}

	// A broken binary must cost one failed attempt, not one per track.
	if _, _, err := c.Resolve(context.Background(), "w"); err != nil {
		t.Fatal(err)
	}
	if a.hits != 1 {
		t.Fatalf("preferred adapter called %d times; it should be given up on", a.hits)
	}
}

// A removed track and a rate limit mean the same to both adapters. Retrying
// spends another upstream request for nothing, and under a rate limit it makes
// the rate limit worse.
func TestChainDoesNotRetryFailuresThatAreNotAboutTheAdapter(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"unavailable track", ErrUnavailable},
		{"rate limited address", ErrRateLimited},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &stub{id: "ytdlp", err: tc.err}
			b := &stub{id: "library"}
			_, _, err := NewChain(a, b, quiet()).Resolve(context.Background(), "v")
			if !errors.Is(err, tc.err) {
				t.Fatalf("err = %v, want %v", err, tc.err)
			}
			if b.hits != 0 {
				t.Fatal("fell back on a failure the fallback would hit identically")
			}
		})
	}
}

// If both fail, the preferred adapter's reason is the actionable one.
func TestChainReportsThePreferredFailureWhenBothFail(t *testing.T) {
	want := errors.New("ytdlp exploded")
	a := &stub{id: "ytdlp", err: want}
	b := &stub{id: "library", err: errors.New("library exploded")}
	_, _, err := NewChain(a, b, quiet()).Resolve(context.Background(), "v")
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want the preferred adapter's error", err)
	}
}
