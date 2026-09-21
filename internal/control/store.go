// Package control owns the data YouTube Music does not have.
//
// The Play log, Folders, pins and everything derived from them are ours: a
// user's listening history at full fidelity, kept locally, with no product
// reason to withhold any of it. That is what makes the personal statistics in
// and the generated mixes in §3 possible at all.
//
// This is an ordinary application database with no YouTube involvement, which
// is precisely why it is one of the two planes that could later move to a
// server without carrying any credential with it.
package control

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// DefaultUserID is used in local mode.
//
// Every table still carries a user column even though it is always this value
// here. Adding one later means a migration across live data; carrying it from
// the start costs nothing.
const DefaultUserID = 1

// Store is the Control plane's persistence.
type Store struct {
	db *sql.DB
}

// Open connects to a SQLite database and applies the schema.
//
// The driver is pure Go, so the desktop build needs no cgo toolchain and
// cross-compiles cleanly.
func Open(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, fmt.Errorf("control: open: %w", err)
	}
	// SQLite tolerates one writer. Letting the pool open many connections
	// converts contention into SQLITE_BUSY errors rather than queuing.
	db.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// migrate applies the schema. Statements are idempotent so startup can always
// run them.
func (s *Store) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS plays (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id      INTEGER NOT NULL,
			-- Client-generated so an offline client can sync without
			-- duplicating rows it already sent.
			event_uuid   TEXT NOT NULL,
			track_id     TEXT NOT NULL,
			title        TEXT NOT NULL DEFAULT '',
			artist       TEXT NOT NULL DEFAULT '',
			artist_id    TEXT NOT NULL DEFAULT '',
			album        TEXT NOT NULL DEFAULT '',
			album_id     TEXT NOT NULL DEFAULT '',
			played_ms    INTEGER NOT NULL DEFAULT 0,
			completed    INTEGER NOT NULL DEFAULT 0,
			failed       INTEGER NOT NULL DEFAULT 0,
			fail_reason  TEXT NOT NULL DEFAULT '',
			origin       TEXT NOT NULL DEFAULT '',
			played_at    TIMESTAMP NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS plays_event_uuid ON plays(user_id, event_uuid)`,
		`CREATE INDEX IF NOT EXISTS plays_at ON plays(user_id, played_at DESC)`,
		`CREATE INDEX IF NOT EXISTS plays_track ON plays(user_id, track_id)`,
		`CREATE INDEX IF NOT EXISTS plays_artist ON plays(user_id, artist_id)`,

		`CREATE TABLE IF NOT EXISTS folders (
			id         TEXT PRIMARY KEY,
			user_id    INTEGER NOT NULL,
			name       TEXT NOT NULL,
			parent_id  TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS folders_user ON folders(user_id)`,

		// first_seen_at is what makes a "Recently added" sort possible.
		// YouTube Music does not record when an item entered the library, so
		// rows appear the first time we observe them and are NULL before that.
		`CREATE TABLE IF NOT EXISTS library_meta (
			user_id       INTEGER NOT NULL,
			item_kind     TEXT NOT NULL,
			item_id       TEXT NOT NULL,
			folder_id     TEXT NOT NULL DEFAULT '',
			pinned        INTEGER NOT NULL DEFAULT 0,
			first_seen_at TIMESTAMP NOT NULL,
			PRIMARY KEY (user_id, item_kind, item_id)
		)`,

		// Resolved stream URLs, so a replay or a restart within their
		// lifetime (about six hours, read from the URL itself) skips running
		// yt-dlp again. The blob is the API layer's own record.
		`CREATE TABLE IF NOT EXISTS stream_urls (
			video_id   TEXT PRIMARY KEY,
			entry      BLOB NOT NULL,
			expires_at TIMESTAMP NOT NULL
		)`,

		// Where the listener left off, so closing the app is not the same as
		// throwing the queue away. One row: this is the latest state, not a
		// history. The blob is the session's own snapshot format, which keeps
		// the playback shape out of the schema — it has changed before and
		// will again, and a migration per field is not worth it.
		`CREATE TABLE IF NOT EXISTS resume_state (
			user_id  INTEGER PRIMARY KEY,
			snapshot BLOB NOT NULL,
			saved_at TIMESTAMP NOT NULL
		)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("control: migrate: %w\n%s", err, stmt)
		}
	}
	// Covers came to the play log later; a database from before gets the
	// column. SQLite has no ADD COLUMN IF NOT EXISTS, so "duplicate column"
	// on every later start is the expected answer.
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE plays ADD COLUMN artwork TEXT NOT NULL DEFAULT ''`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		return fmt.Errorf("control: add artwork column: %w", err)
	}
	// Expired URLs are no use to anyone. Compared in Go's own time format,
	// the one they were written in, rather than SQLite's.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM stream_urls WHERE expires_at <= ?`, time.Now().UTC()); err != nil {
		return fmt.Errorf("control: prune stream urls: %w", err)
	}
	return s.repairArtists(ctx)
}

