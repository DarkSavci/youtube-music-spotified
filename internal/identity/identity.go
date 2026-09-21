// Package identity reads and writes the signed-in user's own library.
//
// Everything here needs the user's Credentials, so it runs only on the Device
// and never on a server. It is deliberately not importable from
// catalog or control — that separation is what lets those planes lift out to a
// server later, and it is enforced by the import linter rather than by
// convention.
package identity

import (
	"context"

	"spotifier/internal/domain"
)

// Library surfaces. YouTube Music has no unified library endpoint; these are
// the separate surfaces that the library module fans out across and merges.
const (
	SurfaceLikedSongs = "VLLM"
	SurfacePlaylists  = "FEmusic_liked_playlists"
	SurfaceArtists    = "FEmusic_library_corpus_track_artists"
	SurfaceAlbums     = "FEmusic_liked_albums"
	SurfaceHistory    = "FEmusic_history"
)

// Rating is a like/dislike state on a Track.
type Rating string

const (
	RatingLike    Rating = "like"
	RatingDislike Rating = "dislike"
	RatingNone    Rating = "none"
)

// Identity reads and writes the user's own account.
//
// Every method may return ErrLoggedOut, which callers surface as a re-auth
// prompt. No other error should trigger re-authentication — see the canary
// contract in innertube.
type Identity interface {
	// LikedSongs is the user's Liked Music, which behaves as a playlist.
	LikedSongs(ctx context.Context) (domain.Playlist, error)

	// Playlists, Artists and Albums are the saved-library surfaces. Each
	// returns items already normalised to the merged shape.
	Playlists(ctx context.Context) ([]domain.LibraryItem, error)
	Artists(ctx context.Context) ([]domain.LibraryItem, error)
	Albums(ctx context.Context) ([]domain.LibraryItem, error)

	// History is recently played, most recent first.
	History(ctx context.Context) ([]domain.Track, error)

	// Rate sets or clears the like state on a Track.
	Rate(ctx context.Context, trackID string, rating Rating) error

	// ToggleLibrary adds or removes a Track using a token carried by the Track
	// it came from. The tokens are opaque and single-use; they cannot be
	// constructed, only echoed back.
	ToggleLibrary(ctx context.Context, token string) error

	// Follow subscribes to or unsubscribes from an Artist's channel.
	//
	// YouTube models this as a channel subscription rather than a library
	// addition, which is why it takes a channel identifier and not one of the
	// opaque library tokens.
	Follow(ctx context.Context, channelID string, follow bool) error

	// CreatePlaylist returns the new playlist's identifier.
	CreatePlaylist(ctx context.Context, title, description string, public bool) (string, error)
	DeletePlaylist(ctx context.Context, playlistID string) error

	// AddToPlaylist appends Tracks. Adding one Track to several playlists is a
	// fan-out over this call — YouTube Music offers no batch form, which is
	// one of the gaps the Control plane closes for the UI.
	AddToPlaylist(ctx context.Context, playlistID string, trackIDs []string) error

	// RemoveFromPlaylist needs each Track's membership handle, not its
	// identifier, because the same Track may appear more than once.
	RemoveFromPlaylist(ctx context.Context, playlistID string, items []PlaylistItemRef) error
}

// PlaylistItemRef identifies one Track's membership in one Playlist.
type PlaylistItemRef struct {
	TrackID string
	ItemID  string
}
