package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"spotifier/internal/api"
	"spotifier/internal/catalog"
	"spotifier/internal/domain"
	"spotifier/internal/identity"
	"spotifier/internal/obs"
)

/*
Fault injection.

Each case forces a failure the app will genuinely meet in use and asserts it
degrades rather than breaking: a wrong answer with a 200, a panic, or a blank
screen with no explanation are all failures here.
*/

// brokenCatalog fails every call, standing in for an unreachable upstream.
type brokenCatalog struct{ err error }

func (b brokenCatalog) Home(context.Context) (domain.BrowsePage, error) {
	return domain.BrowsePage{}, b.err
}
func (b brokenCatalog) Browse(context.Context, string) (domain.BrowsePage, error) {
	return domain.BrowsePage{}, b.err
}
func (b brokenCatalog) Search(context.Context, string, domain.SearchFilter) (domain.SearchResults, error) {
	return domain.SearchResults{}, b.err
}
func (b brokenCatalog) Suggest(context.Context, string) ([]string, error) { return nil, b.err }
func (b brokenCatalog) Album(context.Context, string) (domain.Album, error) {
	return domain.Album{}, b.err
}
func (b brokenCatalog) Artist(context.Context, string) (domain.Artist, error) {
	return domain.Artist{}, b.err
}
func (b brokenCatalog) Playlist(context.Context, string) (domain.Playlist, error) {
	return domain.Playlist{}, b.err
}
func (b brokenCatalog) Radio(context.Context, string) ([]domain.Track, error) { return nil, b.err }
func (b brokenCatalog) RadioPage(context.Context, string, string) ([]domain.Track, string, error) {
	return nil, "", b.err
}
func (b brokenCatalog) Podcast(context.Context, string) (domain.Podcast, error) {
	return domain.Podcast{}, b.err
}

func serverWith(d api.Deps) *api.Server {
	if d.Recorder == nil {
		d.Recorder = obs.NewRecorder()
	}
	return api.New(d)
}

func do(t *testing.T, s *api.Server, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

// An unreachable upstream must report a failure, never an empty success. A 200
// with no content would render as "you have nothing", which is a lie.
func TestUpstreamFailureIsNotReportedAsEmptySuccess(t *testing.T) {
	s := serverWith(api.Deps{Catalog: brokenCatalog{err: errors.New("connection refused")}})

	for _, path := range []string{"/v1/home", "/v1/search?q=test", "/v1/albums/abc", "/v1/artists/abc"} {
		rec := do(t, s, http.MethodGet, path)
		if rec.Code == http.StatusOK {
			t.Errorf("%s returned 200 despite upstream failure; empty results read as 'nothing here'", path)
		}
		if rec.Code < 500 && rec.Code != http.StatusBadGateway {
			t.Errorf("%s returned %d, want a server-side failure", path, rec.Code)
		}
	}
}

// A logged-out session must be distinguishable from a broken one, because only
// one of them should send the user through a login.
func TestLoggedOutIsDistinctFromBroken(t *testing.T) {
	s := serverWith(api.Deps{
		Catalog: catalog.NewFixture("../../testdata/fixtures", nil),
		// No Identity: the signed-out state.
	})

	// Decoded into a fresh value each time. `reauth` is omitempty, so reusing
	// one struct would leave a previous true in place and quietly pass.
	type errBody struct {
		Error  string `json:"error"`
		Reauth bool   `json:"reauth"`
	}
	decode := func(rec *httptest.ResponseRecorder) errBody {
		var b errBody
		if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
			t.Fatalf("unparseable error body %q: %v", rec.Body.String(), err)
		}
		return b
	}

	rec := do(t, s, http.MethodGet, "/v1/me/library")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("library while signed out = %d, want 401", rec.Code)
	}
	if !decode(rec).Reauth {
		t.Error("signed-out response must set reauth so the UI prompts for sign-in")
	}

	// A broken upstream must NOT set reauth, or an offline user is sent
	// through a pointless login.
	broken := serverWith(api.Deps{Catalog: brokenCatalog{err: errors.New("timeout")}})
	if decode(do(t, broken, http.MethodGet, "/v1/home")).Reauth {
		t.Error("a network failure must not be reported as a session expiry")
	}
}

