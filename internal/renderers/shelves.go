package renderers

import (
	"strings"

	"spotifier/internal/domain"
	"spotifier/internal/obs"
)

// Node types we recognise but deliberately do not render.
//
// Distinguishing "unsupported" from "unknown" matters: without it, podcasts and
// other out-of-scope content would sit in the parser-health counters forever,
// drowning the signal that actually means something changed upstream.
var knownUnsupported = map[string]bool{
	// musicMultiRowListItemRenderer is the podcast episode row, parsed in
	// podcasts.go rather than skipped.
	"musicDescriptionShelfRenderer":  true, // prose blocks
	"musicTastebuilderShelfRenderer": true,
	"gridRenderer":                   true, // handled via its children
	"itemSectionRenderer":            true, // pure container
	"continuationItemRenderer":       true, // paging marker
	"messageRenderer":                true, // "no results" notices
	NodeNavButton:                    true, // mood chips, parsed separately
	NodeShelf:                        true, // handled at page level
	NodeCarousel:                     true, // handled at page level
	NodeCardShelf:                    true, // handled at page level
	"gridHeaderRenderer":             true,
}

/*
unsupportedPagePrefixes are browse-ID prefixes for content kinds this client
does not render.

Podcasts and episodes used to be listed here, on the reasoning that a music
client need not carry them. YouTube Music does carry them — with a search
filter, browse pages and a library surface — so skipping them meant a search
for a show returned nothing. They are parsed now; see podcasts.go.
*/
var unsupportedPagePrefixes = []string{}

// isUnsupportedTarget reports whether a navigation target is knowingly skipped.
func isUnsupportedTarget(browseID, pageType string) bool {
	for _, p := range unsupportedPagePrefixes {
		if strings.HasPrefix(browseID, p) {
			return true
		}
	}
	return false
}

// ParseContext carries what a parse needs beyond the document itself.
type ParseContext struct {
	// Surface names the browse surface or endpoint, for health reporting.
	Surface string
	// Recorder receives unknown node types. May be nil.
	Recorder *obs.Recorder
}

/*
podcastSurface reports whether every row on this surface is a show.

Under the podcasts filter some rows link to a show page and others to the
author's channel, which is indistinguishable from an artist by its target
alone. The filter is the only thing that knows, so it has to be carried here —
without it a third of the results came back as artists.
*/
func (pc ParseContext) podcastSurface() bool {
	return strings.HasSuffix(pc.Surface, ":podcasts")
}

func (pc ParseContext) unknown(nodeType string) {
	if pc.Recorder != nil {
		pc.Recorder.UnknownRenderer(pc.Surface, nodeType)
	}
}

// ---------- shelves ----------

// ParseShelf reads either shelf shape into a domain Shelf.
//
// YouTube uses two: musicShelfRenderer holds list rows, musicCarouselShelfRenderer
// holds cards. They carry their titles differently and nest their contents
// differently, but both mean "a titled row of things" to the UI.
func ParseShelf(n Node, kind string, pc ParseContext) (domain.Shelf, bool) {
	if n == nil {
		return domain.Shelf{}, false
	}
	var sh domain.Shelf

	switch kind {
	case NodeShelf:
		sh.Title = textOf(n.Child("title"))
		for _, c := range n.Nodes("contents") {
			sh.Items = append(sh.Items, parseShelfChild(c, pc)...)
		}
	case NodeCarousel:
		hdr := n.Child("header").Child("musicCarouselShelfBasicHeaderRenderer")
		sh.Title = textOf(hdr.Child("title"))
		if sh.Title == "" {
			sh.Title = textOf(n.Child("title"))
		}
		// "Show all" hangs off the header's trailing button.
		if more := Find(hdr, "browseEndpoint"); more != nil {
			sh.ShowAllID = more.Str("browseId")
		}
		for _, c := range n.Nodes("contents") {
			sh.Items = append(sh.Items, parseShelfChild(c, pc)...)
		}
	default:
		pc.unknown(kind)
		return domain.Shelf{}, false
	}

	sh.Continuation = Continuation(n)
	if len(sh.Items) == 0 {
		return domain.Shelf{}, false
	}
	return sh, true
}

