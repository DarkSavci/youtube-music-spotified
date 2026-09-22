package identity

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"spotifier/internal/domain"
	"spotifier/internal/innertube"
	"spotifier/internal/obs"
	"spotifier/internal/renderers"
)

// ErrLoggedOut means the session is no longer authenticated. It is the only
// error that should prompt re-authentication: a network failure must not, or an
// offline user gets sent through a needless login.
var ErrLoggedOut = errors.New("identity: session logged out")

// InnerTube is the production Identity, reading the signed-in user's library.
type InnerTube struct {
	client   *innertube.Client
	recorder *obs.Recorder
}

func NewInnerTube(c *innertube.Client, rec *obs.Recorder) *InnerTube {
	return &InnerTube{client: c, recorder: rec}
}

var _ Identity = (*InnerTube)(nil)

func (i *InnerTube) ctxFor(surface string) renderers.ParseContext {
	return renderers.ParseContext{Surface: surface, Recorder: i.recorder}
}

func (i *InnerTube) call(ctx context.Context, endpoint string, body map[string]any) (renderers.Node, error) {
	if !i.client.Authenticated() {
		return nil, ErrLoggedOut
	}
	raw, err := i.client.Call(ctx, endpoint, body)
	if err != nil {
		return nil, err
	}
	doc, err := renderers.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("identity %s: decode: %w", endpoint, err)
	}
	// A library surface with no content and no header is the Silent-logout
	// shape: the request succeeded but returned a signed-out page.
	return doc, nil
}

func (i *InnerTube) browse(ctx context.Context, surface string) (renderers.Node, error) {
	return i.call(ctx, "browse", map[string]any{"browseId": surface})
}

// ---------- reads ----------

func (i *InnerTube) LikedSongs(ctx context.Context) (domain.Playlist, error) {
	doc, err := i.browse(ctx, SurfaceLikedSongs)
	if err != nil {
		return domain.Playlist{}, err
	}
	pl, ok := renderers.ParsePlaylist(doc, SurfaceLikedSongs, i.ctxFor("liked"))
	if !ok {
		return domain.Playlist{}, fmt.Errorf("identity: liked songs did not parse")
	}
	err = renderers.AppendPlaylistPages(&pl, doc, func(token string) (renderers.Node, error) {
		return i.call(ctx, "browse", map[string]any{"continuation": token})
	})
	if err != nil {
		return domain.Playlist{}, err
	}
	pl.ID = "LM"
	if pl.Title == "" {
		pl.Title = "Liked Music"
	}
	return pl, nil
}

func (i *InnerTube) Playlists(ctx context.Context) ([]domain.LibraryItem, error) {
	return i.libraryItems(ctx, SurfacePlaylists, domain.LibPlaylist)
}

func (i *InnerTube) Artists(ctx context.Context) ([]domain.LibraryItem, error) {
	return i.libraryItems(ctx, SurfaceArtists, domain.LibArtist)
}

func (i *InnerTube) Albums(ctx context.Context) ([]domain.LibraryItem, error) {
	return i.libraryItems(ctx, SurfaceAlbums, domain.LibAlbum)
}

// libraryItems reads one library surface and normalises it.
//
// The requested kind is a hint, not a assertion: these surfaces mix content,
// and the item's own navigation target is authoritative.
func (i *InnerTube) libraryItems(ctx context.Context, surface string, hint domain.LibraryItemKind) ([]domain.LibraryItem, error) {
	doc, err := i.browse(ctx, surface)
	if err != nil {
		return nil, err
	}
	return LibraryItemsFrom(doc, hint, i.ctxFor(surface)), nil
}

func (i *InnerTube) History(ctx context.Context) ([]domain.Track, error) {
	doc, err := i.browse(ctx, SurfaceHistory)
	if err != nil {
		return nil, err
	}
	var out []domain.Track
	for _, n := range renderers.FindAll(doc, renderers.NodeListItem) {
		if tr, ok := renderers.ParseTrack(n); ok {
			out = append(out, tr)
		}
	}
	return out, nil
}

// ---------- writes ----------

func (i *InnerTube) Rate(ctx context.Context, trackID string, rating Rating) error {
	endpoint := map[Rating]string{
		RatingLike:    "like/like",
		RatingDislike: "like/dislike",
		RatingNone:    "like/removelike",
	}[rating]
	if endpoint == "" {
		return fmt.Errorf("identity: unknown rating %q", rating)
	}
	_, err := i.call(ctx, endpoint, map[string]any{
		"target": map[string]any{"videoId": trackID},
	})
	return err
}

/*
Follow subscribes to an artist's channel.

Following an artist and saving an album are different operations upstream:
albums are library additions with opaque tokens, artists are channel
subscriptions keyed by a channel identifier. Modelling them alike would mean
inventing a token that does not exist.
*/
func (i *InnerTube) Follow(ctx context.Context, channelID string, follow bool) error {
	if channelID == "" {
		return fmt.Errorf("identity: empty channel id")
	}
	endpoint := "subscription/unsubscribe"
	if follow {
		endpoint = "subscription/subscribe"
	}
	_, err := i.call(ctx, endpoint, map[string]any{
		"channelIds": []string{channelID},
	})
	return err
}

