package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"spotifier/internal/api"
	"spotifier/internal/clock"
	"spotifier/internal/domain"
	"spotifier/internal/obs"
	"spotifier/internal/resolver"
	"spotifier/internal/session"
)

// offlineResolver fails the way yt-dlp does with no connection.
type offlineResolver struct{}

func (offlineResolver) Name() string { return "offline" }

func (offlineResolver) Resolve(context.Context, string) (domain.Stream, resolver.Quality, error) {
	return domain.Stream{}, resolver.Quality{}, errors.New(
		`yt-dlp: exit status 1: ERROR: [youtube] abc: Unable to download API page: ('Connection aborted.', RemoteDisconnected('Remote end closed connection without response'))`)
}

// With the connection gone, a stream request says so rather than reporting a
// broken track, and the session knows before the engine reports the failure
// (#7): the track is held instead of skipped.
func TestStreamWhileOfflineHoldsTheTrack(t *testing.T) {
	hub := session.NewHub(clock.System{}, session.DefaultSettings(), nil)
	srv := httptest.NewServer(api.New(api.Deps{
		Recorder:     obs.NewRecorder(),
		Resolver:     offlineResolver{},
		Session:      hub,
		NetworkProbe: func(context.Context) error { return errors.New("unreachable") },
	}))
	defer srv.Close()

	dev := hub.Register("d", "Test", session.Capabilities{})
	if _, err := hub.Command(context.Background(), dev.ID, session.Command{
		Kind: session.CmdPlay, Tracks: []domain.Track{{ID: "abc", Title: "A", Playable: true}, {ID: "def", Title: "B", Playable: true}},
	}); err != nil {
		t.Fatal(err)
	}

	resp, err := http.Get(srv.URL + "/v1/stream/abc")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", resp.StatusCode)
	}
	if !hub.Projection().Offline {
		t.Fatal("the session was not told the connection is gone")
	}

	var network struct{ Offline bool }
	nr, err := http.Get(srv.URL + "/v1/network")
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewDecoder(nr.Body).Decode(&network)
	_ = nr.Body.Close()
	if !network.Offline {
		t.Fatal("/v1/network does not report the lost connection")
	}

	// The engine's report of the failure then holds the track.
	hub.EngineEvent(context.Background(), dev.ID, session.EngineEvent{Kind: session.EvFailed, Epoch: hub.Projection().State.Epoch, Reason: "network"})
	s := hub.Projection().State
	if s.Queue.Index != 0 || s.State != domain.StateStalled || len(s.Degraded) != 0 {
		t.Fatalf("track not held: index %d state %s degraded %v", s.Queue.Index, s.State, s.Degraded)
	}
}
