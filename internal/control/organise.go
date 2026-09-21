package control

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"spotifier/internal/domain"
)

/*
Pinning and folders.

Both were already in the schema, read on every library request and honoured by
the merged sort — and there was no way to set either. The tables were written
once, the reads were written once, and the writes were never written at all, so
a column that shapes the whole sidebar could only ever hold its default.

These belong to the Control plane rather than to YouTube: neither concept
exists upstream. That is also why they survive a track leaving the library and
coming back, and why they are ours to define.
*/

// SetPinned pins or unpins a library item.
//
// The row is created if it does not exist: an item can be pinned before it has
// ever been observed, and refusing would make the control depend on whether a
// library refresh had happened to run.
func (s *Store) SetPinned(ctx context.Context, userID int64, kind, itemID string, pinned bool) error {
	if itemID == "" {
		return fmt.Errorf("control: pin: empty item id")
	}
	flag := 0
	if pinned {
		flag = 1
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO library_meta (user_id, item_kind, item_id, pinned, first_seen_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(user_id, item_kind, item_id)
		DO UPDATE SET pinned = excluded.pinned
	`, userID, kind, itemID, flag, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("control: pin: %w", err)
	}
	return nil
}

// CreateFolder makes a folder and returns its identifier.
func (s *Store) CreateFolder(ctx context.Context, userID int64, name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("control: folder needs a name")
	}
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("control: folder id: %w", err)
	}
	id := "f_" + hex.EncodeToString(raw[:])

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO folders (id, user_id, name, parent_id, created_at)
		VALUES (?, ?, ?, '', ?)
	`, id, userID, name, time.Now().UTC())
	if err != nil {
		return "", fmt.Errorf("control: create folder: %w", err)
	}
	return id, nil
}

// DeleteFolder removes a folder and empties it.
//
// Items in it are returned to the top level rather than deleted: a folder is a
// way of arranging the library, and removing the arrangement must not remove
// what was arranged.
func (s *Store) DeleteFolder(ctx context.Context, userID int64, folderID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("control: delete folder: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`UPDATE library_meta SET folder_id = '' WHERE user_id = ? AND folder_id = ?`,
		userID, folderID); err != nil {
		return fmt.Errorf("control: empty folder: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM folders WHERE user_id = ? AND id = ?`, userID, folderID); err != nil {
		return fmt.Errorf("control: delete folder: %w", err)
	}
	return tx.Commit()
}

// Folders lists the user's folders, oldest first.
func (s *Store) Folders(ctx context.Context, userID int64) ([]domain.Folder, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name FROM folders WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, fmt.Errorf("control: folders: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []domain.Folder{}
	for rows.Next() {
		var f domain.Folder
		if err := rows.Scan(&f.ID, &f.Name); err != nil {
			return nil, fmt.Errorf("control: folders: %w", err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// SetFolder moves a library item into a folder, or out of one when folderID is
// empty.
func (s *Store) SetFolder(ctx context.Context, userID int64, kind, itemID, folderID string) error {
	if itemID == "" {
		return fmt.Errorf("control: set folder: empty item id")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO library_meta (user_id, item_kind, item_id, folder_id, first_seen_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(user_id, item_kind, item_id)
		DO UPDATE SET folder_id = excluded.folder_id
	`, userID, kind, itemID, folderID, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("control: set folder: %w", err)
	}
	return nil
}