// parseShelfChild turns one entry of a shelf's contents into zero or more
// items, dispatching on the child's node type.
func parseShelfChild(c Node, pc ParseContext) []domain.ShelfItem {
	for key := range c {
		switch key {
		case NodeListItem:
			inner := c.Child(key)
			/*
			 * Podcasts before tracks.
			 *
			 * An episode row carries a videoId, so ParseTrack would happily
			 * claim it and the result would be an episode wearing a track's
			 * clothes: no show, no publication date, and a subtitle reading
			 * "5d ago • HARMAN" where the artist belongs. The navigation
			 * target says which it is, so ask that first.
			 */
			if IsEpisodeTarget(inner.BrowseID(), inner.PageType()) {
				if ep, ok := ParseEpisode(inner); ok {
					return []domain.ShelfItem{{Kind: domain.KindEpisode, Episode: &ep}}
				}
			}
			if IsPodcastTarget(inner.BrowseID(), inner.PageType()) || pc.podcastSurface() {
				if pod, ok := ParsePodcast(inner); ok {
					return []domain.ShelfItem{{Kind: domain.KindPodcast, Podcast: &pod}}
				}
			}
			/*
			 * Entities before tracks.
			 *
			 * An album row carries a play button, and a play button carries a
			 * videoId, so ParseTrack claimed album rows and search results
			 * became unplayable tracks. A row that navigates to a page of its
			 * own is that page — the videoId only says how to play it.
			 */
			if item, ok := parseListItemAsEntity(inner); ok {
				return []domain.ShelfItem{item}
			}
			if tr, ok := ParseTrack(inner); ok {
				return []domain.ShelfItem{{Kind: domain.KindTrack, Track: &tr}}
			}
			if !isUnsupportedTarget(inner.BrowseID(), inner.PageType()) {
				pc.unknown(NodeListItem)
			}

		case NodeTwoRowItem:
			inner := c.Child(key)
			nav0 := inner.Child("navigationEndpoint")
			bid0 := nav0.Child("browseEndpoint").Str("browseId")
			if IsPodcastTarget(bid0, nav0.PageType()) {
				if pod, ok := ParsePodcast(inner); ok {
					return []domain.ShelfItem{{Kind: domain.KindPodcast, Podcast: &pod}}
				}
			}
			// Episodes appear as cards too, on new-releases and similar
			// shelves, and carry no videoId — the identifier is in the MPED
			// browse id.
			if IsEpisodeTarget(bid0, nav0.PageType()) {
				if ep, ok := ParseEpisode(inner); ok {
					return []domain.ShelfItem{{Kind: domain.KindEpisode, Episode: &ep}}
				}
			}
			if item, ok := ParseCard(inner); ok {
				return []domain.ShelfItem{item}
			}
			nav := inner.Child("navigationEndpoint")
			if !isUnsupportedTarget(nav.Child("browseEndpoint").Str("browseId"), nav.PageType()) {
				pc.unknown(NodeTwoRowItem)
			}

		default:
			if strings.HasSuffix(key, "Renderer") && !knownUnsupported[key] {
				pc.unknown(key)
			}
		}
	}
	return nil
}

// subtitleRuns returns the runs of a list row's second column, which is where
// its linked artists live.
func subtitleRuns(n Node) []Node {
	cols := flexColumns(n)
	if len(cols) < 2 {
		return nil
	}
	return cols[1].Child("text").Nodes("runs")
}

