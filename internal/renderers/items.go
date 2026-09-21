package renderers

import (
	"regexp"
	"strings"

	"spotifier/internal/domain"
)

// Renderer node types this package understands. Anything outside this set that
// appears where an item was expected is reported to obs as parser-health
// signal rather than dropped silently.
const (
	NodeListItem   = "musicResponsiveListItemRenderer"
	NodeTwoRowItem = "musicTwoRowItemRenderer"
	NodeShelf      = "musicShelfRenderer"
	NodeCarousel   = "musicCarouselShelfRenderer"
	NodeCardShelf  = "musicCardShelfRenderer"
	NodeQueueItem  = "playlistPanelVideoRenderer"
	NodeNavButton  = "musicNavigationButtonRenderer"
)

var reDuration = regexp.MustCompile(`^\d+:\d{2}(:\d{2})?$`)

// ---------- list rows ----------

// ParseTrack reads a musicResponsiveListItemRenderer into a Track.
//
// The interesting part is the subtitle column. YouTube packs artists, album and
// duration into one flat run list separated by bullet runs:
//
//	"Daft Punk" • "Julian Casablancas" • "Random Access Memories" • "5:38"
//
// Position is not reliable — a Track may credit one artist or seven, and may
// have no album at all — so runs are classified by their navigation endpoint
// rather than by index.
//
// Returns ok=false when the node carries no playable identifier.
func ParseTrack(n Node) (domain.Track, bool) {
	if n == nil {
		return domain.Track{}, false
	}

	t := domain.Track{Playable: true}

	// The identifier appears in several places depending on surface. Prefer the
	// playlist item data, which also tells us the membership handle.
	if pid := n.Child("playlistItemData"); pid != nil {
		t.ID = pid.Str("videoId")
		t.PlaylistItemID = pid.Str("playlistSetVideoId")
	}
	if t.ID == "" {
		t.ID = n.VideoID()
	}
	if t.ID == "" {
		return domain.Track{}, false
	}

	cols := flexColumns(n)
	if len(cols) > 0 {
		t.Title = textOf(cols[0].Child("text"))
	}
	if t.Title == "" {
		return domain.Track{}, false
	}

	if len(cols) > 1 {
		meta := parseSubtitleRuns(cols[1].Child("text").Nodes("runs"))
		t.Artists = meta.artists
		t.Album = meta.album
		t.DurationMs = meta.durationMs
	}
	/*
	 * The third column is whichever of several things the surface puts there.
	 *
	 * On a playlist or in Liked Music it is the album, carrying a browse
	 * endpoint; on an album or artist page it is a play count; on some rows it
	 * is the title again. Reading it as one fixed thing left every playlist
	 * row without an album, and the column on screen empty.
	 *
	 * The endpoint is the discriminator rather than the text, because the text
	 * is localised and a play count is not distinguishable from a title by
	 * shape alone.
	 */
	if len(cols) > 2 {
		meta := parseSubtitleRuns(cols[2].Child("text").Nodes("runs"))
		if t.Album == nil && meta.album != nil {
			t.Album = meta.album
		}
		txt := textOf(cols[2].Child("text"))
		if strings.Contains(txt, "play") || strings.Contains(txt, "view") {
			t.PlayCount = txt
		}
	}

	t.Artwork = n.FindArtwork()
	t.Explicit = IsExplicit(n)
	t.IsVideo = isVideoTrack(n)
	t.Playable = !isUnavailable(n)
	t.LibraryAddToken, t.LibraryRemoveToken = feedbackTokens(n)

	// Some surfaces put the duration in a fixed column rather than the
	// subtitle runs.
	if t.DurationMs == 0 {
		for _, fc := range n.Nodes("fixedColumns") {
			inner := fc.Child("musicResponsiveListItemFixedColumnRenderer")
			if ms := DurationMs(textOf(inner.Child("text"))); ms > 0 {
				t.DurationMs = ms
				break
			}
		}
	}
	return t, true
}

// subtitleMeta is what a subtitle run list yields.
type subtitleMeta struct {
	artists    []domain.ArtistRef
	album      *domain.AlbumRef
	durationMs int64
}

