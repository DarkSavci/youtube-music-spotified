package renderers

import (
	"fmt"
	"strconv"
	"strings"

	"spotifier/internal/domain"
)

// Header node types. YouTube has migrated between these more than once and
// still serves both depending on surface and rollout, so every header read
// tries all of them rather than assuming the current one.
var headerNodes = []string{
	"musicResponsiveHeaderRenderer",
	"musicDetailHeaderRenderer",
	"musicImmersiveHeaderRenderer",
	"musicEditablePlaylistDetailHeaderRenderer",
	"musicVisualHeaderRenderer",
}

// findHeader returns the first recognised header node on a page.
func findHeader(doc Node) Node {
	for _, kind := range headerNodes {
		if h := Find(doc, kind); h != nil {
			return h
		}
	}
	return nil
}

// headerSubtitleRuns gathers the runs of every subtitle-ish line on a header,
// which is where type, artist, year and counts all live — in varying order.
func headerSubtitleRuns(h Node) []Node {
	var out []Node
	for _, key := range []string{"subtitle", "straplineTextOne", "secondSubtitle", "description"} {
		out = append(out, h.Child(key).Nodes("runs")...)
	}
	return out
}

// ---------- album ----------

// ParseAlbum reads an album browse response.
func ParseAlbum(doc Node, id string, pc ParseContext) (domain.Album, bool) {
	h := findHeader(doc)
	if h == nil {
		pc.unknown("album:noHeader")
		return domain.Album{}, false
	}
	al := domain.Album{ID: id}
	al.Title = textOf(h.Child("title"))
	if al.Title == "" {
		return domain.Album{}, false
	}
	al.Artwork = headerArtwork(h)
	al.Description = textOf(h.Child("description"))
	al.Explicit = IsExplicit(h)

	for _, r := range headerSubtitleRuns(h) {
		text := strings.TrimSpace(r.Str("text"))
		if text == "" || isSeparator(text) {
			continue
		}
		be := r.Child("navigationEndpoint").Child("browseEndpoint")
		browseID := be.Str("browseId")
		switch {
		case strings.HasPrefix(browseID, "UC"), strings.Contains(be.PageType(), "ARTIST"):
			al.Artists = append(al.Artists, domain.ArtistRef{ID: browseID, Name: text})
		case isYear(text):
			al.Year = text
		case strings.Contains(strings.ToLower(text), "song"):
			al.TrackCount = leadingInt(text)
		}
	}

	for _, n := range FindAll(doc, NodeShelf) {
		for _, c := range n.Nodes("contents") {
			if inner := c.Child(NodeListItem); inner != nil {
				if tr, ok := ParseTrack(inner); ok {
					// Album rows omit the album, since it is the page itself.
					if tr.Album == nil {
						tr.Album = &domain.AlbumRef{ID: id, Name: al.Title}
					}
					if len(tr.Artists) == 0 {
						tr.Artists = al.Artists
					}
					if len(tr.Artwork) == 0 {
						tr.Artwork = al.Artwork
					}
					al.Tracks = append(al.Tracks, tr)
				}
			}
		}
	}
	if al.TrackCount == 0 {
		al.TrackCount = len(al.Tracks)
	}
	for _, t := range al.Tracks {
		al.DurationMs += t.DurationMs
	}
	return al, true
}

// ---------- artist ----------

