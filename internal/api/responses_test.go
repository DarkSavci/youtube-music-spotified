package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"spotifier/internal/account"
	"spotifier/internal/api"
	"spotifier/internal/clock"
	"spotifier/internal/domain"
	"spotifier/internal/identity"
	"spotifier/internal/innertube"
	"spotifier/internal/library"
	"spotifier/internal/respcache"
)

// countingCatalog counts album and playlist reads and can be made to fail.
type countingCatalog struct {
	brokenCatalog
	mu        sync.Mutex
	albums    int
	playlists int
	fail      error
}

func (c *countingCatalog) Album(_ context.Context, id string) (domain.Album, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.albums++
	if c.fail != nil {
		return domain.Album{}, c.fail
	}
	return domain.Album{ID: id, Title: "Album " + id}, nil
}

func (c *countingCatalog) Playlist(_ context.Context, id string) (domain.Playlist, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.playlists++
	return domain.Playlist{ID: id, Title: "List"}, nil
}

func (c *countingCatalog) count() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.albums, c.playlists
}

func kept(clk clock.Clock) *respcache.Cache {
	return respcache.New(respcache.Options{Clock: clk})
}

func TestAnAlbumIsReadFromYouTubeOnce(t *testing.T) {
	cat := &countingCatalog{}
	s := serverWith(api.Deps{Catalog: cat, Responses: kept(clock.NewManual())})
	first := do(t, s, http.MethodGet, "/v1/albums/MPREb_x")
	second := do(t, s, http.MethodGet, "/v1/albums/MPREb_x")
	if first.Code != 200 || second.Code != 200 {
		t.Fatalf("status %d / %d", first.Code, second.Code)
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("bodies differ:\n%s\n%s", first.Body, second.Body)
	}
	if got := second.Header().Get("X-Cache"); got != "hit" {
		t.Fatalf("second read X-Cache = %q", got)
	}
	if n, _ := cat.count(); n != 1 {
		t.Fatalf("album read upstream %d times", n)
	}
}

func TestARateLimitedAlbumShowsTheKeptCopy(t *testing.T) {
	clk := clock.NewManual()
	cat := &countingCatalog{}
	s := serverWith(api.Deps{Catalog: cat, Responses: kept(clk)})
	good := do(t, s, http.MethodGet, "/v1/albums/MPREb_x").Body.String()

	clk.Advance(20 * 24 * time.Hour) // past fresh and past the revalidate window
	cat.mu.Lock()
	cat.fail = errors.New("innertube browse: HTTP 429: Resource has been exhausted")
	cat.mu.Unlock()

	rec := do(t, s, http.MethodGet, "/v1/albums/MPREb_x")
	if rec.Code != 200 || rec.Body.String() != good {
		t.Fatalf("got %d %s, want the kept album", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("X-Cache"); got != "stale-error" {
		t.Fatalf("X-Cache = %q", got)
	}
}

func TestWithoutACacheEveryReadAsksUpstream(t *testing.T) {
	cat := &countingCatalog{}
	s := serverWith(api.Deps{Catalog: cat})
	do(t, s, http.MethodGet, "/v1/albums/a")
	do(t, s, http.MethodGet, "/v1/albums/a")
	if n, _ := cat.count(); n != 2 {
		t.Fatalf("album read %d times, want 2", n)
	}
}

// ---------- the account ----------

// likedIdentity is a signed-in account with a Liked Music list.
type likedIdentity struct {
	mu        sync.Mutex
	liked     []domain.Track // newest first
	full      int
	since     int
	playlists int
	rated     []string
	// window makes the incremental read behave like the real one, which
	// returns known songs that moved up and stops at a run of known songs.
	window bool
}

func (f *likedIdentity) LikedSongs(context.Context) (domain.Playlist, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.full++
	return domain.Playlist{ID: "LM", Title: "Liked Music", TrackCount: len(f.liked), Tracks: append([]domain.Track(nil), f.liked...)}, nil
}

func (f *likedIdentity) LikedSongsSince(_ context.Context, known func(string) bool) (domain.Playlist, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.since++
	pl := domain.Playlist{ID: "LM", Title: "Liked Music", TrackCount: len(f.liked)}
	run := 0
	for _, t := range f.liked {
		if known(t.ID) {
			if !f.window {
				return pl, true, nil
			}
			run++
			if run >= 2 {
				pl.Tracks = pl.Tracks[:len(pl.Tracks)-(run-1)]
				return pl, true, nil
			}
		} else {
			run = 0
		}
		pl.Tracks = append(pl.Tracks, t)
	}
	return pl, false, nil
}

func (f *likedIdentity) Playlists(context.Context) ([]domain.LibraryItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.playlists++
	return []domain.LibraryItem{{ID: "PL1", Kind: domain.LibPlaylist, Title: "Mine"}}, nil
}
func (f *likedIdentity) Artists(context.Context) ([]domain.LibraryItem, error) { return nil, nil }
func (f *likedIdentity) Albums(context.Context) ([]domain.LibraryItem, error)  { return nil, nil }
func (f *likedIdentity) History(context.Context) ([]domain.Track, error)       { return nil, nil }
func (f *likedIdentity) Rate(_ context.Context, id string, r identity.Rating) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rated = append(f.rated, id)
	if r == identity.RatingLike {
		f.liked = append([]domain.Track{{ID: id, Title: "New " + id}}, f.liked...)
		return nil
	}
	out := f.liked[:0]
	for _, t := range f.liked {
		if t.ID != id {
			out = append(out, t)
		}
	}
	f.liked = out
	return nil
}
func (f *likedIdentity) ToggleLibrary(context.Context, string) error           { return nil }
func (f *likedIdentity) Follow(context.Context, string, bool) error            { return nil }
func (f *likedIdentity) DeletePlaylist(context.Context, string) error          { return nil }
func (f *likedIdentity) AddToPlaylist(context.Context, string, []string) error { return nil }
func (f *likedIdentity) RemoveFromPlaylist(context.Context, string, []identity.PlaylistItemRef) error {
	return nil
}
func (f *likedIdentity) CreatePlaylist(context.Context, string, string, bool) (string, error) {
	return "PL2", nil
}

func (f *likedIdentity) counts() (full, since, playlists int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.full, f.since, f.playlists
}

func signedIn(f *likedIdentity, cat *countingCatalog) *api.Server {
	st := account.State{Identity: f, Library: library.New(f, nil)}
	return serverWith(api.Deps{Catalog: cat, Account: account.Static(st), Responses: kept(clock.NewManual())})
}

func post(t *testing.T, s *api.Server, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body)))
	return rec
}

