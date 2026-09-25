package catalog

import (
	"context"
	"fmt"
	"strings"

	"spotifier/internal/domain"
	"spotifier/internal/innertube"
	"spotifier/internal/obs"
	"spotifier/internal/renderers"
)

// InnerTube is the production Catalog, reading from YouTube Music.
type InnerTube struct {
	client   *innertube.Client
	recorder *obs.Recorder
}

// NewInnerTube builds a Catalog over an InnerTube client.
//
// The recorder may be nil; it collects the unknown-node signal behind the
// parser-health panel.
func NewInnerTube(c *innertube.Client, rec *obs.Recorder) *InnerTube {
	return &InnerTube{client: c, recorder: rec}
}

var _ Catalog = (*InnerTube)(nil)

func (c *InnerTube) ctxFor(surface string) renderers.ParseContext {
	return renderers.ParseContext{Surface: surface, Recorder: c.recorder}
}

// call posts and decodes in one step, since every method needs both.
func (c *InnerTube) call(ctx context.Context, endpoint string, body map[string]any) (renderers.Node, error) {
	raw, err := c.client.Call(ctx, endpoint, body)
	if err != nil {
		return nil, err
	}
	doc, err := renderers.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("catalog %s: decode: %w", endpoint, err)
	}
	return doc, nil
}

func (c *InnerTube) Home(ctx context.Context) (domain.BrowsePage, error) {
	return c.Browse(ctx, SurfaceHome, "")
}

func (c *InnerTube) Browse(ctx context.Context, surfaceID, params string) (domain.BrowsePage, error) {
	body := map[string]any{"browseId": surfaceID}
	if params != "" {
		body["params"] = params
	}
	doc, err := c.call(ctx, "browse", body)
	if err != nil {
		return domain.BrowsePage{}, err
	}
	return renderers.ParseBrowsePage(doc, c.ctxFor(surfaceID)), nil
}

func (c *InnerTube) Search(ctx context.Context, query string, filter domain.SearchFilter) (domain.SearchResults, error) {
	body := map[string]any{"query": query}
	if params, ok := filterParams[filter]; ok {
		body["params"] = params
	}
	surface := "search"
	if filter != domain.FilterNone {
		surface = "search:" + string(filter)
	}
	doc, err := c.call(ctx, "search", body)
	if err != nil {
		return domain.SearchResults{Query: query}, err
	}
	return renderers.ParseSearch(doc, query, c.ctxFor(surface)), nil
}

