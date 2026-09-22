package control

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

/*
Insights: the rest of "Your listening".

Top albums, a period's totals, and looking one artist, song or album up to see
the listener's own figures for it. Like the rest of this package they are
aggregations over the Play log and nothing else, which is what makes them
cheap enough to compute on every visit and impossible to get anywhere else.
*/

// AlbumStat is one row of an aggregate over albums.
type AlbumStat struct {
	// Key is what Detail looks the album up by: its ID, or its name for
	// plays recorded without one.
	Key      string    `json:"key"`
	AlbumID  string    `json:"albumId,omitempty"`
	Album    string    `json:"album"`
	Artist   string    `json:"artist"`
	ArtistID string    `json:"artistId,omitempty"`
	Plays    int       `json:"plays"`
	Tracks   int       `json:"distinctTracks"`
	TotalMs  int64     `json:"totalMs"`
	LastAt   time.Time `json:"lastPlayedAt"`
	// Artwork is a track cover from the album, which for an album's own
	// tracks is the album cover.
	Artwork string `json:"artwork,omitempty"`
}

// Grouping keys. An ID is preferred, but a play recorded without one still
// belongs somewhere, so the name stands in; the same expressions are used to
// look a group back up, so a key from a list always finds its detail.
const (
	artistKey = `COALESCE(NULLIF(artist_id, ''), artist)`
	albumKey  = `COALESCE(NULLIF(album_id, ''), album)`
)