// parseListItemAsEntity handles list rows that point at an album, artist or
// playlist rather than a Track — common in filtered search results.
func parseListItemAsEntity(n Node) (domain.ShelfItem, bool) {
	title := ""
	if cols := flexColumns(n); len(cols) > 0 {
		title = textOf(cols[0].Child("text"))
	}
	if title == "" {
		return domain.ShelfItem{}, false
	}
	subtitle := ""
	if cols := flexColumns(n); len(cols) > 1 {
		subtitle = textOf(cols[1].Child("text"))
	}
	/*
	 * The row's own endpoint decides, not a subtree search.
	 *
	 * An album row links its artist in the subtitle, so BrowseID could return
	 * either identifier — and because it walks a Go map, which one it returned
	 * varied between runs. Albums intermittently opened as their artist.
	 */
	browseID, pageType := n.OwnTarget()
	if browseID == "" {
		return domain.ShelfItem{}, false
	}
	art := n.FindArtwork()

	switch {
	case strings.Contains(pageType, "ALBUM"), strings.HasPrefix(browseID, "MPRE"):
		// The subtitle reads "Album • Daft Punk • 2013", so the artists are
		// the runs that link to one, not the whole line.
		artists := parseSubtitleRuns(subtitleRuns(n)).artists
		if cols := flexColumns(n); len(artists) == 0 && len(cols) > 1 {
			artists = cardArtists(cols[1].Child("text"))
		}
		return domain.ShelfItem{Kind: domain.KindAlbum, Album: &domain.Album{
			ID: browseID, Title: title, Artwork: art, Artists: artists,
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

// ---------- pages ----------

// ParseBrowsePage reads any browse surface: home, explore, charts, new
// releases, moods.
//
// Surfaces come in two shapes. Most are rows of shelves; the mood-and-genre
// grid is chips instead. Both are parsed, and a surface producing only one is
// normal rather than a failure.
func ParseBrowsePage(doc Node, pc ParseContext) domain.BrowsePage {
	var page domain.BrowsePage
	page.Title = textOf(Find(doc, "musicHeaderRenderer").Child("title"))

	for _, kind := range []string{NodeCarousel, NodeShelf} {
		for _, n := range FindAll(doc, kind) {
			if sh, ok := ParseShelf(n, kind, pc); ok {
				page.Shelves = append(page.Shelves, sh)
			}
		}
	}

	/*
	 * A grid is a shelf too.
	 *
	 * "Show all" surfaces have no carousel and no shelf renderer at all: the
	 * cards sit directly in a gridRenderer. That renderer was listed as
	 * "handled via its children" and nothing handled it, so every show-all
	 * page parsed to zero shelves and rendered blank — with a title, which is
	 * what made it look like a loading bug rather than a parsing one.
	 */
	if len(page.Shelves) == 0 {
		for _, g := range FindAll(doc, "gridRenderer") {
			sh := domain.Shelf{Title: textOf(g.Child("header").Child("gridHeaderRenderer").Child("title"))}
			if sh.Title == "" {
				sh.Title = page.Title
			}
			for _, item := range g.Nodes("items") {
				sh.Items = append(sh.Items, parseShelfChild(item, pc)...)
			}
			if len(sh.Items) > 0 {
				page.Shelves = append(page.Shelves, sh)
			}
		}
	}

	page.Moods = ParseMoodChips(doc)
	page.Continuation = Continuation(doc)
	return page
}

// ParseMoodChips reads the mood-and-genre grid.
//
// Each chip carries its own colour, which the browse-all tiles render directly.
func ParseMoodChips(doc Node) []domain.MoodChip {
	nodes := FindAll(doc, NodeNavButton)
	if len(nodes) == 0 {
		return nil
	}
	out := make([]domain.MoodChip, 0, len(nodes))
	for _, n := range nodes {
		title := textOf(n.Child("buttonText"))
		if title == "" {
			continue
		}
		chip := domain.MoodChip{
			Title: title,
			Color: argbToHex(n.Child("solid").Int64("leftStripeColor")),
		}
		if cmd := Find(n, "browseEndpoint"); cmd != nil {
			chip.ID = cmd.Str("browseId")
			chip.Params = cmd.Str("params")
		}
		out = append(out, chip)
	}
	return out
}

// argbToHex converts YouTube's packed ARGB integer into "#RRGGBB". The alpha
// channel is discarded: these are opaque tile fills.
func argbToHex(v int64) string {
	if v == 0 {
		return ""
	}
	const hexDigits = "0123456789abcdef"
	rgb := v & 0xFFFFFF
	buf := []byte{'#', 0, 0, 0, 0, 0, 0}
	for i := 6; i >= 1; i-- {
		buf[i] = hexDigits[rgb&0xF]
		rgb >>= 4
	}
	return string(buf)
}

// ParseSearch reads a search response.
//
// Two shapes have to be handled. Filtered searches return a top-level
// musicShelfRenderer; unfiltered ones lead with a musicCardShelfRenderer for
// the confident match and nest the rest inside itemSectionRenderer. Both are
// live — this is the shape change revalidated in mid-2026 — so neither is
// assumed.
func ParseSearch(doc Node, query string, pc ParseContext) domain.SearchResults {
	res := domain.SearchResults{Query: query}

	if card := Find(doc, NodeCardShelf); card != nil {
		if top, ok := parseTopResult(card); ok {
			res.TopResult = &top
		}
		// The card carries a few items of its own — the album's songs, the
		// artist's top songs, other versions of a song. They belong with the
		// card: as a shelf of their own they showed up as a second "Top
		// result" further down the page.
		for _, c := range card.Nodes("contents") {
			res.TopResultItems = append(res.TopResultItems, parseShelfChild(c, pc)...)
		}
	}
	seen := map[string]bool{}
	for _, it := range res.TopResultItems {
		if id := itemID(it); id != "" {
			seen[id] = true
		}
	}
	markSeen := func(sh domain.Shelf) {
		for _, it := range sh.Items {
			if id := itemID(it); id != "" {
				seen[id] = true
			}
		}
	}
	for _, sh := range res.Shelves {
		markSeen(sh)
	}

	for _, kind := range []string{NodeShelf, NodeCarousel} {
		for _, n := range FindAll(doc, kind) {
			if sh, ok := ParseShelf(n, kind, pc); ok {
				res.Shelves = append(res.Shelves, sh)
				markSeen(sh)
			}
		}
	}

	// Unfiltered search returns most of its results in bare itemSectionRenderer
	// containers rather than wrapping them in a shelf. Skipping those — which a
	// container-only reading does — loses the bulk of the page, so they are
	// swept up here, minus anything a shelf already claimed.
	var loose domain.Shelf
	loose.Title = "Results"
	for _, sec := range FindAll(doc, "itemSectionRenderer") {
		for _, c := range sec.Nodes("contents") {
			for _, it := range parseShelfChild(c, pc) {
				id := itemID(it)
				if id == "" || seen[id] {
					continue
				}
				seen[id] = true
				loose.Items = append(loose.Items, it)
			}
		}
	}
	if len(loose.Items) > 0 {
		res.Shelves = append(res.Shelves, loose)
	}

	res.Continuation = Continuation(doc)
	return res
}

// itemID returns a ShelfItem's identity, for de-duplicating results that appear
// in more than one container.
func itemID(it domain.ShelfItem) string {
	switch it.Kind {
	case domain.KindTrack:
		if it.Track != nil {
			return "t:" + it.Track.ID
		}
	case domain.KindAlbum:
		if it.Album != nil {
			return "a:" + it.Album.ID
		}
	case domain.KindArtist:
		if it.Artist != nil {
			return "r:" + it.Artist.ID
		}
	case domain.KindPlaylist:
		if it.Playlist != nil {
			return "p:" + it.Playlist.ID
		}
	}
	return ""
}

/*
topResultTarget is where the card itself goes when tapped.

Read from the card's own onTap, or its title's link — never from a search of
the whole card. The subtitle links the artist ("Song • Lvbel C5"), and a
search walks maps in Go's randomised order, so a song or album top result
opened as its artist about half the time.
*/
func topResultTarget(n Node) (browseID, pageType, videoID string) {
	var titleNav Node
	if runs := n.Child("title").Nodes("runs"); len(runs) > 0 {
		titleNav = runs[0].Child("navigationEndpoint")
	}
	for _, nav := range []Node{n.Child("onTap"), titleNav} {
		if nav == nil {
			continue
		}
		if we := nav.Child("watchEndpoint"); we != nil && we.Str("videoId") != "" {
			return "", "", we.Str("videoId")
		}
		if be := nav.Child("browseEndpoint"); be != nil && be.Str("browseId") != "" {
			return be.Str("browseId"), be.PageType(), ""
		}
	}
	return n.BrowseID(), n.PageType(), n.VideoID()
}

// parseTopResult reads the large card shown for a confident match. It may point
// at a browse destination or be directly playable.
func parseTopResult(n Node) (domain.ShelfItem, bool) {
	title := textOf(n.Child("title"))
	if title == "" {
		return domain.ShelfItem{}, false
	}
	subtitle := textOf(n.Child("subtitle"))
	art := n.FindArtwork()

	browseID, pageType, videoID := topResultTarget(n)

	switch {
	case strings.Contains(pageType, "ARTIST"), strings.HasPrefix(browseID, "UC"):
		return domain.ShelfItem{Kind: domain.KindArtist, Artist: &domain.Artist{
			ID: browseID, Name: title, Artwork: art, Subscribers: subtitle,
		}}, true
	case strings.Contains(pageType, "ALBUM"), strings.HasPrefix(browseID, "MPRE"):
		return domain.ShelfItem{Kind: domain.KindAlbum, Album: &domain.Album{
			ID: browseID, Title: title, Artwork: art,
			Artists: cardArtists(n.Child("subtitle")),
		}}, true
	case strings.Contains(pageType, "PLAYLIST"), strings.HasPrefix(browseID, "VL"):
		return domain.ShelfItem{Kind: domain.KindPlaylist, Playlist: &domain.Playlist{
			ID: strings.TrimPrefix(browseID, "VL"), Title: title,
			Artwork: art, Description: subtitle,
		}}, true
	case videoID != "":
		return domain.ShelfItem{Kind: domain.KindTrack, Track: cardTrack(n, videoID, title, art)}, true
	}
	return domain.ShelfItem{}, false
}