// ParseArtist reads an artist browse response.
//
// Sections absent from the response stay absent from the result. The UI renders
// only what exists, so an artist with no albums must not
// produce an empty Albums section.
func ParseArtist(doc Node, id string, pc ParseContext) (domain.Artist, bool) {
	h := findHeader(doc)
	if h == nil {
		pc.unknown("artist:noHeader")
		return domain.Artist{}, false
	}
	ar := domain.Artist{ID: id}
	ar.Name = textOf(h.Child("title"))
	if ar.Name == "" {
		return domain.Artist{}, false
	}
	ar.Artwork = headerArtwork(h)
	ar.Description = textOf(h.Child("description"))
	// The biography's runs carry a link to their source; keep the first one.
	for _, r := range h.Child("description").Nodes("runs") {
		if u := r.Child("navigationEndpoint").Child("urlEndpoint").Str("url"); u != "" {
			ar.DescriptionURL = u
			break
		}
	}

	/*
	 * Monthly audience is published by YouTube and is the figure other
	 * clients call monthly listeners.
	 *
	 * It was assumed not to exist, so the artist page showed a subscriber
	 * count in its place with a note explaining the substitution. The count
	 * is in the header under its own key; both are kept, because they mean
	 * different things and the page shows both.
	 */
	ar.MonthlyListeners = textOf(h.Child("monthlyListenerCount"))

	// Subscriber count is display text.
	for _, key := range []string{"subscriptionButton", "subtitle", "secondSubtitle"} {
		if sub := h.Child(key); sub != nil {
			if btn := sub.Child("subscribeButtonRenderer"); btn != nil {
				ar.Subscribers = textOf(btn.Child("subscriberCountText"))
				// The same button states whether the account is subscribed.
				ar.Following = btn.Bool("subscribed")
			}
			if ar.Subscribers == "" {
				if txt := textOf(sub); strings.Contains(strings.ToLower(txt), "subscriber") {
					ar.Subscribers = txt
				}
			}
		}
		if ar.Subscribers != "" {
			break
		}
	}

	if play := Find(h, "watchEndpoint"); play != nil {
		ar.RadioID = play.Str("playlistId")
	}
	if shuffle := Find(h, "shuffleEndpoint"); shuffle != nil {
		ar.ShuffleID = shuffle.Str("playlistId")
	}

	// Classify shelves by title: YouTube labels them, and the labels are what
	// distinguish top tracks from albums from singles.
	for _, kind := range []string{NodeShelf, NodeCarousel} {
		for _, n := range FindAll(doc, kind) {
			sh, ok := ParseShelf(n, kind, pc)
			if !ok {
				continue
			}
			title := strings.ToLower(sh.Title)
			switch {
			case strings.Contains(title, "song"):
				for _, it := range sh.Items {
					if it.Kind == domain.KindTrack && it.Track != nil {
						ar.TopTracks = append(ar.TopTracks, *it.Track)
					}
				}
			case strings.Contains(title, "single"), strings.Contains(title, "ep"):
				for _, it := range sh.Items {
					if it.Kind == domain.KindAlbum && it.Album != nil {
						ar.Singles = append(ar.Singles, *it.Album)
					}
				}
			case strings.Contains(title, "album"):
				for _, it := range sh.Items {
					if it.Kind == domain.KindAlbum && it.Album != nil {
						ar.Albums = append(ar.Albums, *it.Album)
					}
				}
			case strings.Contains(title, "fans"), strings.Contains(title, "similar"), strings.Contains(title, "related"):
				for _, it := range sh.Items {
					if it.Kind == domain.KindArtist && it.Artist != nil {
						ar.Related = append(ar.Related, *it.Artist)
					}
				}
			}
		}
	}
	return ar, true
}

// ---------- playlist ----------

// ParsePlaylist reads a playlist browse response.
func ParsePlaylist(doc Node, id string, pc ParseContext) (domain.Playlist, bool) {
	h := findHeader(doc)
	pl := domain.Playlist{ID: strings.TrimPrefix(id, "VL")}
	if h != nil {
		pl.Title = textOf(h.Child("title"))
		pl.Artwork = headerArtwork(h)
		pl.Description = textOf(h.Child("description"))
		pl.Editable = Find(doc, "musicEditablePlaylistDetailHeaderRenderer") != nil

		for _, r := range headerSubtitleRuns(h) {
			text := strings.TrimSpace(r.Str("text"))
			if text == "" || isSeparator(text) {
				continue
			}
			be := r.Child("navigationEndpoint").Child("browseEndpoint")
			lower := strings.ToLower(text)
			switch {
			case strings.HasPrefix(be.Str("browseId"), "UC"):
				if pl.Owner == "" {
					pl.Owner, pl.OwnerID = text, be.Str("browseId")
				}
			case strings.Contains(lower, "song"), strings.Contains(lower, "track"):
				pl.TrackCount = leadingInt(text)
			}
		}
	}
	if pl.Title == "" {
		pl.Title = textOf(Find(doc, "musicHeaderRenderer").Child("title"))
	}
	if pl.Title == "" {
		pc.unknown("playlist:noTitle")
		return domain.Playlist{}, false
	}

	for _, n := range playlistShelves(doc) {
		pl.Tracks = append(pl.Tracks, listTracks(n.Nodes("contents"))...)
	}
	if pl.TrackCount == 0 {
		pl.TrackCount = len(pl.Tracks)
	}
	for _, t := range pl.Tracks {
		pl.DurationMs += t.DurationMs
	}
	return pl, true
}