func (i *InnerTube) ToggleLibrary(ctx context.Context, token string) error {
	if token == "" {
		return fmt.Errorf("identity: empty library token")
	}
	_, err := i.call(ctx, "feedback", map[string]any{
		"feedbackTokens": []string{token},
	})
	return err
}

func (i *InnerTube) CreatePlaylist(ctx context.Context, title, description string, public bool) (string, error) {
	privacy := "PRIVATE"
	if public {
		privacy = "PUBLIC"
	}
	doc, err := i.call(ctx, "playlist/create", map[string]any{
		"title":         title,
		"description":   description,
		"privacyStatus": privacy,
		"mediaType":     "MEDIA_TYPE_AUDIO",
	})
	if err != nil {
		return "", err
	}
	if id := doc.Str("playlistId"); id != "" {
		return id, nil
	}
	if hit := renderers.Find(doc, "playlistId"); hit != nil {
		if id := hit.Str("playlistId"); id != "" {
			return id, nil
		}
	}
	return "", fmt.Errorf("identity: playlist created but no identifier returned")
}

func (i *InnerTube) DeletePlaylist(ctx context.Context, playlistID string) error {
	_, err := i.call(ctx, "playlist/delete", map[string]any{
		"playlistId": strings.TrimPrefix(playlistID, "VL"),
	})
	return err
}

func (i *InnerTube) AddToPlaylist(ctx context.Context, playlistID string, trackIDs []string) error {
	if len(trackIDs) == 0 {
		return nil
	}
	actions := make([]map[string]any, 0, len(trackIDs))
	for _, id := range trackIDs {
		actions = append(actions, map[string]any{
			"action":       "ACTION_ADD_VIDEO",
			"addedVideoId": id,
		})
	}
	_, err := i.call(ctx, "browse/edit_playlist", map[string]any{
		"playlistId": strings.TrimPrefix(playlistID, "VL"),
		"actions":    actions,
	})
	return err
}

func (i *InnerTube) RemoveFromPlaylist(ctx context.Context, playlistID string, items []PlaylistItemRef) error {
	if len(items) == 0 {
		return nil
	}
	actions := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if it.ItemID == "" {
			// Without the membership handle YouTube cannot tell which copy to
			// remove, so refuse rather than deleting the wrong one.
			return fmt.Errorf("identity: track %s has no playlist item handle", it.TrackID)
		}
		actions = append(actions, map[string]any{
			"action":         "ACTION_REMOVE_VIDEO",
			"removedVideoId": it.TrackID,
			"setVideoId":     it.ItemID,
		})
	}
	_, err := i.call(ctx, "browse/edit_playlist", map[string]any{
		"playlistId": strings.TrimPrefix(playlistID, "VL"),
		"actions":    actions,
	})
	return err
}

// ---------- normalisation ----------

// LibraryItemsFrom normalises any library surface into merged-shape items.
//
// Exported because the fixture adapter uses the same translation, so both
// adapters agree on shape by construction rather than by parallel maintenance.
func LibraryItemsFrom(doc renderers.Node, hint domain.LibraryItemKind, pc renderers.ParseContext) []domain.LibraryItem {
	var out []domain.LibraryItem
	seen := map[string]bool{}

	add := func(id, title, subtitle string, kind domain.LibraryItemKind, art domain.ArtworkSet) {
		if id == "" || title == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, domain.LibraryItem{
			ID: id, Kind: kind, Title: title, Subtitle: subtitle, Artwork: art,
		})
	}

	classify := func(browseID, pageType string) (domain.LibraryItemKind, string) {
		switch {
		case strings.Contains(pageType, "ARTIST"), strings.HasPrefix(browseID, "UC"), strings.HasPrefix(browseID, "MPLA"):
			return domain.LibArtist, browseID
		case strings.Contains(pageType, "ALBUM"), strings.HasPrefix(browseID, "MPRE"):
			return domain.LibAlbum, browseID
		case strings.Contains(pageType, "PLAYLIST"), strings.HasPrefix(browseID, "VL"):
			return domain.LibPlaylist, strings.TrimPrefix(browseID, "VL")
		}
		return hint, browseID
	}

	for _, n := range renderers.FindAll(doc, renderers.NodeTwoRowItem) {
		nav := n.Child("navigationEndpoint")
		browseID := nav.Child("browseEndpoint").Str("browseId")
		kind, id := classify(browseID, nav.PageType())
		add(id, n.Text("title"), n.Text("subtitle"), kind, n.FindArtwork())
	}
	for _, n := range renderers.FindAll(doc, renderers.NodeListItem) {
		kind, id := classify(n.BrowseID(), n.PageType())
		title, subtitle := renderers.ListItemTexts(n)
		add(id, title, subtitle, kind, n.FindArtwork())
	}
	return out
}