func (c *InnerTube) Suggest(ctx context.Context, prefix string) ([]string, error) {
	if strings.TrimSpace(prefix) == "" {
		return nil, nil
	}
	doc, err := c.call(ctx, "music/get_search_suggestions", map[string]any{"input": prefix})
	if err != nil {
		return nil, err
	}
	var out []string
	seen := map[string]bool{}
	for _, n := range renderers.FindAll(doc, "searchSuggestionRenderer") {
		s := strings.TrimSpace(nodeText(n, "suggestion"))
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out, nil
}

func (c *InnerTube) Album(ctx context.Context, id string) (domain.Album, error) {
	doc, err := c.call(ctx, "browse", map[string]any{"browseId": id})
	if err != nil {
		return domain.Album{}, err
	}
	al, ok := renderers.ParseAlbum(doc, id, c.ctxFor("album"))
	if !ok {
		return domain.Album{ID: id}, fmt.Errorf("catalog: album %s did not parse", id)
	}
	return al, nil
}

func (c *InnerTube) Artist(ctx context.Context, id string) (domain.Artist, error) {
	doc, err := c.call(ctx, "browse", map[string]any{"browseId": id})
	if err != nil {
		return domain.Artist{}, err
	}
	ar, ok := renderers.ParseArtist(doc, id, c.ctxFor("artist"))
	if !ok {
		return domain.Artist{ID: id}, fmt.Errorf("catalog: artist %s did not parse", id)
	}
	return ar, nil
}

func (c *InnerTube) Playlist(ctx context.Context, id string) (domain.Playlist, error) {
	// Playlist browse identifiers carry a VL prefix that the domain does not.
	browseID := id
	if !strings.HasPrefix(browseID, "VL") {
		browseID = "VL" + browseID
	}
	doc, err := c.call(ctx, "browse", map[string]any{"browseId": browseID})
	if err != nil {
		return domain.Playlist{}, err
	}
	pl, ok := renderers.ParsePlaylist(doc, browseID, c.ctxFor("playlist"))
	if !ok {
		return domain.Playlist{ID: id}, fmt.Errorf("catalog: playlist %s did not parse", id)
	}
	err = renderers.AppendPlaylistPages(&pl, doc, func(token string) (renderers.Node, error) {
		return c.call(ctx, "browse", map[string]any{"continuation": token})
	})
	if err != nil {
		return domain.Playlist{ID: id}, err
	}
	return pl, nil
}

// nodeText reads a text field off a node without exporting traversal helpers.
func nodeText(n renderers.Node, key string) string {
	return n.Text(key)
}

// Radio asks YouTube for the queue it would generate after this track.
//
// The response is the same `next` payload the player uses for autoplay, so the
// recommendations are YouTube's own — we only choose the seeds.
func (c *InnerTube) Radio(ctx context.Context, seedTrackID string) ([]domain.Track, error) {
	if seedTrackID == "" {
		return nil, fmt.Errorf("catalog: empty radio seed")
	}
	doc, err := c.call(ctx, "next", map[string]any{
		"videoId":    seedTrackID,
		"playlistId": "RDAMVM" + seedTrackID,
	})
	if err != nil {
		return nil, err
	}
	tracks, _ := renderers.ParseWatchQueue(doc)
	return tracks, nil
}

// RadioPage reads a page of a track's radio, following YouTube's own
// continuation token, which is how its Up next never runs out.
func (c *InnerTube) RadioPage(ctx context.Context, seedTrackID, token string) ([]domain.Track, string, error) {
	body := map[string]any{"continuation": token}
	if token == "" {
		if seedTrackID == "" {
			return nil, "", fmt.Errorf("catalog: empty radio seed")
		}
		body = map[string]any{"videoId": seedTrackID, "playlistId": "RDAMVM" + seedTrackID}
	}
	doc, err := c.call(ctx, "next", body)
	if err != nil {
		return nil, "", err
	}
	tracks, _ := renderers.ParseWatchQueue(doc)
	return tracks, renderers.RadioContinuation(doc), nil
}

/*
Podcast reads a show page.

The browse identifier is an MPSP… for a show page, or a UC… when the show is
presented as its author's channel; both answer to the same browse call, so no
branching is needed here.
*/
func (c *InnerTube) Podcast(ctx context.Context, id string) (domain.Podcast, error) {
	if id == "" {
		return domain.Podcast{}, fmt.Errorf("catalog: empty podcast id")
	}
	doc, err := c.call(ctx, "browse", map[string]any{"browseId": id})
	if err != nil {
		return domain.Podcast{}, err
	}
	pod, ok := renderers.ParsePodcastPage(doc, id, c.ctxFor("podcast"))
	if !ok {
		return domain.Podcast{}, fmt.Errorf("catalog: podcast %q did not parse", id)
	}
	return pod, nil
}

// PlaylistPage returns as soon as one page is available. The original Playlist
// method remains the complete-list API for queueing and bulk operations.
func (c *InnerTube) PlaylistPage(ctx context.Context, id, token string) (domain.PlaylistPage, error) {
	if token != "" {
		doc, err := c.call(ctx, "browse", map[string]any{"continuation": token})
		if err != nil {
			return domain.PlaylistPage{}, err
		}
		if renderers.Find(doc, "appendContinuationItemsAction") == nil && renderers.Find(doc, "musicPlaylistShelfContinuation") == nil {
			return domain.PlaylistPage{}, fmt.Errorf("catalog: playlist continuation did not parse")
		}
		tracks, next := renderers.ParsePlaylistContinuation(doc)
		if next == token {
			return domain.PlaylistPage{}, fmt.Errorf("catalog: repeated playlist continuation")
		}
		return domain.PlaylistPage{Playlist: domain.Playlist{ID: id, Tracks: tracks}, Next: next}, nil
	}
	browseID := id
	if !strings.HasPrefix(id, "VL") {
		browseID = "VL" + id
	}
	doc, err := c.call(ctx, "browse", map[string]any{"browseId": browseID})
	if err != nil {
		return domain.PlaylistPage{}, err
	}
	pl, ok := renderers.ParsePlaylist(doc, browseID, c.ctxFor("playlist"))
	if !ok {
		return domain.PlaylistPage{}, fmt.Errorf("catalog: playlist %s did not parse", id)
	}
	next := renderers.PlaylistNext(doc)
	if next != "" {
		if pl.TrackCount == len(pl.Tracks) {
			pl.TrackCount = 0
		}
		pl.DurationMs = 0
	}
	return domain.PlaylistPage{Playlist: pl, Next: next}, nil
}

func (c *InnerTube) TrackVersions(ctx context.Context, id string) ([]domain.Track, error) {
	doc, err := c.call(ctx, "next", map[string]any{"videoId": id})
	if err != nil {
		return nil, err
	}
	return renderers.ParseTrackVersions(doc, id), nil
}