// Statistics routes must degrade when the history store is absent rather than
// taking the whole app down with them.
func TestMissingControlPlaneDegrades(t *testing.T) {
	s := serverWith(api.Deps{
		Catalog: catalog.NewFixture("../../testdata/fixtures", nil),
		// No Control store.
	})

	rec := do(t, s, http.MethodGet, "/v1/me/stats/tracks")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("stats without a store = %d, want 503", rec.Code)
	}

	// Mixes report an empty set instead, because "no mixes yet" is a normal
	// state a fresh install is genuinely in.
	rec = do(t, s, http.MethodGet, "/v1/me/mixes")
	if rec.Code != http.StatusOK {
		t.Errorf("mixes without a store = %d, want 200 with an empty list", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Errorf("mixes body = %q, want an empty array", rec.Body.String())
	}

	// Browsing is unaffected by any of this.
	if rec := do(t, s, http.MethodGet, "/v1/home"); rec.Code != http.StatusOK {
		t.Errorf("browsing broke when the control plane was absent: %d", rec.Code)
	}
}

// Playback routes must say so plainly when no resolver is configured.
func TestMissingResolverIsExplicit(t *testing.T) {
	s := serverWith(api.Deps{Catalog: catalog.NewFixture("../../testdata/fixtures", nil)})

	rec := do(t, s, http.MethodGet, "/v1/resolve/abc")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("resolve without a resolver = %d, want 503", rec.Code)
	}
	rec = do(t, s, http.MethodGet, "/v1/stream/abc")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("stream without a resolver = %d, want 503", rec.Code)
	}
}

// Malformed input must be rejected, not absorbed.
func TestMalformedRequestsAreRejected(t *testing.T) {
	s := serverWith(api.Deps{Catalog: catalog.NewFixture("../../testdata/fixtures", nil)})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/me/plays", strings.NewReader("{not json"))
	s.ServeHTTP(rec, req)
	if rec.Code == http.StatusNoContent {
		t.Error("malformed play-log body was accepted")
	}

	// An empty query returns an empty result rather than searching for nothing.
	if rec := do(t, s, http.MethodGet, "/v1/search?q="); rec.Code != http.StatusOK {
		t.Errorf("empty search = %d, want 200 with no results", rec.Code)
	}
}

// Every route must answer something. A hang or a panic is the worst outcome,
// because the UI shows a spinner forever with nothing to retry.
func TestEveryRouteAnswers(t *testing.T) {
	s := serverWith(api.Deps{Catalog: brokenCatalog{err: errors.New("down")}})

	paths := []string{
		"/v1/home", "/v1/browse/FEmusic_home", "/v1/search?q=x", "/v1/suggest?q=x",
		"/v1/albums/x", "/v1/artists/x", "/v1/playlists/x", "/v1/me", "/v1/me/library",
		"/v1/me/liked", "/v1/me/history", "/v1/me/mixes", "/v1/me/stats/tracks",
		"/v1/me/stats/artists", "/v1/me/stats/on-repeat", "/v1/artists/x/affinity",
		"/v1/resolve/x", "/v1/stream/x", "/v1/health",
	}
	for _, path := range paths {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("%s panicked: %v", path, r)
				}
			}()
			rec := do(t, s, http.MethodGet, path)
			if rec.Code == 0 {
				t.Errorf("%s produced no response", path)
			}
		}()
	}
}

// Health must answer even when everything else is broken, because it is what
// a user checks when nothing works.
func TestHealthSurvivesTotalFailure(t *testing.T) {
	s := serverWith(api.Deps{Catalog: brokenCatalog{err: errors.New("everything is down")}})
	rec := do(t, s, http.MethodGet, "/v1/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d, want 200 even in total failure", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health body unparseable: %v", err)
	}
	if _, ok := body["unknownNodes"]; !ok {
		t.Error("health must always carry the parser-health signal")
	}
}

var _ = identity.ErrLoggedOut
