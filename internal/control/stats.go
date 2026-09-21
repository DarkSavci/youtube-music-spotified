package control

import (
	"context"
	"fmt"
	"time"

	"spotifier/internal/domain"
)

/*
Derived surfaces.

These are the queries behind two deliberate deviations: personal
listening figures on an artist page in place of global vanity metrics, and
mixes generated from the Play log.

They are plain aggregations, which is why On Repeat and the period mixes come
first: they need no recommendation machinery at all, only a GROUP BY over data
nobody else will show the user.
*/

// Period bounds a statistics query.
type Period struct {
	From time.Time
	To   time.Time
}

// Last returns a Period covering the given span up to now.
func Last(d time.Duration) Period {
	now := time.Now().UTC()
	return Period{From: now.Add(-d), To: now}
}

// TrackStat is one row of an aggregate over tracks.
type TrackStat struct {
	TrackID  string    `json:"trackId"`
	Title    string    `json:"title"`
	Artist   string    `json:"artist"`
	ArtistID string    `json:"artistId,omitempty"`
	Plays    int       `json:"plays"`
	TotalMs  int64     `json:"totalMs"`
	LastAt   time.Time `json:"lastPlayedAt"`
	Artwork  string    `json:"artwork,omitempty"`
}

// ArtistStat is one row of an aggregate over artists.
type ArtistStat struct {
	ArtistID string    `json:"artistId"`
	Artist   string    `json:"artist"`
	Plays    int       `json:"plays"`
	Tracks   int       `json:"distinctTracks"`
	TotalMs  int64     `json:"totalMs"`
	LastAt   time.Time `json:"lastPlayedAt"`
}

// ArtistAffinity is what an artist page shows in place of monthly listeners
// and a world ranking, neither of which YouTube Music exposes.
//
// This is the better trade rather than a fallback: a global listener count is
// a fact about strangers, whereas this is the reader's own history and only we
// can render it.
type ArtistAffinity struct {
	ArtistID string     `json:"artistId"`
	Plays30d int        `json:"plays30d"`
	PlaysAll int        `json:"playsAllTime"`
	Rank     int        `json:"rankAmongYourArtists"`
	FirstAt  *time.Time `json:"firstListenedAt,omitempty"`
	LastAt   *time.Time `json:"lastPlayedAt,omitempty"`
	TotalMs  int64      `json:"totalMs"`
}

// Only listens that actually counted are aggregated. Failed attempts are
// recorded for diagnostics but must never inflate a statistic.
const countedPlays = `failed = 0 AND played_ms > 0`

// TopTracks returns the most-played tracks in a period.
func (s *Store) TopTracks(ctx context.Context, userID int64, p Period, limit int) ([]TrackStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT track_id,
		       MAX(title), MAX(artist), MAX(artist_id),
		       COUNT(*), SUM(played_ms), MAX(played_at), MAX(artwork)
		FROM plays
		WHERE user_id = ? AND played_at BETWEEN ? AND ? AND `+countedPlays+`
		GROUP BY track_id
		ORDER BY COUNT(*) DESC, SUM(played_ms) DESC
		LIMIT ?`, userID, p.From.UTC(), p.To.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("control: top tracks: %w", err)
	}
	defer rows.Close()

	var out []TrackStat
	for rows.Next() {
		var t TrackStat
		var last sqlTime
		if err := rows.Scan(&t.TrackID, &t.Title, &t.Artist, &t.ArtistID,
			&t.Plays, &t.TotalMs, &last, &t.Artwork); err != nil {
			return nil, err
		}
		t.LastAt = last.Time
		out = append(out, t)
	}
	return out, rows.Err()
}

// TopArtists returns the most-played artists in a period.
func (s *Store) TopArtists(ctx context.Context, userID int64, p Period, limit int) ([]ArtistStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(artist_id, ''), artist) AS aid,
		       MAX(artist), COUNT(*), COUNT(DISTINCT track_id),
		       SUM(played_ms), MAX(played_at)
		FROM plays
		WHERE user_id = ? AND played_at BETWEEN ? AND ? AND `+countedPlays+`
		  AND artist <> ''
		GROUP BY aid
		ORDER BY COUNT(*) DESC
		LIMIT ?`, userID, p.From.UTC(), p.To.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("control: top artists: %w", err)
	}
	defer rows.Close()

	var out []ArtistStat
	for rows.Next() {
		var a ArtistStat
		var last sqlTime
		if err := rows.Scan(&a.ArtistID, &a.Artist, &a.Plays, &a.Tracks,
			&a.TotalMs, &last); err != nil {
			return nil, err
		}
		a.LastAt = last.Time
		out = append(out, a)
	}
	return out, rows.Err()
}

