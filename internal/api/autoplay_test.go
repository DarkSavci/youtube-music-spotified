package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"spotifier/internal/catalog"
	"spotifier/internal/clock"
	"spotifier/internal/domain"
	"spotifier/internal/session"
)

// radioCatalog serves an endless radio: page n of any seed is ten tracks,
// the first page starting with the seed itself, as YouTube's does.
type radioCatalog struct {
	catalog.Catalog
	mu    sync.Mutex
	pages []string // "seed/token" of every page asked for
}

func (c *radioCatalog) RadioPage(_ context.Context, seed, token string) ([]domain.Track, string, error) {
	c.mu.Lock()
	c.pages = append(c.pages, seed+"/"+token)
	c.mu.Unlock()
	page := 0
	if token != "" {
		fmt.Sscanf(token, "page%d", &page)
	}
	var out []domain.Track
	if page == 0 {
		out = append(out, track(seed))
	}
	for i := range 10 {
		out = append(out, track(fmt.Sprintf("%s-r%d-%d", seed, page, i)))
	}
	return out, fmt.Sprintf("page%d", page+1), nil
}

func (c *radioCatalog) asked() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.pages...)
}

func track(id string) domain.Track {
	return domain.Track{ID: id, Title: id, Playable: true}
}

func radioServer(t *testing.T) (*Server, *session.Hub, *radioCatalog, context.CancelFunc) {
	t.Helper()
	hub := session.NewHub(clock.System{}, session.DefaultSettings(), nil)
	cat := &radioCatalog{}
	s := New(Deps{Session: hub, Catalog: cat})
	ctx, cancel := context.WithCancel(context.Background())
	go s.RunAutoplay(ctx)
	t.Cleanup(cancel)
	return s, hub, cat, cancel
}

func queueIDs(hub *session.Hub) []string {
	var out []string
	for _, t := range hub.Projection().State.Queue.Items {
		out = append(out, t.ID)
	}
	return out
}

func waitQueue(t *testing.T, hub *session.Hub, atLeast int) []string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if ids := queueIDs(hub); len(ids) >= atLeast {
			return ids
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("queue never reached %d tracks: %v", atLeast, queueIDs(hub))
	return nil
}

// Starting a song plays it and fills the queue with its radio, the song once.
func TestStartingASongQueuesItsRadio(t *testing.T) {
	s, hub, _, _ := radioServer(t)
	body, _ := json.Marshal(map[string]any{"deviceId": "d", "track": track("seed")})
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/session/radio", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	ids := waitQueue(t, hub, 11)
	if ids[0] != "seed" || ids[1] != "seed-r0-0" {
		t.Fatalf("queue %v", ids[:3])
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatalf("%s queued twice", id)
		}
		seen[id] = true
	}
}

// As the queue runs low, the next page of the same radio is fetched with its
// continuation, not a fresh radio from somewhere else.
func TestRunningLowFetchesTheNextPage(t *testing.T) {
	s, hub, cat, _ := radioServer(t)
	body, _ := json.Marshal(map[string]any{"deviceId": "d", "track": track("seed")})
	s.mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/session/radio", bytes.NewReader(body)))
	waitQueue(t, hub, 11)

	_, _ = hub.Command(context.Background(), "d", session.Command{Kind: session.CmdJump, At: 8})
	ids := waitQueue(t, hub, 21)
	if ids[11] != "seed-r1-0" {
		t.Fatalf("appended %v, want the radio's second page", ids[11:13])
	}
	if asked := cat.asked(); asked[len(asked)-1] != "seed/page1" {
		t.Fatalf("asked for %v", asked)
	}
}

// An album that runs out carries on from a radio of its last track.
func TestAnAlbumCarriesOnFromItsLastTrack(t *testing.T) {
	_, hub, cat, _ := radioServer(t)
	album := []domain.Track{track("a1"), track("a2"), track("a3")}
	_, _ = hub.Command(context.Background(), "d", session.Command{Kind: session.CmdPlay, Tracks: album, Origin: "Album"})
	ids := waitQueue(t, hub, 4)
	if ids[3] != "a3-r0-0" {
		t.Fatalf("queue %v", ids)
	}
	if asked := cat.asked(); asked[0] != "a3/" {
		t.Fatalf("seeded from %v", asked)
	}
}

