package control_test

import (
	"context"
	"testing"
	"time"

	"spotifier/internal/control"
)

// albumPlay is a play of one track from an album.
func albumPlay(uuid, track, artist, artistID, albumID, album string, ago time.Duration) control.Play {
	p := play(uuid, track, artist, artistID, ago, 180_000)
	p.AlbumID, p.Album = albumID, album
	p.Artwork = "https://example.test/" + albumID
	return p
}

func seedInsights(t *testing.T, s *control.Store) {
	t.Helper()
	plays := []control.Play{
		albumPlay("a1", "ayip", "mor ve ötesi", "UCmor", "MPmor", "Dünya Yalan Söylüyor", time.Hour),
		albumPlay("a2", "ayip", "mor ve ötesi", "UCmor", "MPmor", "Dünya Yalan Söylüyor", 2*time.Hour),
		albumPlay("a3", "cambaz", "mor ve ötesi", "UCmor", "MPmor", "Dünya Yalan Söylüyor", 3*time.Hour),
		albumPlay("d1", "yurek", "Duman", "UCdum", "MPdum", "Seni Kendime Sakladım", 4*time.Hour),
		// From before albums were logged: counts for the artist, not for any album.
		play("old", "ayip", "mor ve ötesi", "UCmor", 5*time.Hour, 180_000),
	}
	if err := s.RecordPlays(context.Background(), control.DefaultUserID, plays); err != nil {
		t.Fatal(err)
	}
}

func TestTopAlbums(t *testing.T) {
	s := openTest(t)
	seedInsights(t, s)
	got, err := s.TopAlbums(context.Background(), control.DefaultUserID, control.Last(24*time.Hour), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 albums (the album-less play left out), got %+v", got)
	}
	top := got[0]
	if top.Key != "MPmor" || top.Plays != 3 || top.Tracks != 2 || top.Artwork == "" {
		t.Errorf("top album wrong: %+v", top)
	}
}

func TestSummary(t *testing.T) {
	s := openTest(t)
	seedInsights(t, s)
	got, err := s.Summary(context.Background(), control.DefaultUserID, control.Last(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	want := control.ListeningSummary{Plays: 5, TotalMs: 5 * 180_000, Tracks: 3, Artists: 2, Albums: 2}
	if got != want {
		t.Errorf("summary = %+v, want %+v", got, want)
	}
}

// Lookup has to fold case beyond ASCII: SQLite's LIKE would miss "ÖTESİ".
func TestLookupFoldsNonASCIICase(t *testing.T) {
	s := openTest(t)
	seedInsights(t, s)
	// Dotted capital İ included: Go lowercases it to "i" plus a combining dot.
	got, err := s.Lookup(context.Background(), control.DefaultUserID, "  ÖTESİ ", 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Artists) != 1 || got.Artists[0].ArtistID != "UCmor" {
		t.Errorf("artists = %+v", got.Artists)
	}
	if len(got.Tracks) != 2 || got.Tracks[0].TrackID != "ayip" {
		t.Errorf("tracks = %+v (most-played first)", got.Tracks)
	}
	if len(got.Albums) != 1 || got.Albums[0].Key != "MPmor" {
		t.Errorf("albums = %+v", got.Albums)
	}

	empty, err := s.Lookup(context.Background(), control.DefaultUserID, "   ", 8)
	if err != nil || len(empty.Tracks)+len(empty.Artists)+len(empty.Albums) != 0 {
		t.Errorf("blank query should find nothing: %+v %v", empty, err)
	}
}

func TestDetail(t *testing.T) {
	s := openTest(t)
	seedInsights(t, s)
	ctx := context.Background()

	artist, err := s.Detail(ctx, control.DefaultUserID, "artist", "UCmor")
	if err != nil {
		t.Fatal(err)
	}
	if artist.Name != "mor ve ötesi" || artist.Plays != 4 || artist.Tracks != 2 || artist.Rank != 1 {
		t.Errorf("artist detail wrong: %+v", artist)
	}
	if artist.FirstAt == nil || artist.LastAt == nil || !artist.FirstAt.Before(*artist.LastAt) {
		t.Errorf("first/last wrong: %v %v", artist.FirstAt, artist.LastAt)
	}
	if len(artist.Months) != 12 || artist.Months[11].Plays != 4 {
		t.Errorf("months wrong: %+v", artist.Months)
	}
	if len(artist.TopTracks) != 2 || artist.TopTracks[0].TrackID != "ayip" || artist.TopTracks[0].Plays != 3 {
		t.Errorf("top tracks wrong: %+v", artist.TopTracks)
	}

	album, err := s.Detail(ctx, control.DefaultUserID, "album", "MPmor")
	if err != nil {
		t.Fatal(err)
	}
	if album.Name != "Dünya Yalan Söylüyor" || album.Plays != 3 || album.Artist != "mor ve ötesi" || album.Rank != 1 {
		t.Errorf("album detail wrong: %+v", album)
	}

	// Tied with "cambaz" on one play behind "ayip": ties share a rank.
	track, err := s.Detail(ctx, control.DefaultUserID, "track", "yurek")
	if err != nil {
		t.Fatal(err)
	}
	if track.Name != "yurek" || track.Plays != 1 || track.Rank != 2 || len(track.TopTracks) != 0 {
		t.Errorf("track detail wrong: %+v", track)
	}

	none, err := s.Detail(ctx, control.DefaultUserID, "artist", "UCnobody")
	if err != nil || none.Plays != 0 || none.Rank != 0 {
		t.Errorf("unplayed artist: %+v %v", none, err)
	}
	if _, err := s.Detail(ctx, control.DefaultUserID, "playlist", "x"); err == nil {
		t.Error("unknown kind should be refused")
	}
}