func likedIDs(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()
	var pl domain.Playlist
	if err := json.Unmarshal(rec.Body.Bytes(), &pl); err != nil {
		t.Fatalf("decode %s: %v", rec.Body, err)
	}
	var ids []string
	for _, tr := range pl.Tracks {
		ids = append(ids, tr.ID)
	}
	return ids
}

func TestLikedMusicIsReadInFullOnceThenOnlyItsNewEnd(t *testing.T) {
	f := &likedIdentity{liked: []domain.Track{{ID: "c"}, {ID: "b"}, {ID: "a"}}}
	s := signedIn(f, &countingCatalog{})

	if ids := likedIDs(t, do(t, s, http.MethodGet, "/v1/me/liked")); len(ids) != 3 {
		t.Fatalf("first read: %v", ids)
	}
	do(t, s, http.MethodGet, "/v1/me/liked")
	if full, since, _ := f.counts(); full != 1 || since != 0 {
		t.Fatalf("after two reads: %d full, %d incremental", full, since)
	}

	// A like: the next read fetches only the new end.
	if rec := post(t, s, "/v1/me/tracks/d/rating", `{"rating":"like"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("rate: %d %s", rec.Code, rec.Body)
	}
	ids := likedIDs(t, do(t, s, http.MethodGet, "/v1/me/liked"))
	if len(ids) != 4 || ids[0] != "d" {
		t.Fatalf("after a like: %v", ids)
	}
	if full, since, _ := f.counts(); full != 1 || since != 1 {
		t.Fatalf("after a like: %d full, %d incremental reads", full, since)
	}

	// An unlike is applied to the kept list with no read at all.
	post(t, s, "/v1/me/tracks/b/rating", `{"rating":"none"}`)
	ids = likedIDs(t, do(t, s, http.MethodGet, "/v1/me/liked"))
	if len(ids) != 3 || ids[0] != "d" || ids[2] != "a" {
		t.Fatalf("after an unlike: %v", ids)
	}
	if full, since, _ := f.counts(); full != 1 || since != 1 {
		t.Fatalf("after an unlike: %d full, %d incremental reads", full, since)
	}
}

func TestLikedMusicReadsAgainInFullWhenItsCountDisagrees(t *testing.T) {
	f := &likedIdentity{liked: []domain.Track{{ID: "c"}, {ID: "b"}, {ID: "a"}}}
	s := signedIn(f, &countingCatalog{})
	do(t, s, http.MethodGet, "/v1/me/liked")
	// Unliked on another device, then a new like here.
	f.mu.Lock()
	f.liked = []domain.Track{{ID: "c"}, {ID: "a"}}
	f.mu.Unlock()
	post(t, s, "/v1/me/tracks/d/rating", `{"rating":"like"}`)
	ids := likedIDs(t, do(t, s, http.MethodGet, "/v1/me/liked"))
	if len(ids) != 3 || ids[0] != "d" {
		t.Fatalf("got %v, want d c a", ids)
	}
	if full, _, _ := f.counts(); full != 2 {
		t.Fatalf("%d full reads, want a second one to catch the unlike", full)
	}
}

func TestTheSidebarKeepsYouTubesPartAndRefreshesAfterAnEdit(t *testing.T) {
	f := &likedIdentity{liked: []domain.Track{{ID: "a"}}}
	s := signedIn(f, &countingCatalog{})
	for i := 0; i < 3; i++ {
		if rec := do(t, s, http.MethodGet, "/v1/me/library"); rec.Code != 200 {
			t.Fatalf("library: %d %s", rec.Code, rec.Body)
		}
	}
	if _, _, n := f.counts(); n != 1 {
		t.Fatalf("playlists surface read %d times", n)
	}
	post(t, s, "/v1/me/playlists", `{"title":"New"}`)
	do(t, s, http.MethodGet, "/v1/me/library")
	if _, _, n := f.counts(); n != 2 {
		t.Fatalf("after creating a playlist the surface was read %d times, want 2", n)
	}
}

func TestEditingAPlaylistDropsItsKeptCopy(t *testing.T) {
	f := &likedIdentity{}
	cat := &countingCatalog{}
	s := signedIn(f, cat)
	do(t, s, http.MethodGet, "/v1/playlists/PL1")
	do(t, s, http.MethodGet, "/v1/playlists/PL1")
	if _, n := cat.count(); n != 1 {
		t.Fatalf("playlist read %d times", n)
	}
	post(t, s, "/v1/me/playlists/PL1/tracks", `{"trackIds":["x"]}`)
	do(t, s, http.MethodGet, "/v1/playlists/PL1")
	if _, n := cat.count(); n != 2 {
		t.Fatalf("after adding a track the playlist was read %d times, want 2", n)
	}
}

func TestASignedOutSessionIsNeverKept(t *testing.T) {
	st := account.State{Client: innertube.New()}
	s := serverWith(api.Deps{Account: account.Static(st), Responses: kept(clock.NewManual())})
	for i := 0; i < 2; i++ {
		rec := do(t, s, http.MethodGet, "/v1/me")
		if !strings.Contains(rec.Body.String(), "logged_out") {
			t.Fatalf("read %d: %s", i, rec.Body)
		}
		if got := rec.Header().Get("X-Cache"); got == "hit" || got == "stale" {
			t.Fatalf("read %d: a signed-out answer was served from the cache (%s)", i, got)
		}
	}
}

// Liked, then unliked straight away: the like still has to be read.
func TestAnUnlikeKeepsAPendingLikesMark(t *testing.T) {
	f := &likedIdentity{liked: []domain.Track{{ID: "c"}, {ID: "b"}, {ID: "a"}}}
	s := signedIn(f, &countingCatalog{})
	do(t, s, http.MethodGet, "/v1/me/liked")
	post(t, s, "/v1/me/tracks/d/rating", `{"rating":"like"}`)
	post(t, s, "/v1/me/tracks/b/rating", `{"rating":"none"}`)
	ids := likedIDs(t, do(t, s, http.MethodGet, "/v1/me/liked"))
	if len(ids) != 3 || ids[0] != "d" {
		t.Fatalf("got %v, want the new like on top and b gone", ids)
	}
}

// A song liked again moves to the top of Liked Music; the kept list follows.
func TestAReLikedSongMovesToTheTop(t *testing.T) {
	f := &likedIdentity{liked: []domain.Track{{ID: "c"}, {ID: "b"}, {ID: "a"}}}
	s := signedIn(f, &countingCatalog{})
	do(t, s, http.MethodGet, "/v1/me/liked")
	f.mu.Lock()
	f.liked = []domain.Track{{ID: "e"}, {ID: "a"}, {ID: "d"}, {ID: "c"}, {ID: "b"}}
	f.window = true
	f.mu.Unlock()
	post(t, s, "/v1/me/tracks/e/rating", `{"rating":"like"}`)
	f.mu.Lock()
	f.liked = f.liked[1:]
	f.mu.Unlock()
	ids := likedIDs(t, do(t, s, http.MethodGet, "/v1/me/liked"))
	want := []string{"e", "a", "d", "c", "b"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v, want %v", ids, want)
	}
}

func TestAPlaylistEditDropsItsBrowseIDToo(t *testing.T) {
	f := &likedIdentity{}
	cat := &countingCatalog{}
	s := signedIn(f, cat)
	do(t, s, http.MethodGet, "/v1/playlists/VLPL1")
	post(t, s, "/v1/me/playlists/PL1/tracks", `{"trackIds":["x"]}`)
	do(t, s, http.MethodGet, "/v1/playlists/VLPL1")
	if _, n := cat.count(); n != 2 {
		t.Fatalf("VLPL1 read %d times, want it dropped by an edit to PL1", n)
	}
}