// parseSubtitleRuns classifies each run by where it points, rather than by its
// position, because the number of artists and the presence of an album both
// vary.
func parseSubtitleRuns(runs []Node) subtitleMeta {
	var out subtitleMeta
	for _, r := range runs {
		text := r.Str("text")
		if text == "" || isSeparator(text) {
			continue
		}
		nav := r.Child("navigationEndpoint")
		browseID := ""
		pageType := ""
		if nav != nil {
			if be := nav.Child("browseEndpoint"); be != nil {
				browseID = be.Str("browseId")
				pageType = be.PageType()
			}
		}

		switch {
		case strings.HasPrefix(browseID, "MPRE"),
			strings.Contains(pageType, "ALBUM"):
			out.album = &domain.AlbumRef{ID: browseID, Name: text}

		case strings.HasPrefix(browseID, "UC"),
			strings.Contains(pageType, "ARTIST"):
			out.artists = append(out.artists, domain.ArtistRef{ID: browseID, Name: text})

		case reDuration.MatchString(text):
			out.durationMs = DurationMs(text)

		case browseID == "" && out.durationMs == 0 && len(out.artists) == 0:
			// An unlinked leading run is an artist YouTube has no page for.
			// Only treat it as such before any linked artist is seen, so that
			// trailing metadata ("2.1M plays", "2013") is not misread.
			if !looksLikeMetadata(text) {
				out.artists = append(out.artists, domain.ArtistRef{Name: text})
			}
		}
	}
	return out
}

func isSeparator(s string) bool {
	t := strings.TrimSpace(s)
	return t == "" || t == "•" || t == "&" || t == "," || t == "-"
}

// looksLikeMetadata guards against reading counts, years or type labels as
// artist names.
func looksLikeMetadata(s string) bool {
	t := strings.TrimSpace(strings.ToLower(s))
	if t == "" {
		return true
	}
	for _, suffix := range []string{"plays", "views", "songs", "song", "episodes", "subscribers", "likes"} {
		if strings.HasSuffix(t, suffix) {
			return true
		}
	}
	for _, exact := range []string{"album", "single", "ep", "playlist", "artist", "video", "song", "podcast"} {
		if t == exact {
			return true
		}
	}
	// A bare four-digit year.
	if len(t) == 4 && t[0] >= '1' && t[0] <= '2' {
		allDigits := true
		for _, c := range t {
			if c < '0' || c > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			return true
		}
	}
	return false
}

func flexColumns(n Node) []Node {
	raw := n.Nodes("flexColumns")
	out := make([]Node, 0, len(raw))
	for _, c := range raw {
		if inner := c.Child("musicResponsiveListItemFlexColumnRenderer"); inner != nil {
			out = append(out, inner)
		}
	}
	return out
}

// isVideoTrack distinguishes a music video from a song. The UI hides videos by
// default, so this must not guess.
func isVideoTrack(n Node) bool {
	for _, cfg := range FindAll(n, "watchEndpointMusicConfig") {
		if strings.Contains(cfg.Str("musicVideoType"), "MUSIC_VIDEO_TYPE_UGC") ||
			strings.Contains(cfg.Str("musicVideoType"), "MUSIC_VIDEO_TYPE_OMV") {
			return true
		}
	}
	return false
}

// isUnavailable reports a Track blocked in this region or otherwise unplayable.
// These render greyed rather than hidden, so a playlist keeps its shape.
func isUnavailable(n Node) bool {
	return strings.Contains(strings.ToLower(n.Str("flexColumnDisplayStyle")), "unavailable") ||
		n.Child("musicItemRendererDisplayPolicy").Str("displayPolicy") == "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT"
}

// feedbackTokens extracts the opaque add/remove library tokens from a row's
// context menu. They cannot be constructed, only echoed back.
func feedbackTokens(n Node) (add, remove string) {
	for _, item := range FindAll(n, "toggleMenuServiceItemRenderer") {
		def := item.Child("defaultServiceEndpoint").Child("feedbackEndpoint").Str("feedbackToken")
		tog := item.Child("toggledServiceEndpoint").Child("feedbackEndpoint").Str("feedbackToken")
		label := strings.ToLower(textOf(item.Child("defaultText")))
		switch {
		case strings.Contains(label, "add"):
			add, remove = def, tog
		case strings.Contains(label, "remove"):
			remove, add = def, tog
		}
	}
	return add, remove
}

// ---------- cards ----------