/*
AppendPlaylistPages pages in the rest of a playlist's tracks.

A playlist browse returns only its first 100 tracks; the rest come 100 at a
time from continuation calls, which fetch makes. first is the first page, the
one pl was parsed from. An error from fetch is returned as is, since a
playlist silently missing its tail looks complete when it is not.
*/
func AppendPlaylistPages(pl *domain.Playlist, first Node, fetch func(token string) (Node, error)) error {
	derivedCount := pl.TrackCount == len(pl.Tracks)
	tok := PlaylistNext(first)
	seen := map[string]bool{}
	for tok != "" {
		if seen[tok] {
			return fmt.Errorf("repeated playlist continuation")
		}
		seen[tok] = true
		doc, err := fetch(tok)
		if err != nil {
			return err
		}
		tracks, next := ParsePlaylistContinuation(doc)
		pl.Tracks = append(pl.Tracks, tracks...)
		for _, t := range tracks {
			pl.DurationMs += t.DurationMs
		}
		tok = next
	}
	if derivedCount {
		pl.TrackCount = len(pl.Tracks)
	}
	return nil
}

// playlistShelves are the shelves holding a playlist page's tracks.
func playlistShelves(doc Node) []Node {
	var out []Node
	for _, kind := range []string{NodeShelf, "musicPlaylistShelfRenderer"} {
		out = append(out, FindAll(doc, kind)...)
	}
	return out
}

// listTracks reads the tracks out of a track list's entries.
func listTracks(entries []Node) []domain.Track {
	var out []domain.Track
	for _, c := range entries {
		if inner := c.Child(NodeListItem); inner != nil {
			if tr, ok := ParseTrack(inner); ok {
				out = append(out, tr)
			}
		}
	}
	return out
}

/*
playlistContinuation is the token for the tracks after a playlist's first page.

It is read from the entry ending the track list, never from the page as a
whole: the section list below carries its own continuation, which pages in
suggestions rather than tracks.
*/
func playlistContinuation(shelves []Node) string {
	for _, n := range shelves {
		if tok := continuationItemToken(n.Nodes("contents")); tok != "" {
			return tok
		}
	}
	return ""
}

// continuationItemToken is the token of the continuation entry ending a list,
// empty when the list is the last of it.
func continuationItemToken(entries []Node) string {
	for _, c := range entries {
		cmd := c.Child("continuationItemRenderer").Child("continuationEndpoint").Child("continuationCommand")
		if tok := cmd.Str("token"); tok != "" {
			return tok
		}
	}
	return ""
}

// pageType marking the lyrics tab of a `next` response. Stable across
// locales, unlike the tab's display title.
const pageTypeTrackLyrics = "MUSIC_PAGE_TYPE_TRACK_LYRICS"

// ---------- watch queue ----------

// ParseWatchQueue reads a `next` response into the Tracks that follow, plus the
// lyrics browse identifier when the response offers one.
func ParseWatchQueue(doc Node) (tracks []domain.Track, lyricsID string) {
	for _, n := range queueEntries(doc) {
		if tr, ok := ParseQueueTrack(n); ok {
			tracks = append(tracks, tr)
		}
	}
	/*
	 * Find the lyrics tab by page type, not by its title.
	 *
	 * The title is a localised display string — "Lyrics", "Şarkı Sözleri",
	 * "Paroles" — so matching it works only in English, and it arrives as a
	 * bare string rather than the usual runs object, so reading it as text
	 * returned empty even then. The page type is the identifier and is the
	 * same in every language.
	 */
	for _, be := range FindAll(doc, "browseEndpoint") {
		cfg := be.Child("browseEndpointContextSupportedConfigs").
			Child("browseEndpointContextMusicConfig")
		if cfg.Str("pageType") == pageTypeTrackLyrics {
			if id := be.Str("browseId"); id != "" {
				lyricsID = id
				break
			}
		}
	}
	return tracks, lyricsID
}

/*
queueEntries finds a watch queue's entries, in order, once each.

An entry is sometimes a wrapper holding the song (primaryRenderer) and its
music-video version (counterpart) — the pair YouTube Music's song/video
switch flips between. The counterpart is the same entry, so it is skipped:
reading it too put every such song in the queue twice.
*/
func queueEntries(v any) []Node {
	var out []Node
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case Node:
			walk(map[string]any(x))
		case map[string]any:
			for k, c := range x {
				switch k {
				case "counterpart":
					continue
				case NodeQueueItem:
					if n, ok := c.(map[string]any); ok {
						out = append(out, Node(n))
					}
					continue
				}
				walk(c)
			}
		case []any:
			for _, c := range x {
				walk(c)
			}
		}
	}
	walk(v)
	return out
}

// RadioContinuation is the token for the next page of a radio queue, from
// either a first page or a continuation of one. Empty when there is no more.
func RadioContinuation(doc Node) string {
	for _, key := range []string{"nextRadioContinuationData", "nextContinuationData"} {
		if tok := Find(doc, key).Str("continuation"); tok != "" {
			return tok
		}
	}
	return ""
}

