package control

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"spotifier/internal/respcache"
)

/*
Responses keeps answers read from YouTube, so a restart does not ask for them
all again.

It is a file of its own beside the account's database, not a table in it. The
account's database holds listening history, which stays when the account signs
out; the answers include the account's own library and likes, which must not.
Keeping them apart lets the desktop shell delete this file on sign-out and on
removing an account, whether or not that account is the one running.
*/
type Responses struct {
	db *sql.DB
}

// Caps on the kept answers; the oldest go first.
const (
	maxResponses     = 4000
	maxResponseBytes = 256 << 20
)

var _ respcache.Persist = (*Responses)(nil)

// ResponsesFile is the name of the file, beside the account database, that
// the desktop shell deletes to forget an account's cached answers.
const ResponsesFile = "responses.db"

// OpenResponses opens (or creates) the answers file.
func OpenResponses(ctx context.Context, path string) (*Responses, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("responses: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	r := &Responses{db: db}
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS responses (
			key         TEXT PRIMARY KEY,
			status      INTEGER NOT NULL,
			body        BLOB NOT NULL,
			stored_at   TIMESTAMP NOT NULL,
			keep_until  TIMESTAMP NOT NULL,
			fresh_until TIMESTAMP,
			expired     INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS responses_keep ON responses(keep_until)`,
		`CREATE INDEX IF NOT EXISTS responses_stored ON responses(stored_at)`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("responses: migrate: %w", err)
		}
	}
	if err := r.PruneResponses(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return r, nil
}

func (r *Responses) Close() error { return r.db.Close() }

// LoadResponse reads a kept answer.
func (r *Responses) LoadResponse(ctx context.Context, key string) (respcache.Entry, bool) {
	var (
		e       respcache.Entry
		stored  sqlTime
		fresh   sqlTime
		expired int
	)
	err := r.db.QueryRowContext(ctx,
		`SELECT status, body, stored_at, fresh_until, expired FROM responses WHERE key = ? AND keep_until > ?`,
		key, time.Now().UTC()).Scan(&e.Status, &e.Body, &stored, &fresh, &expired)
	if err != nil || !stored.Valid {
		return respcache.Entry{}, false
	}
	e.StoredAt = stored.Time
	if fresh.Valid {
		e.FreshUntil = fresh.Time
	}
	e.Expired = expired != 0
	return e, true
}

// SaveResponse keeps an answer until keepUntil.
func (r *Responses) SaveResponse(ctx context.Context, key string, e respcache.Entry, keepUntil time.Time) error {
	expired := 0
	if e.Expired {
		expired = 1
	}
	var fresh any
	if !e.FreshUntil.IsZero() {
		fresh = e.FreshUntil.UTC()
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO responses (key, status, body, stored_at, keep_until, fresh_until, expired)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			status = excluded.status, body = excluded.body, stored_at = excluded.stored_at,
			keep_until = excluded.keep_until, fresh_until = excluded.fresh_until, expired = excluded.expired`,
		key, e.Status, e.Body, e.StoredAt.UTC(), keepUntil.UTC(), fresh, expired)
	if err != nil {
		return fmt.Errorf("responses: save: %w", err)
	}
	return nil
}

// DeleteResponses drops every kept answer whose key starts with prefix.
func (r *Responses) DeleteResponses(ctx context.Context, prefix string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM responses WHERE key LIKE ? ESCAPE '\'`, likePrefix(prefix))
	return err
}

// ExpireResponses marks the answers under prefix out of date, keeping them.
func (r *Responses) ExpireResponses(ctx context.Context, prefix string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE responses SET expired = 1 WHERE key LIKE ? ESCAPE '\'`, likePrefix(prefix))
	return err
}

// PruneResponses drops answers past their keep date, then the oldest beyond
// the row and byte caps.
func (r *Responses) PruneResponses(ctx context.Context) error {
	if _, err := r.db.ExecContext(ctx, `DELETE FROM responses WHERE keep_until <= ?`, time.Now().UTC()); err != nil {
		return fmt.Errorf("responses: prune: %w", err)
	}
	if _, err := r.db.ExecContext(ctx, `
		DELETE FROM responses WHERE key IN (
			SELECT key FROM responses ORDER BY stored_at DESC LIMIT -1 OFFSET ?)`, maxResponses); err != nil {
		return fmt.Errorf("responses: cap rows: %w", err)
	}
	if _, err := r.db.ExecContext(ctx, `
		DELETE FROM responses WHERE key IN (
			SELECT key FROM (
				SELECT key, SUM(length(body)) OVER (ORDER BY stored_at DESC, key) AS total FROM responses
			) WHERE total > ?)`, maxResponseBytes); err != nil {
		return fmt.Errorf("responses: cap bytes: %w", err)
	}
	return nil
}

func likePrefix(prefix string) string {
	rp := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return rp.Replace(prefix) + "%"
}