/*
repairArtists mends play rows recorded with a card's whole subtitle line as
the artist ("Song • Duman", "Dolu Kadehi Ters Tut • 192K views"), which split
one artist across several Top artists rows. The name is cut back to the
artist, and a row without an artist id borrows one from another play of the
same artist, so the two group together. Idempotent: clean rows are untouched.
*/
func (s *Store) repairArtists(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT artist FROM plays WHERE artist LIKE '%•%'`)
	if err != nil {
		return fmt.Errorf("control: repair artists: %w", err)
	}
	var dirty []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err == nil {
			dirty = append(dirty, a)
		}
	}
	rows.Close()
	for _, a := range dirty {
		if _, err := s.db.ExecContext(ctx, `UPDATE plays SET artist = ? WHERE artist = ?`, cleanArtist(a), a); err != nil {
			return fmt.Errorf("control: repair artists: %w", err)
		}
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE plays SET artist_id = (
			SELECT p.artist_id FROM plays p
			WHERE p.user_id = plays.user_id AND p.artist = plays.artist AND p.artist_id <> ''
			LIMIT 1)
		WHERE artist_id = '' AND artist <> '' AND EXISTS (
			SELECT 1 FROM plays p
			WHERE p.user_id = plays.user_id AND p.artist = plays.artist AND p.artist_id <> '')`)
	if err != nil {
		return fmt.Errorf("control: repair artist ids: %w", err)
	}
	return nil
}

// cleanArtist is the first part of a subtitle line that is not a type label,
// a count, a duration or a year.
func cleanArtist(line string) string {
	for _, part := range strings.Split(line, "•") {
		p := strings.TrimSpace(part)
		l := strings.ToLower(p)
		switch {
		case p == "",
			l == "song", l == "video", l == "album", l == "single", l == "ep", l == "episode",
			strings.HasSuffix(l, "views"), strings.HasSuffix(l, "plays"),
			reClock.MatchString(p), reYear.MatchString(p):
			continue
		}
		return p
	}
	return strings.TrimSpace(line)
}

var (
	reClock = regexp.MustCompile(`^\d{1,2}(:\d{2}){1,2}$`)
	reYear  = regexp.MustCompile(`^(19|20)\d{2}$`)
)

// ---------- stream URLs ----------

// SaveStreamURL remembers a resolution until it expires.
func (s *Store) SaveStreamURL(ctx context.Context, videoID string, entry []byte, expires time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO stream_urls (video_id, entry, expires_at) VALUES (?, ?, ?)
		 ON CONFLICT(video_id) DO UPDATE SET entry = excluded.entry, expires_at = excluded.expires_at`,
		videoID, entry, expires.UTC())
	return err
}

// StreamURL returns a remembered resolution that has not yet expired.
func (s *Store) StreamURL(ctx context.Context, videoID string) ([]byte, bool) {
	var entry []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT entry FROM stream_urls WHERE video_id = ? AND expires_at > ?`,
		videoID, time.Now().UTC()).Scan(&entry)
	return entry, err == nil
}

