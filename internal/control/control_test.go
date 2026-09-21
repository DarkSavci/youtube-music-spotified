package control_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"spotifier/internal/control"
	"spotifier/internal/domain"
)

func openTest(t *testing.T) *control.Store {
	t.Helper()
	// A real SQLite file in a temp dir rather than :memory:, so the schema and
	// the WAL pragmas are exercised the way they run in production.
	s, err := control.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func play(uuid, track, artist, artistID string, ago time.Duration, ms int64) control.Play {
	return control.Play{
		EventUUID: uuid, TrackID: track, Title: track,
		Artist: artist, ArtistID: artistID,
		PlayedMs: ms, PlayedAt: time.Now().UTC().Add(-ago),
	}
}

// A client retrying after a dropped connection must not double-count a listen.
// Silent duplication would corrupt every statistic derived from this table.
func TestRecordPlaysIsIdempotent(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	p := play("evt-1", "t1", "Daft Punk", "UC1", time.Minute, 200_000)

	for range 3 {
		if err := s.RecordPlays(ctx, control.DefaultUserID, []control.Play{p}); err != nil {
			t.Fatalf("record: %v", err)
		}
	}
	top, err := s.TopTracks(ctx, control.DefaultUserID, control.Last(time.Hour), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(top) != 1 {
		t.Fatalf("got %d tracks, want 1", len(top))
	}
	if top[0].Plays != 1 {
		t.Errorf("same event recorded %d times; must be idempotent", top[0].Plays)
	}
}

// Failed attempts are kept for diagnostics but must never inflate a statistic.
func TestFailedPlaysExcludedFromStats(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	good := play("ok", "t1", "A", "UCa", time.Minute, 200_000)
	bad := play("bad", "t2", "B", "UCb", time.Minute, 0)
	bad.Failed = true
	bad.FailReason = "403"

	if err := s.RecordPlays(ctx, control.DefaultUserID, []control.Play{good, bad}); err != nil {
		t.Fatal(err)
	}
	top, _ := s.TopTracks(ctx, control.DefaultUserID, control.Last(time.Hour), 10)
	for _, tr := range top {
		if tr.TrackID == "t2" {
			t.Error("a failed play appeared in the statistics")
		}
	}
	if len(top) != 1 {
		t.Errorf("got %d tracks, want only the successful one", len(top))
	}
}

func TestTopTracksAndArtistsOrdering(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	var plays []control.Play
	// Three listens of t1, two of t2, one of t3.
	for i := range 3 {
		plays = append(plays, play("a"+string(rune('0'+i)), "t1", "Alpha", "UCa", time.Minute, 200_000))
	}
	for i := range 2 {
		plays = append(plays, play("b"+string(rune('0'+i)), "t2", "Beta", "UCb", time.Minute, 200_000))
	}
	plays = append(plays, play("c0", "t3", "Beta", "UCb", time.Minute, 200_000))

	if err := s.RecordPlays(ctx, control.DefaultUserID, plays); err != nil {
		t.Fatal(err)
	}

	top, _ := s.TopTracks(ctx, control.DefaultUserID, control.Last(time.Hour), 10)
	if len(top) != 3 || top[0].TrackID != "t1" || top[0].Plays != 3 {
		t.Fatalf("track ordering wrong: %+v", top)
	}

	artists, _ := s.TopArtists(ctx, control.DefaultUserID, control.Last(time.Hour), 10)
	if len(artists) != 2 {
		t.Fatalf("got %d artists, want 2", len(artists))
	}
	// Beta has three plays across two distinct tracks; Alpha has three across one.
	if artists[0].Plays != 3 {
		t.Errorf("top artist should have 3 plays: %+v", artists[0])
	}
	for _, a := range artists {
		if a.ArtistID == "UCb" && a.Tracks != 2 {
			t.Errorf("Beta should show 2 distinct tracks, got %d", a.Tracks)
		}
	}
}

// The figure an artist page shows in place of monthly listeners.
func TestAffinity(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	var plays []control.Play
	for i := range 5 {
		plays = append(plays, play("x"+string(rune('0'+i)), "t1", "Alpha", "UCa", time.Hour, 200_000))
	}
	for i := range 2 {
		plays = append(plays, play("y"+string(rune('0'+i)), "t9", "Beta", "UCb", time.Hour, 200_000))
	}
	// Outside the 30-day window, so it counts all-time but not toward 30d.
	plays = append(plays, play("old", "t1", "Alpha", "UCa", 60*24*time.Hour, 200_000))

	if err := s.RecordPlays(ctx, control.DefaultUserID, plays); err != nil {
		t.Fatal(err)
	}

	aff, err := s.Affinity(ctx, control.DefaultUserID, "UCa")
	if err != nil {
		t.Fatal(err)
	}
	if aff.PlaysAll != 6 {
		t.Errorf("all-time plays = %d, want 6", aff.PlaysAll)
	}
	if aff.Plays30d != 5 {
		t.Errorf("30-day plays = %d, want 5 (the old one is outside the window)", aff.Plays30d)
	}
	if aff.Rank != 1 {
		t.Errorf("Alpha should rank 1 among this listener's artists, got %d", aff.Rank)
	}
	if aff.FirstAt == nil || aff.LastAt == nil {
		t.Error("first and last listen should both be populated")
	}

	beta, _ := s.Affinity(ctx, control.DefaultUserID, "UCb")
	if beta.Rank != 2 {
		t.Errorf("Beta should rank 2, got %d", beta.Rank)
	}

	// An artist never listened to reports no rank rather than a misleading one.
	none, _ := s.Affinity(ctx, control.DefaultUserID, "UCzzz")
	if none.PlaysAll != 0 || none.Rank != 0 {
		t.Errorf("unlistened artist should be empty: %+v", none)
	}
}

// first_seen_at is stamped once. Re-observing must not reset it, or
// "Recently added" would show the last sync rather than when it was saved.
func TestObserveLibraryStampsOnce(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()

	if err := s.ObserveLibrary(ctx, control.DefaultUserID, "album", []string{"al1"}); err != nil {
		t.Fatal(err)
	}
	items := []domain.LibraryItem{{ID: "al1", Kind: domain.LibAlbum, Title: "First"}}
	if err := s.Enrich(ctx, items); err != nil {
		t.Fatal(err)
	}
	if items[0].AddedAt == nil {
		t.Fatal("first observation should stamp AddedAt")
	}
	firstStamp := *items[0].AddedAt

	time.Sleep(10 * time.Millisecond)
	if err := s.ObserveLibrary(ctx, control.DefaultUserID, "album", []string{"al1"}); err != nil {
		t.Fatal(err)
	}
	items[0].AddedAt = nil
	if err := s.Enrich(ctx, items); err != nil {
		t.Fatal(err)
	}
	if items[0].AddedAt == nil || !items[0].AddedAt.Equal(firstStamp) {
		t.Errorf("re-observing reset the stamp: %v -> %v", firstStamp, items[0].AddedAt)
	}
}

// Enrich satisfies the library.Metadata seam, which is what lights up the
// Recents and Recently-added sorts in the sidebar.
func TestEnrichFillsSortFields(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()

	if err := s.RecordPlays(ctx, control.DefaultUserID, []control.Play{
		{EventUUID: "e1", TrackID: "t1", Artist: "Alpha", ArtistID: "UCa",
			PlayedMs: 200_000, PlayedAt: time.Now().UTC().Add(-time.Hour)},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ObserveLibrary(ctx, control.DefaultUserID, "artist", []string{"UCa"}); err != nil {
		t.Fatal(err)
	}

	items := []domain.LibraryItem{
		{ID: "UCa", Kind: domain.LibArtist, Title: "Alpha"},
		{ID: "UCunknown", Kind: domain.LibArtist, Title: "Never played"},
	}
	if err := s.Enrich(ctx, items); err != nil {
		t.Fatal(err)
	}
	if items[0].AddedAt == nil {
		t.Error("observed item should have AddedAt")
	}
	if items[0].LastPlayedAt == nil {
		t.Error("played artist should have LastPlayedAt")
	}
	// An item with no history keeps nil fields, which sort last rather than
	// being back-filled with an invented date.
	if items[1].AddedAt != nil || items[1].LastPlayedAt != nil {
		t.Error("an unobserved, unplayed item must stay empty")
	}
}

// Enrich must not clear a pin the merge already applied, such as Liked Music.
func TestEnrichPreservesExistingPin(t *testing.T) {
	s := openTest(t)
	items := []domain.LibraryItem{{ID: "LM", Kind: domain.LibPlaylist, Title: "Liked Music", Pinned: true}}
	if err := s.Enrich(context.Background(), items); err != nil {
		t.Fatal(err)
	}
	if !items[0].Pinned {
		t.Error("enrichment cleared a pin set upstream")
	}
}

func TestOnRepeat(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	var plays []control.Play
	for i := range 4 {
		plays = append(plays, play("r"+string(rune('0'+i)), "hit", "Alpha", "UCa", time.Hour, 200_000))
	}
	plays = append(plays, play("z0", "other", "Beta", "UCb", time.Hour, 200_000))
	if err := s.RecordPlays(ctx, control.DefaultUserID, plays); err != nil {
		t.Fatal(err)
	}

	got, err := s.OnRepeat(ctx, control.DefaultUserID, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || got[0].TrackID != "hit" || got[0].Plays != 4 {
		t.Errorf("on repeat wrong: %+v", got)
	}
}
