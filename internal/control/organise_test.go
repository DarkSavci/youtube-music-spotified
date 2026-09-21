package control_test

import (
	"context"
	"path/filepath"
	"testing"

	"spotifier/internal/control"
	"spotifier/internal/domain"
)

func openStore(t *testing.T) *control.Store {
	t.Helper()
	s, err := control.Open(context.Background(), filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

/*
Pinning and folders were readable and sortable before anything could set them.

The schema, the reads and the merged sort all existed; only the writes were
missing, so the columns that shape the sidebar could hold nothing but their
defaults. These tests exist so that cannot silently return.
*/
func TestPinSurvivesAndClears(t *testing.T) {
	ctx := context.Background()
	s := openStore(t)

	if err := s.SetPinned(ctx, control.DefaultUserID, "playlist", "PL1", true); err != nil {
		t.Fatal(err)
	}
	items := []domain.LibraryItem{{Kind: domain.LibPlaylist, ID: "PL1"}}
	if err := s.Enrich(ctx, items); err != nil {
		t.Fatal(err)
	}
	if !items[0].Pinned {
		t.Fatal("pin did not survive a round trip")
	}

	if err := s.SetPinned(ctx, control.DefaultUserID, "playlist", "PL1", false); err != nil {
		t.Fatal(err)
	}
	items = []domain.LibraryItem{{Kind: domain.LibPlaylist, ID: "PL1"}}
	if err := s.Enrich(ctx, items); err != nil {
		t.Fatal(err)
	}
	if items[0].Pinned {
		t.Fatal("unpin did not take")
	}
}

// An item can be pinned before a library refresh has ever observed it;
// refusing would make the control depend on invisible timing.
func TestPinWorksForAnUnobservedItem(t *testing.T) {
	ctx := context.Background()
	s := openStore(t)
	if err := s.SetPinned(ctx, control.DefaultUserID, "album", "never-seen", true); err != nil {
		t.Fatalf("pinning an unobserved item failed: %v", err)
	}
}

// Deleting a folder must not delete what was in it: a folder is a way of
// arranging the library, not a container that owns its contents.
func TestDeletingAFolderReturnsItemsToTheTopLevel(t *testing.T) {
	ctx := context.Background()
	s := openStore(t)

	id, err := s.CreateFolder(ctx, control.DefaultUserID, "Jazz")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetFolder(ctx, control.DefaultUserID, "album", "A1", id); err != nil {
		t.Fatal(err)
	}

	items := []domain.LibraryItem{{Kind: domain.LibAlbum, ID: "A1"}}
	if err := s.Enrich(ctx, items); err != nil {
		t.Fatal(err)
	}
	if items[0].FolderID != id {
		t.Fatalf("folder = %q, want %q", items[0].FolderID, id)
	}

	if err := s.DeleteFolder(ctx, control.DefaultUserID, id); err != nil {
		t.Fatal(err)
	}
	items = []domain.LibraryItem{{Kind: domain.LibAlbum, ID: "A1"}}
	if err := s.Enrich(ctx, items); err != nil {
		t.Fatal(err)
	}
	if items[0].FolderID != "" {
		t.Fatalf("item still filed under a deleted folder: %q", items[0].FolderID)
	}

	folders, err := s.Folders(ctx, control.DefaultUserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 0 {
		t.Fatalf("folders = %+v, want none", folders)
	}
}

// Pinning and filing share a row but are independent decisions.
func TestPinAndFolderDoNotOverwriteEachOther(t *testing.T) {
	ctx := context.Background()
	s := openStore(t)

	id, err := s.CreateFolder(ctx, control.DefaultUserID, "Live")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetFolder(ctx, control.DefaultUserID, "artist", "UC1", id); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPinned(ctx, control.DefaultUserID, "artist", "UC1", true); err != nil {
		t.Fatal(err)
	}

	items := []domain.LibraryItem{{Kind: domain.LibArtist, ID: "UC1"}}
	if err := s.Enrich(ctx, items); err != nil {
		t.Fatal(err)
	}
	if !items[0].Pinned || items[0].FolderID != id {
		t.Fatalf("pinning cleared the folder or vice versa: %+v", items[0])
	}
}