// Turned off, a queue ends where it ends.
func TestAutoplayOffLeavesTheQueueAlone(t *testing.T) {
	s, hub, cat, _ := radioServer(t)
	s.SetAutoplay(false)
	_, _ = hub.Command(context.Background(), "d", session.Command{Kind: session.CmdPlay, Tracks: []domain.Track{track("x")}, Origin: "Album"})
	time.Sleep(300 * time.Millisecond)
	if n := len(queueIDs(hub)); n != 1 || len(cat.asked()) != 0 {
		t.Fatalf("queue %d, asked %v", n, cat.asked())
	}
}

// A repeating playlist loops as it is: no radio joins it near the end (#26).
func TestRepeatKeepsAPlaylistToItself(t *testing.T) {
	for _, mode := range []domain.RepeatMode{domain.RepeatAll, domain.RepeatOne} {
		_, hub, cat, _ := radioServer(t)
		ctx := context.Background()
		_, _ = hub.Command(ctx, "d", session.Command{Kind: session.CmdSetRepeat, Repeat: mode})
		list := []domain.Track{track("p1"), track("p2"), track("p3")}
		_, _ = hub.Command(ctx, "d", session.Command{Kind: session.CmdPlay, Tracks: list, StartIndex: 2, Origin: "Playlist"})
		time.Sleep(300 * time.Millisecond)
		if ids := queueIDs(hub); len(ids) != 3 || len(cat.asked()) != 0 {
			t.Fatalf("repeat %s: queue %v, asked %v", mode, ids, cat.asked())
		}
	}
}

// Shuffling a repeating playlist near its end shuffles only the playlist (#28).
func TestShuffleOnARepeatingPlaylistStaysInIt(t *testing.T) {
	_, hub, cat, _ := radioServer(t)
	ctx := context.Background()
	_, _ = hub.Command(ctx, "d", session.Command{Kind: session.CmdSetRepeat, Repeat: domain.RepeatAll})
	var list []domain.Track
	for i := 0; i < 8; i++ {
		list = append(list, track(fmt.Sprintf("p%d", i)))
	}
	_, _ = hub.Command(ctx, "d", session.Command{Kind: session.CmdPlay, Tracks: list, StartIndex: 6, Origin: "Playlist"})
	// As in the report: near the end long enough for autoplay to act, then shuffle.
	time.Sleep(300 * time.Millisecond)
	_, _ = hub.Command(ctx, "d", session.Command{Kind: session.CmdSetShuffle, Shuffle: true})
	time.Sleep(300 * time.Millisecond)
	ids := queueIDs(hub)
	if len(ids) != len(list) || len(cat.asked()) != 0 {
		t.Fatalf("queue %v, asked %v", ids, cat.asked())
	}
	for _, id := range ids {
		if !strings.HasPrefix(id, "p") {
			t.Fatalf("a track from outside the playlist: %v", ids)
		}
	}
}

// Turning repeat off lets a playlist carry on into radio again.
func TestRepeatOffResumesAutoplay(t *testing.T) {
	_, hub, _, _ := radioServer(t)
	ctx := context.Background()
	_, _ = hub.Command(ctx, "d", session.Command{Kind: session.CmdSetRepeat, Repeat: domain.RepeatAll})
	list := []domain.Track{track("p1"), track("p2"), track("p3")}
	_, _ = hub.Command(ctx, "d", session.Command{Kind: session.CmdPlay, Tracks: list, Origin: "Playlist"})
	time.Sleep(300 * time.Millisecond)
	if n := len(queueIDs(hub)); n != 3 {
		t.Fatalf("topped up while repeating: %d", n)
	}
	_, _ = hub.Command(ctx, "d", session.Command{Kind: session.CmdSetRepeat, Repeat: domain.RepeatOff})
	if ids := waitQueue(t, hub, 4); ids[3] != "p3-r0-0" {
		t.Fatalf("queue %v", ids)
	}
}