// TopAlbums returns the most-played albums in a period.
//
// Plays recorded before albums were logged have none and are left out rather
// than gathered under a blank title.
func (s *Store) TopAlbums(ctx context.Context, userID int64, p Period, limit int) ([]AlbumStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+albumKey+` AS k, MAX(album_id), MAX(album), MAX(artist), MAX(artist_id),
		       COUNT(*), COUNT(DISTINCT track_id), SUM(played_ms), MAX(played_at), MAX(artwork)
		FROM plays
		WHERE user_id = ? AND played_at BETWEEN ? AND ? AND `+countedPlays+`
		  AND album <> ''
		GROUP BY k
		ORDER BY COUNT(*) DESC, SUM(played_ms) DESC
		LIMIT ?`, userID, p.From.UTC(), p.To.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("control: top albums: %w", err)
	}
	defer rows.Close()

	var out []AlbumStat
	for rows.Next() {
		var a AlbumStat
		var last sqlTime
		if err := rows.Scan(&a.Key, &a.AlbumID, &a.Album, &a.Artist, &a.ArtistID,
			&a.Plays, &a.Tracks, &a.TotalMs, &last, &a.Artwork); err != nil {
			return nil, err
		}
		a.LastAt = last.Time
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListeningSummary is a period's totals: the figures at the top of the page.
type ListeningSummary struct {
	Plays   int   `json:"plays"`
	TotalMs int64 `json:"totalMs"`
	Tracks  int   `json:"distinctTracks"`
	Artists int   `json:"distinctArtists"`
	Albums  int   `json:"distinctAlbums"`
}

// Summary totals a period.
func (s *Store) Summary(ctx context.Context, userID int64, p Period) (ListeningSummary, error) {
	var out ListeningSummary
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(played_ms), 0), COUNT(DISTINCT track_id),
		       COUNT(DISTINCT CASE WHEN artist <> '' THEN `+artistKey+` END),
		       COUNT(DISTINCT CASE WHEN album <> '' THEN `+albumKey+` END)
		FROM plays
		WHERE user_id = ? AND played_at BETWEEN ? AND ? AND `+countedPlays,
		userID, p.From.UTC(), p.To.UTC()).
		Scan(&out.Plays, &out.TotalMs, &out.Tracks, &out.Artists, &out.Albums)
	if err != nil {
		return out, fmt.Errorf("control: summary: %w", err)
	}
	return out, nil
}

// LookupResults is what a search of the listener's own history finds.
type LookupResults struct {
	Tracks  []TrackStat  `json:"tracks"`
	Artists []ArtistStat `json:"artists"`
	Albums  []AlbumStat  `json:"albums"`
}

// allTime covers every play the log could hold.
func allTime() Period {
	return Period{From: time.Unix(0, 0).UTC(), To: time.Now().UTC().Add(time.Minute)}
}

// lookupScan bounds how much of the history a lookup reads. The groups are
// per song, artist and album, so this is a lot of listening, and a lookup
// over more than that still finds the ones heard most.
const lookupScan = 5000

/*
Lookup finds songs, artists and albums in the listener's history by name.

Matching is done here rather than in SQL: SQLite's LIKE folds case for ASCII
only, so "ötesi" would miss "Ötesi" and most non-English names would be
hard to find. Each kind comes back most-played first.
*/
func (s *Store) Lookup(ctx context.Context, userID int64, query string, limit int) (LookupResults, error) {
	out := LookupResults{Tracks: []TrackStat{}, Artists: []ArtistStat{}, Albums: []AlbumStat{}}
	q := fold(query)
	if q == "" {
		return out, nil
	}
	p := allTime()

	tracks, err := s.TopTracks(ctx, userID, p, lookupScan)
	if err != nil {
		return out, err
	}
	for _, t := range tracks {
		if len(out.Tracks) < limit && (strings.Contains(fold(t.Title), q) || strings.Contains(fold(t.Artist), q)) {
			out.Tracks = append(out.Tracks, t)
		}
	}

	artists, err := s.TopArtists(ctx, userID, p, lookupScan)
	if err != nil {
		return out, err
	}
	for _, a := range artists {
		if len(out.Artists) < limit && strings.Contains(fold(a.Artist), q) {
			out.Artists = append(out.Artists, a)
		}
	}

	albums, err := s.TopAlbums(ctx, userID, p, lookupScan)
	if err != nil {
		return out, err
	}
	for _, a := range albums {
		if len(out.Albums) < limit && (strings.Contains(fold(a.Album), q) || strings.Contains(fold(a.Artist), q)) {
			out.Albums = append(out.Albums, a)
		}
	}
	return out, nil
}

// fold normalises a name for matching: case, and the surrounding space.
//
// Lowercasing the Turkish dotted capital "İ" leaves "i" plus a combining dot
// (U+0307), which then matches no ordinary "i"; the dot is dropped so that
// "ÖTESİ" finds "ötesi".
func fold(s string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), "\u0307", "")
}

// MonthPlays is one bar of an item's listening history.
type MonthPlays struct {
	Month   string `json:"month"` // "2026-09"
	Plays   int    `json:"plays"`
	TotalMs int64  `json:"totalMs"`
}

// ItemDetail is the listener's own figures for one song, artist or album.
type ItemDetail struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	Artist   string `json:"artist,omitempty"`
	ArtistID string `json:"artistId,omitempty"`
	AlbumID  string `json:"albumId,omitempty"`
	Artwork  string `json:"artwork,omitempty"`

	Plays    int        `json:"plays"`
	Plays30d int        `json:"plays30d"`
	TotalMs  int64      `json:"totalMs"`
	Tracks   int        `json:"distinctTracks"`
	FirstAt  *time.Time `json:"firstPlayedAt,omitempty"`
	LastAt   *time.Time `json:"lastPlayedAt,omitempty"`
	// Rank is the position among the listener's own songs, artists or albums
	// of the same kind, by plays. Zero when never played.
	Rank int `json:"rank"`

	// Months is the last twelve months, oldest first, including empty ones so
	// the chart has a steady axis.
	Months []MonthPlays `json:"months"`
	// TopTracks is the most-played songs within an artist or album.
	TopTracks []TrackStat `json:"topTracks"`
}

// scopeFor turns a kind into the column expression its key is matched on.
func scopeFor(kind string) (string, error) {
	switch kind {
	case "track":
		return "track_id", nil
	case "artist":
		return artistKey, nil
	case "album":
		return albumKey, nil
	}
	return "", fmt.Errorf("control: unknown kind %q", kind)
}

// Detail gathers the figures for one song, artist or album. The ID is the
// same key the lists and the lookup return.
func (s *Store) Detail(ctx context.Context, userID int64, kind, id string) (ItemDetail, error) {
	out := ItemDetail{Kind: kind, ID: id, Months: []MonthPlays{}, TopTracks: []TrackStat{}}
	scope, err := scopeFor(kind)
	if err != nil {
		return out, err
	}
	where := `user_id = ? AND ` + scope + ` = ? AND ` + countedPlays

	var first, last sqlTime
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(played_ms), 0), COUNT(DISTINCT track_id),
		       MIN(played_at), MAX(played_at),
		       COALESCE(MAX(CASE WHEN ? = 'track' THEN title WHEN ? = 'artist' THEN artist ELSE album END), ''),
		       COALESCE(MAX(artist), ''), COALESCE(MAX(artist_id), ''), COALESCE(MAX(album_id), ''),
		       COALESCE(MAX(artwork), '')
		FROM plays WHERE `+where,
		kind, kind, userID, id).Scan(&out.Plays, &out.TotalMs, &out.Tracks, &first, &last,
		&out.Name, &out.Artist, &out.ArtistID, &out.AlbumID, &out.Artwork); err != nil {
		return out, fmt.Errorf("control: detail: %w", err)
	}
	if out.Plays == 0 {
		return out, nil
	}
	if first.Valid {
		out.FirstAt = &first.Time
	}
	if last.Valid {
		out.LastAt = &last.Time
	}

	cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour)
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM plays WHERE `+where+` AND played_at >= ?`,
		userID, id, cutoff).Scan(&out.Plays30d); err != nil {
		return out, err
	}

	// Rank among the listener's own of the same kind.
	nonEmpty := map[string]string{"track": "track_id <> ''", "artist": "artist <> ''", "album": "album <> ''"}[kind]
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) + 1 FROM (
			SELECT `+scope+` AS k, COUNT(*) AS n FROM plays
			WHERE user_id = ? AND `+nonEmpty+` AND `+countedPlays+`
			GROUP BY k HAVING n > ?
		)`, userID, out.Plays).Scan(&out.Rank); err != nil {
		return out, err
	}

	if out.Months, err = s.months(ctx, where, userID, id); err != nil {
		return out, err
	}

	if kind != "track" {
		rows, err := s.db.QueryContext(ctx, `
			SELECT track_id, MAX(title), MAX(artist), MAX(artist_id),
			       COUNT(*), SUM(played_ms), MAX(played_at), MAX(artwork)
			FROM plays WHERE `+where+`
			GROUP BY track_id
			ORDER BY COUNT(*) DESC, SUM(played_ms) DESC
			LIMIT 20`, userID, id)
		if err != nil {
			return out, err
		}
		defer rows.Close()
		for rows.Next() {
			var t TrackStat
			var at sqlTime
			if err := rows.Scan(&t.TrackID, &t.Title, &t.Artist, &t.ArtistID,
				&t.Plays, &t.TotalMs, &at, &t.Artwork); err != nil {
				return out, err
			}
			t.LastAt = at.Time
			out.TopTracks = append(out.TopTracks, t)
		}
		if err := rows.Err(); err != nil {
			return out, err
		}
	}
	return out, nil
}