// ---------- small helpers ----------

func isYear(s string) bool {
	if len(s) != 4 {
		return false
	}
	n, err := strconv.Atoi(s)
	return err == nil && n >= 1900 && n <= 2100
}

// leadingInt reads the number at the start of text like "12 songs", tolerating
// thousands separators.
func leadingInt(s string) int {
	var digits strings.Builder
	for _, c := range s {
		if c >= '0' && c <= '9' {
			digits.WriteRune(c)
			continue
		}
		if c == ',' || c == '.' || c == ' ' {
			if digits.Len() > 0 {
				continue
			}
			continue
		}
		break
	}
	n, _ := strconv.Atoi(digits.String())
	return n
}

// ---------- lyrics ----------

// ParseLyrics reads a lyrics browse response.
//
// The shape is a single description shelf: the whole text in one run, and the
// attribution in a footer. The attribution is not decoration — the providers
// require it to be shown — so an empty footer is still worth carrying through
// rather than dropping.
func ParseLyrics(doc Node) (text, source string) {
	shelf := Find(doc, "musicDescriptionShelfRenderer")
	if shelf == nil {
		return "", ""
	}
	text = textOf(shelf.Child("description"))
	source = strings.TrimSpace(strings.TrimPrefix(textOf(shelf.Child("footer")), "Source:"))
	return text, source
}

/*
ParseTimedLyrics reads the timed payload YouTube serves to its mobile clients.

The web client is given the same words with no timings at all, which is why
lyrics appeared to be unavailable in timed form and a third-party lookup was
used instead. Each entry carries a cue range in milliseconds, as strings.

Empty lines are kept: an instrumental gap is real time passing, and dropping it
makes the view run ahead of the music.
*/
func ParseTimedLyrics(doc Node) (lines []domain.LyricLine, source string) {
	for _, e := range FindArray(doc, "timedLyricsData") {
		text := e.Str("lyricLine")
		cue := e.Child("cueRange")
		if cue == nil {
			continue
		}
		startMs, err := strconv.ParseInt(cue.Str("startTimeMilliseconds"), 10, 64)
		if err != nil {
			continue
		}
		lines = append(lines, domain.LyricLine{AtMs: startMs, Text: strings.TrimSpace(text)})
	}

	if footer := Find(doc, "footer"); footer != nil {
		source = strings.TrimSpace(strings.TrimPrefix(textOf(footer), "Source:"))
	}
	if source == "" {
		source = strings.TrimSpace(strings.TrimPrefix(
			textOf(Find(doc, "musicDescriptionShelfRenderer").Child("footer")), "Source:"))
	}
	return lines, source
}

// PlaylistNext reads only the playlist shelf's continuation, not suggestions.
func PlaylistNext(doc Node) string { return playlistContinuation(playlistShelves(doc)) }

// ParsePlaylistContinuation reads a single track page, retaining repeated
// songs: duplicates can be intentional playlist entries.
func ParsePlaylistContinuation(doc Node) ([]domain.Track, string) {
	items := Find(doc, "appendContinuationItemsAction").Nodes("continuationItems")
	if len(items) == 0 {
		shelf := Find(doc, "musicPlaylistShelfContinuation")
		items = shelf.Nodes("contents")
		tracks := listTracks(items)
		next := continuationItemToken(items)
		if next == "" {
			for _, c := range shelf.Nodes("continuations") {
				if next = c.Child("nextContinuationData").Str("continuation"); next != "" {
					break
				}
			}
		}
		return tracks, next
	}
	return listTracks(items), continuationItemToken(items)
}

// ParseTrackVersions returns only an explicit YouTube song/video pair that
// contains the requested id. Unrelated recommendations are never matches.
func ParseTrackVersions(doc Node, id string) []domain.Track {
	for _, wrapper := range FindAll(doc, "playlistPanelVideoWrapperRenderer") {
		var tracks []domain.Track
		contains := false
		for _, node := range FindAll(wrapper, NodeQueueItem) {
			if tr, ok := ParseQueueTrack(node); ok {
				tr.IsVideo = isVideoTrack(node)
				tracks = append(tracks, tr)
				if tr.ID == id {
					contains = true
				}
			}
		}
		if contains {
			return tracks
		}
	}
	for _, node := range FindAll(doc, NodeQueueItem) {
		if tr, ok := ParseQueueTrack(node); ok && tr.ID == id {
			tr.IsVideo = isVideoTrack(node)
			return []domain.Track{tr}
		}
	}
	return nil
}