// Affinity computes the reader's own relationship with one artist.
func (s *Store) Affinity(ctx context.Context, userID int64, artistID string) (ArtistAffinity, error) {
	out := ArtistAffinity{ArtistID: artistID}
	if artistID == "" {
		return out, nil
	}

	var first, last sqlTime
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(played_ms), 0), MIN(played_at), MAX(played_at)
		FROM plays
		WHERE user_id = ? AND artist_id = ? AND `+countedPlays,
		userID, artistID).Scan(&out.PlaysAll, &out.TotalMs, &first, &last)
	if err != nil {
		return out, fmt.Errorf("control: affinity: %w", err)
	}
	if first.Valid {
		out.FirstAt = &first.Time
	}
	if last.Valid {
		out.LastAt = &last.Time
	}

	cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour)
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM plays
		WHERE user_id = ? AND artist_id = ? AND played_at >= ? AND `+countedPlays,
		userID, artistID, cutoff).Scan(&out.Plays30d); err != nil {
		return out, err
	}

	// Rank among the listener's own artists, which is the figure that means
	// something to them.
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) + 1 FROM (
			SELECT artist_id, COUNT(*) AS n FROM plays
			WHERE user_id = ? AND artist_id <> '' AND `+countedPlays+`
			GROUP BY artist_id
			HAVING n > (
				SELECT COUNT(*) FROM plays
				WHERE user_id = ? AND artist_id = ? AND `+countedPlays+`
			)
		)`, userID, userID, artistID).Scan(&out.Rank); err != nil {
		return out, err
	}
	if out.PlaysAll == 0 {
		out.Rank = 0
	}
	return out, nil
}

// OnRepeat is the tracks played most in the recent past.
//
// No recommendation logic: it is a GROUP BY over the listener's own history,
// which is exactly why it is worth shipping before anything cleverer.
func (s *Store) OnRepeat(ctx context.Context, userID int64, limit int) ([]TrackStat, error) {
	return s.TopTracks(ctx, userID, Last(30*24*time.Hour), limit)
}

// LastPlayed returns when each of the given library items was last played,
// which is what the Recents sort in the sidebar orders by.
func (s *Store) LastPlayed(ctx context.Context, userID int64, artistIDs, albumIDs []string) (map[string]time.Time, error) {
	out := map[string]time.Time{}
	if len(artistIDs) == 0 && len(albumIDs) == 0 {
		return out, nil
	}
	query := func(column string, ids []string) error {
		if len(ids) == 0 {
			return nil
		}
		rows, err := s.db.QueryContext(ctx, `
			SELECT `+column+`, MAX(played_at) FROM plays
			WHERE user_id = ? AND `+column+` <> '' AND `+countedPlays+`
			GROUP BY `+column, userID)
		if err != nil {
			return err
		}
		defer rows.Close()
		wanted := make(map[string]bool, len(ids))
		for _, id := range ids {
			wanted[id] = true
		}
		for rows.Next() {
			var id string
			var at sqlTime
			if err := rows.Scan(&id, &at); err != nil {
				return err
			}
			if wanted[id] && at.Valid {
				out[id] = at.Time
			}
		}
		return rows.Err()
	}
	if err := query("artist_id", artistIDs); err != nil {
		return nil, err
	}
	if err := query("album_id", albumIDs); err != nil {
		return nil, err
	}
	return out, nil
}

// Enrich fills the fields YouTube Music cannot supply, satisfying the
// library.Metadata seam so the sidebar's Recents and Recently-added sorts work.
func (s *Store) Enrich(ctx context.Context, items []domain.LibraryItem) error {
	if len(items) == 0 {
		return nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT item_kind, item_id, folder_id, pinned, first_seen_at
		FROM library_meta WHERE user_id = ?`, DefaultUserID)
	if err != nil {
		return err
	}
	defer rows.Close()

	type meta struct {
		folderID  string
		pinned    bool
		firstSeen time.Time
	}
	byKey := map[string]meta{}
	for rows.Next() {
		var kind, id, folder string
		var pinned int
		var seen sqlTime
		if err := rows.Scan(&kind, &id, &folder, &pinned, &seen); err != nil {
			return err
		}
		byKey[kind+":"+id] = meta{folder, pinned == 1, seen.Time}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	var artistIDs, albumIDs []string
	for _, it := range items {
		switch it.Kind {
		case domain.LibArtist:
			artistIDs = append(artistIDs, it.ID)
		case domain.LibAlbum:
			albumIDs = append(albumIDs, it.ID)
		}
	}
	lastPlayed, err := s.LastPlayed(ctx, DefaultUserID, artistIDs, albumIDs)
	if err != nil {
		return err
	}

	for i := range items {
		if m, ok := byKey[string(items[i].Kind)+":"+items[i].ID]; ok {
			items[i].FolderID = m.folderID
			// Never clear a pin the merge already set, such as Liked Music.
			items[i].Pinned = items[i].Pinned || m.pinned
			seen := m.firstSeen
			items[i].AddedAt = &seen
		}
		if at, ok := lastPlayed[items[i].ID]; ok {
			t := at
			items[i].LastPlayedAt = &t
		}
	}
	return nil
}