// months buckets an item's plays by local month over the last year.
//
// Done in Go rather than with strftime: timestamps are stored in the driver's
// own text layout, which SQLite's date functions do not read.
func (s *Store) months(ctx context.Context, where string, userID int64, id string) ([]MonthPlays, error) {
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.Local).AddDate(0, -11, 0)
	rows, err := s.db.QueryContext(ctx, `SELECT played_at, played_ms FROM plays WHERE `+where+` AND played_at >= ?`,
		userID, id, start.UTC())
	if err != nil {
		return nil, fmt.Errorf("control: months: %w", err)
	}
	defer rows.Close()

	byMonth := map[string]*MonthPlays{}
	for rows.Next() {
		var at sqlTime
		var ms int64
		if err := rows.Scan(&at, &ms); err != nil {
			return nil, err
		}
		if !at.Valid {
			continue
		}
		key := at.Time.In(time.Local).Format("2006-01")
		m := byMonth[key]
		if m == nil {
			m = &MonthPlays{Month: key}
			byMonth[key] = m
		}
		m.Plays++
		m.TotalMs += ms
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]MonthPlays, 0, 12)
	for i := 0; i < 12; i++ {
		key := start.AddDate(0, i, 0).Format("2006-01")
		if m := byMonth[key]; m != nil {
			out = append(out, *m)
		} else {
			out = append(out, MonthPlays{Month: key})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Month < out[j].Month })
	return out, nil
}
