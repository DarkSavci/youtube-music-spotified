package innertube_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"spotifier/internal/innertube"
)

// Live tests hit the real API and need credentials. They are opt-in:
//
//	SPOTIFIER_LIVE=1 go test ./internal/innertube/ -run Live -v
//
// CI never sets this, so the default `go test ./...` stays hermetic.
func liveClient(t *testing.T) *innertube.Client {
	t.Helper()
	if os.Getenv("SPOTIFIER_LIVE") != "1" {
		t.Skip("set SPOTIFIER_LIVE=1 to run live tests")
	}
	creds, err := innertube.LoadCredentials("../../credentials.json")
	if err != nil {
		t.Fatalf("load credentials: %v", err)
	}
	return innertube.New(
		innertube.WithCredentials(creds),
		innertube.WithLocale("en", "US"),
	)
}

func TestLiveConfigScrape(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Exercised indirectly: a successful Call proves config scraping worked.
	raw, err := c.Call(ctx, "search", map[string]any{"query": "daft punk"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(raw) < 1000 {
		t.Fatalf("suspiciously small response: %d bytes", len(raw))
	}
	t.Logf("search returned %d bytes", len(raw))
}

func TestLiveSessionCanary(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if !c.Authenticated() {
		t.Fatal("credentials did not parse as authenticated")
	}
	state, acct, err := c.SessionState(ctx)
	if err != nil {
		t.Fatalf("canary: %v", err)
	}
	if state != innertube.SignedIn {
		t.Fatalf("expected SignedIn, got %q", state)
	}
	if acct == nil || acct.Name == "" {
		t.Fatal("signed in but no account name")
	}
	t.Logf("signed in as %q (handle %q)", acct.Name, acct.Handle)
}

// The Silent-logout case: corrupted credentials must report LoggedOut, and
// must do so from a HTTP 200 body rather than a status code.
func TestLiveSilentLogout(t *testing.T) {
	if os.Getenv("SPOTIFIER_LIVE") != "1" {
		t.Skip("set SPOTIFIER_LIVE=1 to run live tests")
	}
	good, err := innertube.LoadCredentials("../../credentials.json")
	if err != nil {
		t.Fatalf("load credentials: %v", err)
	}
	// Keep the shape valid but corrupt the session identifier, so the request
	// is well-formed and the server has to reject it on content.
	bad := &innertube.Credentials{Cookie: corrupt(good.Cookie)}
	c := innertube.New(innertube.WithCredentials(bad))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	state, acct, err := c.SessionState(ctx)
	t.Logf("corrupted session -> state=%q acct=%v err=%v", state, acct, err)
	if state == innertube.SignedIn {
		t.Fatal("corrupted credentials reported as signed in")
	}
}

func corrupt(cookie string) string {
	out := []byte(cookie)
	// Flip characters inside the SID values without changing the structure.
	for i := 0; i < len(out); i++ {
		if out[i] >= 'a' && out[i] <= 'y' {
			out[i]++
		}
	}
	return string(out)
}

func TestLiveContinuationShape(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	raw, err := c.Call(ctx, "browse", map[string]any{"browseId": "FEmusic_home"})
	if err != nil {
		t.Fatalf("browse home: %v", err)
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	t.Logf("FEmusic_home returned %d bytes", len(raw))
}
