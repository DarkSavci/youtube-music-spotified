package catalog_test

import (
	"context"
	"os"
	"testing"

	"spotifier/internal/catalog"
	"spotifier/internal/domain"
	"spotifier/internal/innertube"
	"spotifier/internal/obs"
)

// Both adapters are exercised through the same interface, which is what makes
// the Catalog seam real rather than hypothetical.
func adapters(t *testing.T) map[string]catalog.Catalog {
	t.Helper()
	rec := obs.NewRecorder()
	out := map[string]catalog.Catalog{
		"fixture": catalog.NewFixture("../../testdata/fixtures", rec),
	}
	if os.Getenv("SPOTIFIER_LIVE") == "1" {
		creds, err := innertube.LoadCredentials("../../credentials.json")
		if err != nil {
			t.Fatalf("live requested but no credentials: %v", err)
		}
		out["innertube"] = catalog.NewInnerTube(
			innertube.New(innertube.WithCredentials(creds), innertube.WithLocale("en", "US")), rec)
	}
	return out
}

func TestCatalogHome(t *testing.T) {
	for name, c := range adapters(t) {
		t.Run(name, func(t *testing.T) {
			page, err := c.Home(context.Background())
			if err != nil {
				t.Fatalf("home: %v", err)
			}
			items := 0
			for _, sh := range page.Shelves {
				items += len(sh.Items)
			}
			t.Logf("%s home: %d shelves, %d items", name, len(page.Shelves), items)
			if len(page.Shelves) == 0 {
				t.Error("no shelves")
			}
		})
	}
}

func TestCatalogSearchAllFilters(t *testing.T) {
	filters := []domain.SearchFilter{
		domain.FilterNone, domain.FilterSongs, domain.FilterAlbums,
		domain.FilterArtists, domain.FilterPlaylists,
	}
	for name, c := range adapters(t) {
		for _, f := range filters {
			label := string(f)
			if label == "" {
				label = "all"
			}
			t.Run(name+"/"+label, func(t *testing.T) {
				res, err := c.Search(context.Background(), "daft punk", f)
				if err != nil {
					t.Fatalf("search: %v", err)
				}
				items := 0
				for _, sh := range res.Shelves {
					items += len(sh.Items)
				}
				if res.Query != "daft punk" {
					t.Errorf("query not echoed: %q", res.Query)
				}
				t.Logf("%s/%s: %d items", name, label, items)
				if items == 0 {
					t.Error("no results")
				}
			})
		}
	}
}

func TestCatalogEntities(t *testing.T) {
	for name, c := range adapters(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			// Discover real identifiers rather than hardcoding ones that rot.
			// The fixture adapter ignores the identifier by design, so only the
			// live adapter actually exercises the lookup.
			albumID, artistID := discoverIDs(t, c)

			al, err := c.Album(ctx, albumID)
			if err != nil {
				t.Errorf("album: %v", err)
			} else if al.Title == "" || len(al.Tracks) == 0 {
				t.Errorf("album thin: %+v", al.Title)
			} else {
				t.Logf("album %q: %d tracks", al.Title, len(al.Tracks))
			}

			ar, err := c.Artist(ctx, artistID)
			if err != nil {
				t.Errorf("artist: %v", err)
			} else if ar.Name == "" {
				t.Error("artist has no name")
			} else {
				t.Logf("artist %q: %d top, %d albums", ar.Name, len(ar.TopTracks), len(ar.Albums))
			}
		})
	}
}

// An unrecorded surface must report a gap plainly rather than returning an
// empty page that looks like a successful render.
func TestFixtureUnknownSurfaceIsLoud(t *testing.T) {
	f := catalog.NewFixture("../../testdata/fixtures", nil)
	if _, err := f.Browse(context.Background(), "FEmusic_not_recorded", ""); err == nil {
		t.Error("expected an error for an unrecorded surface")
	}
}

func TestFixtureEmptySearchState(t *testing.T) {
	f := catalog.NewFixture("../../testdata/fixtures", nil)
	res, err := f.Search(context.Background(), "nonexistent query", domain.FilterNone)
	if err != nil {
		t.Fatalf("empty search: %v", err)
	}
	items := 0
	for _, sh := range res.Shelves {
		items += len(sh.Items)
	}
	t.Logf("empty-state search returned %d items", items)
}

// discoverIDs finds a real album and artist identifier through the same
// Catalog under test, so the test has no hardcoded identifiers to go stale.
func discoverIDs(t *testing.T, c catalog.Catalog) (albumID, artistID string) {
	t.Helper()
	ctx := context.Background()

	res, err := c.Search(ctx, "daft punk", domain.FilterAlbums)
	if err != nil {
		t.Fatalf("discover albums: %v", err)
	}
	for _, sh := range res.Shelves {
		for _, it := range sh.Items {
			if it.Kind == domain.KindAlbum && it.Album != nil && it.Album.ID != "" {
				albumID = it.Album.ID
				break
			}
		}
	}
	res, err = c.Search(ctx, "daft punk", domain.FilterArtists)
	if err != nil {
		t.Fatalf("discover artists: %v", err)
	}
	for _, sh := range res.Shelves {
		for _, it := range sh.Items {
			if it.Kind == domain.KindArtist && it.Artist != nil && it.Artist.ID != "" {
				artistID = it.Artist.ID
				break
			}
		}
	}
	if albumID == "" || artistID == "" {
		t.Fatalf("could not discover ids (album=%q artist=%q)", albumID, artistID)
	}
	return albumID, artistID
}
