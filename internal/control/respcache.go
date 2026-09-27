package control

import (
	"context"
	"fmt"
	"strings"
	"time"

	"spotifier/internal/respcache"
)

// maxResponses bounds the kept answers. At a few kilobytes to a few hundred
// each this is tens of megabytes at most; the oldest go first.
const maxResponses = 4000

var _ respcache.Persist = (*Store)(nil)

// LoadResponse reads a kept answer.
func (s *Store) LoadResponse(ctx context.Context, key string) (respcache.Entry, bool) {
	var (
		e       respcache.Entry
		stored  sqlTime
		expired int
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT status, body, stored_at, expired FROM response_cache WHERE key = ? AND keep_until > ?`,
		key, time.Now().UTC()).Scan(&e.Status, &e.Body, &stored, &expired)
	if err != nil || !stored.Valid {
		return respcache.Entry{}, false
	}
	e.StoredAt = stored.Time
	e.Expired = expired != 0
	return e, true
}

// SaveResponse keeps an answer until keepUntil.
func (s *Store) SaveResponse(ctx context.Context, key string, e respcache.Entry, keepUntil time.Time) error {
	expired := 0
	if e.Expired {
		expired = 1
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO response_cache (key, status, body, stored_at, keep_until, expired)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			status = excluded.status, body = excluded.body, stored_at = excluded.stored_at,
			keep_until = excluded.keep_until, expired = excluded.expired`,
		key, e.Status, e.Body, e.StoredAt.UTC(), keepUntil.UTC(), expired)
	if err != nil {
		return fmt.Errorf("control: save response: %w", err)
	}
	return nil
}

// DeleteResponses drops every kept answer whose key starts with prefix.
func (s *Store) DeleteResponses(ctx context.Context, prefix string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM response_cache WHERE key LIKE ? ESCAPE '\'`, likePrefix(prefix))
	return err
}

// ExpireResponses marks the answers under prefix out of date, keeping them.
func (s *Store) ExpireResponses(ctx context.Context, prefix string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE response_cache SET expired = 1 WHERE key LIKE ? ESCAPE '\'`, likePrefix(prefix))
	return err
}

// pruneResponses drops answers past their keep date, then the oldest beyond
// the cap.
func (s *Store) pruneResponses(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM response_cache WHERE keep_until <= ?`, time.Now().UTC()); err != nil {
		return fmt.Errorf("control: prune responses: %w", err)
	}
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM response_cache WHERE key IN (
			SELECT key FROM response_cache ORDER BY stored_at DESC LIMIT -1 OFFSET ?)`, maxResponses)
	if err != nil {
		return fmt.Errorf("control: cap responses: %w", err)
	}
	return nil
}

func likePrefix(prefix string) string {
	r := strings.NewReplacer(`\`, `\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(prefix) + "%"
}