// ParseCard reads a musicTwoRowItemRenderer — the square card used in shelves —
// into a ShelfItem. The card's kind is determined by its navigation target.
func ParseCard(n Node) (domain.ShelfItem, bool) {
	if n == nil {
		return domain.ShelfItem{}, false
	}
	title := textOf(n.Child("title"))
	if title == "" {
		return domain.ShelfItem{}, false
	}
	subtitle := textOf(n.Child("subtitle"))
	art := n.FindArtwork()

	nav := n.Child("navigationEndpoint")
	browseID := nav.Child("browseEndpoint").Str("browseId")
	pageType := nav.PageType()
	videoID := nav.Child("watchEndpoint").Str("videoId")

	switch {
	case videoID != "" && browseID == "":
		return domain.ShelfItem{Kind: domain.KindTrack, Track: cardTrack(n, videoID, title, art)}, true

	case strings.Contains(pageType, "ALBUM"), strings.HasPrefix(browseID, "MPRE"):
		return domain.ShelfItem{Kind: domain.KindAlbum, Album: &domain.Album{
			ID: browseID, Title: title, Artwork: art,
			Artists: cardArtists(n.Child("subtitle")),
		}}, true

	case strings.Contains(pageType, "ARTIST"), strings.HasPrefix(browseID, "UC"):
		return domain.ShelfItem{Kind: domain.KindArtist, Artist: &domain.Artist{
			ID: browseID, Name: title, Artwork: art, Subscribers: subtitle,
		}}, true

	case strings.Contains(pageType, "PLAYLIST"), strings.HasPrefix(browseID, "VL"):
		return domain.ShelfItem{Kind: domain.KindPlaylist, Playlist: &domain.Playlist{
			ID: strings.TrimPrefix(browseID, "VL"), Title: title,
			Artwork: art, Description: subtitle,
		}}, true
	}
	return domain.ShelfItem{}, false
}

// ---------- queue rows ----------

// ParseQueueTrack reads a playlistPanelVideoRenderer, the shape used by the
// watch queue in a `next` response.
func ParseQueueTrack(n Node) (domain.Track, bool) {
	if n == nil {
		return domain.Track{}, false
	}
	t := domain.Track{
		ID:       n.VideoID(),
		Title:    textOf(n.Child("title")),
		Artwork:  n.FindArtwork(),
		Explicit: IsExplicit(n),
		Playable: true,
	}
	if t.ID == "" || t.Title == "" {
		return domain.Track{}, false
	}
	meta := parseSubtitleRuns(n.Child("longBylineText").Nodes("runs"))
	t.Artists = meta.artists
	t.Album = meta.album
	t.DurationMs = DurationMs(textOf(n.Child("lengthText")))
	t.LibraryAddToken, t.LibraryRemoveToken = feedbackTokens(n)
	return t, true
}

// ListItemTexts returns the primary and secondary text of a list row.
//
// Exported so that library normalisation can read rows uniformly without
// reimplementing the flex-column unwrapping, which differs between surfaces.
func ListItemTexts(n Node) (title, subtitle string) {
	cols := flexColumns(n)
	if len(cols) > 0 {
		title = textOf(cols[0].Child("text"))
	}
	if len(cols) > 1 {
		subtitle = textOf(cols[1].Child("text"))
	}
	return title, subtitle
}

// cardArtists reads the artists out of a card or top result's subtitle.
//
// The subtitle is a whole line — "Song • Duman", "Album • Daft Punk • 2013",
// "Dolu Kadehi Ters Tut • 192K views" — so using it as the artist's name put
// type labels and view counts into the play history and Top artists. The runs
// are classified like any other subtitle; failing that, the line is split and
// its first part that is not metadata taken.
func cardArtists(subtitle Node) []domain.ArtistRef {
	// A line delivered as one run reads as a single unlinked "artist"; that
	// case is left to the split below.
	if artists := parseSubtitleRuns(subtitle.Nodes("runs")).artists; len(artists) > 0 &&
		!strings.Contains(artists[0].Name, "•") {
		return artists
	}
	for _, part := range strings.Split(textOf(subtitle), "•") {
		part = strings.TrimSpace(part)
		if part != "" && !looksLikeMetadata(part) && !reDuration.MatchString(part) {
			return []domain.ArtistRef{{Name: part}}
		}
	}
	return nil
}

// cardTrack is a playable card as a Track. The subtitle names the artists and,
// on a song card, links the album — kept, so the player can show and open it.
func cardTrack(n Node, videoID, title string, art domain.ArtworkSet) *domain.Track {
	meta := parseSubtitleRuns(n.Child("subtitle").Nodes("runs"))
	return &domain.Track{
		ID: videoID, Title: title, Artwork: art, Playable: true,
		Artists:    cardArtists(n.Child("subtitle")),
		Album:      meta.album,
		DurationMs: meta.durationMs,
	}
}