// DropStreamURL forgets a resolution upstream has refused.
func (s *Store) DropStreamURL(ctx context.Context, videoID string) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM stream_urls WHERE video_id = ?`, videoID)
}

// ---------- resume ----------

/*
SaveResume records where the listener is, replacing whatever was there.

Called often — every few seconds while something plays — so it is a single
upsert against one row rather than an append. A failure is logged and ignored
by the caller: losing the resume point is a disappointment, not a fault.
*/
func (s *Store) SaveResume(ctx context.Context, userID int64, snapshot []byte) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO resume_state (user_id, snapshot, saved_at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET snapshot = excluded.snapshot, saved_at = excluded.saved_at`,
		userID, snapshot, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("control: save resume: %w", err)
	}
	return nil
}

// Resume returns the last saved snapshot, or nil when there is none.
func (s *Store) Resume(ctx context.Context, userID int64) ([]byte, error) {
	var blob []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT snapshot FROM resume_state WHERE user_id = ?`, userID).Scan(&blob)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("control: read resume: %w", err)
	}
	return blob, nil
}

// ClearResume forgets the resume point, for when the listener asks not to be
// remembered.
func (s *Store) ClearResume(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM resume_state WHERE user_id = ?`, userID)
	return err
}

// ---------- play log ----------

// Play is one listening event.
type Play struct {
	EventUUID  string
	TrackID    string
	Title      string
	Artist     string
	ArtistID   string
	Album      string
	AlbumID    string
	PlayedMs   int64
	Completed  bool
	Failed     bool
	FailReason string
	Origin     string
	PlayedAt   time.Time
	// Artwork is the track's cover URL, so what is built from the log
	// later — On Repeat — has a picture without looking the track up.
	Artwork string
}

// RecordPlays appends listening events.
//
// Writes are idempotent on the client-generated identifier, so a client that
// retries after a dropped connection cannot double-count a listen — which
// would quietly corrupt every statistic derived from this table.
func (s *Store) RecordPlays(ctx context.Context, userID int64, plays []Play) error {
	if len(plays) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO plays (user_id, event_uuid, track_id, title, artist, artist_id,
		                   album, album_id, played_ms, completed, failed, fail_reason,
		                   origin, played_at, artwork)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id, event_uuid) DO NOTHING`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, p := range plays {
		if p.TrackID == "" || p.EventUUID == "" {
			continue
		}
		if p.PlayedAt.IsZero() {
			p.PlayedAt = time.Now()
		}
		if _, err := stmt.ExecContext(ctx, userID, p.EventUUID, p.TrackID, p.Title,
			p.Artist, p.ArtistID, p.Album, p.AlbumID, p.PlayedMs,
			boolToInt(p.Completed), boolToInt(p.Failed), p.FailReason,
			p.Origin, p.PlayedAt.UTC(), p.Artwork); err != nil {
			return fmt.Errorf("control: record play: %w", err)
		}
	}
	return tx.Commit()
}

// ---------- library metadata ----------

// ObserveLibrary records that these items exist, stamping anything new with
// the moment it was first seen.
//
// Items present before the app was installed have no first-seen date and
// legitimately never will. They surface as an em dash and sort last, which is
// honest, rather than being back-filled with a fabricated date.
func (s *Store) ObserveLibrary(ctx context.Context, userID int64, kind string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO library_meta (user_id, item_kind, item_id, first_seen_at)
		VALUES (?,?,?,?)
		ON CONFLICT(user_id, item_kind, item_id) DO NOTHING`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	now := time.Now().UTC()
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, err := stmt.ExecContext(ctx, userID, kind, id, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
