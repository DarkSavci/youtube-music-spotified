// Package catalog serves public YouTube Music metadata.
//
// It is a deep module: behind seven methods sit transport, request signing,
// continuation paging, renderer-node translation, and health accounting. No
// caller needs to know any of that, and no caller sees a renderer node.
//
// Catalog holds no user credentials. Everything it serves is identical for
// every user in a region, which is what makes it cacheable and, later,
// shareable from a server.
package catalog

import (
	"context"

	"spotifier/internal/domain"
)

// Surface identifiers for the browse-shaped pages.
//
// These are YouTube's own identifiers. They appear here rather than in callers
// so that the vocabulary stays inside this package.
const (
	SurfaceHome        = "FEmusic_home"
	SurfaceExplore     = "FEmusic_explore"
	SurfaceCharts      = "FEmusic_charts"
	SurfaceNewReleases = "FEmusic_new_releases"
	SurfaceMoods       = "FEmusic_moods_and_genres"
)

// Catalog reads public metadata.
//
// Implementations must be safe for concurrent use. Every method returns a
// usable zero value alongside any error, so a partially-degraded response
// renders rather than blanking the screen.
type Catalog interface {
	// Home is the personalised landing surface. Without credentials it still
	// returns content, just not personalised.
	Home(ctx context.Context) (domain.BrowsePage, error)

	// Browse reads any shelf- or grid-shaped surface by identifier.
	// Browse fetches a surface. params narrows it, as the mood-and-genre
	// tiles do: every tile shares one browse ID and differs only in params.
	Browse(ctx context.Context, surfaceID, params string) (domain.BrowsePage, error)

	// Search queries the catalog. An empty filter searches everything, which
	// returns a top-result card; a set filter returns a single uniform shelf.
	Search(ctx context.Context, query string, filter domain.SearchFilter) (domain.SearchResults, error)

	// Suggest returns autocomplete candidates for a partial query.
	Suggest(ctx context.Context, prefix string) ([]string, error)

	// Album, Artist and Playlist read one entity by identifier.
	Album(ctx context.Context, id string) (domain.Album, error)
	Artist(ctx context.Context, id string) (domain.Artist, error)
	Playlist(ctx context.Context, id string) (domain.Playlist, error)

	// Podcast reads a show and its episodes. YouTube Music carries podcasts
	// as a first-class kind, with their own search filter and browse pages.
	Podcast(ctx context.Context, id string) (domain.Podcast, error)

	// Radio returns the endless queue YouTube generates from a seed track.
	// Used both for autoplay and as the source material for generated mixes,
	// which steer YouTube's own recommendations with our listening history
	// rather than trying to out-recommend them from scratch.
	Radio(ctx context.Context, seedTrackID string) ([]domain.Track, error)

	// RadioPage is one page of a track's radio: the first when token is
	// empty, the one token names otherwise. next continues it. This is the
	// "Up next" queue YouTube Music plays from a song, and the continuation
	// is how its autoplay keeps going.
	RadioPage(ctx context.Context, seedTrackID, token string) (tracks []domain.Track, next string, err error)
}

// filterParams maps a domain search filter to the opaque parameter the web
// client sends. These are protobuf-encoded and cannot be constructed, only
// replayed.
var filterParams = map[domain.SearchFilter]string{
	domain.FilterSongs:     "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D",
	domain.FilterVideos:    "EgWKAQIQAWoKEAkQBRAKEAMQBA%3D%3D",
	domain.FilterAlbums:    "EgWKAQIYAWoKEAkQBRAKEAMQBA%3D%3D",
	domain.FilterArtists:   "EgWKAQIgAWoKEAkQBRAKEAMQBA%3D%3D",
	domain.FilterPlaylists: "EgWKAQIoAWoKEAkQBRAKEAMQBA%3D%3D",
	// Read from the search response's own filter chips rather than guessed:
	// `cmd/probe2` prints them, which is also how to re-read them if YouTube
	// ever changes the encoding.
	domain.FilterPodcasts: "EgWKAQJQAWoSEBAQBRADEBEQChAJEBUQBBAO",
	domain.FilterEpisodes: "EgWKAQJIAWoSEBAQBRADEBEQChAJEBUQBBAO",
}
