package renderers

import (
	"strings"

	"spotifier/internal/domain"
)

/*
Podcasts and episodes.

These were skipped as out of scope, on the reasoning that this is a music
client. That was wrong about YouTube Music, which carries podcasts as a
first-class kind with its own search filter, its own browse pages and its own
library surface — so a search for a show returned nothing at all.

Two shapes, distinguished by their navigation target rather than by their
layout, because both arrive as ordinary list rows:

  MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE  a show,    browseId MPSP…
  MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE an episode, browseId MPED… + videoId

Some shows point at a user channel instead, which is a channel page rather than
a show page; those are recognised by the podcast filter's own results, since a
row returned under that filter is a show whatever it links to.

An Episode carries a videoId, so it resolves and plays through exactly the same
path as a Track. Nothing below playback needs to know podcasts exist.
*/

const (
	pageTypePodcastShow = "PODCAST_SHOW_DETAIL_PAGE"
	pageTypeEpisode     = "NON_MUSIC_AUDIO_TRACK_PAGE"
)

// IsPodcastTarget reports whether a navigation target is a podcast show.
func IsPodcastTarget(browseID, pageType string) bool {
	return strings.Contains(pageType, pageTypePodcastShow) || strings.HasPrefix(browseID, "MPSP")
}

// IsEpisodeTarget reports whether a navigation target is a podcast episode.
func IsEpisodeTarget(browseID, pageType string) bool {
	return strings.Contains(pageType, pageTypeEpisode) || strings.HasPrefix(browseID, "MPED")
}

/*
ParsePodcast reads a show from a list row or a card.

The author sits in the second column with its own channel endpoint, which is
what makes it clickable rather than a label.
*/
func ParsePodcast(n Node) (domain.Podcast, bool) {
	if n == nil {
		return domain.Podcast{}, false
	}
	title := rowTitle(n)
	if title == "" {
		return domain.Podcast{}, false
	}

	nav := n.Child("navigationEndpoint")
	browseID := nav.Child("browseEndpoint").Str("browseId")
	if browseID == "" {
		if be := Find(n, "browseEndpoint"); be != nil {
			browseID = be.Str("browseId")
		}
	}
	if browseID == "" {
		return domain.Podcast{}, false
	}

	out := domain.Podcast{
		ID:       browseID,
		Title:    title,
		Artwork:  n.FindArtwork(),
		Episodes: []domain.Episode{},
	}

	// The second column is the author, linked to their own channel.
	if cols := flexColumns(n); len(cols) > 1 {
		out.Author = strings.TrimSpace(textOf(cols[1].Child("text")))
		for _, r := range cols[1].Child("text").Nodes("runs") {
			if be := r.Child("navigationEndpoint").Child("browseEndpoint"); be != nil {
				if id := be.Str("browseId"); strings.HasPrefix(id, "UC") {
					out.AuthorID = id
					break
				}
			}
		}
	}
	if out.Author == "" {
		out.Author = strings.TrimSpace(textOf(n.Child("subtitle")))
	}
	return out, true
}

/*
ParseEpisode reads one instalment.

An Episode is a Track with a publication date and a show attached, so it plays
through exactly the same path — upstream it is a video like any other.
*/
func ParseEpisode(n Node) (domain.Episode, bool) {
	if n == nil {
		return domain.Episode{}, false
	}
	title := rowTitle(n)
	if title == "" {
		return domain.Episode{}, false
	}

	videoID := ""
	if w := Find(n, "watchEndpoint"); w != nil {
		videoID = w.Str("videoId")
	}
	if videoID == "" {
		// MPED<videoId>: the identifier is the browse id with its prefix off.
		if be := Find(n, "browseEndpoint"); be != nil {
			if id := be.Str("browseId"); strings.HasPrefix(id, "MPED") {
				videoID = strings.TrimPrefix(id, "MPED")
			}
		}
	}
	if videoID == "" {
		return domain.Episode{}, false
	}

	ep := domain.Episode{Track: domain.Track{
		ID:       videoID,
		Title:    title,
		Artwork:  n.FindArtwork(),
		Playable: !isUnavailable(n),
		Artists:  []domain.ArtistRef{},
	}}

	/*
	 * The subtitle is a bulleted list whose order is not fixed.
	 *
	 * A search result reads "5d ago • HARMAN"; a show's own page reads
	 * "575K views • 5d ago", because the show is already named by the page.
	 * Reading by position put a view count where a publication date belongs
	 * and printed "575K views" as a time, so each part is classified by its
	 * shape instead.
	 */
	subtitle := ""
	if cols := flexColumns(n); len(cols) > 1 {
		subtitle = textOf(cols[1].Child("text"))
		for _, r := range cols[1].Child("text").Nodes("runs") {
			if be := r.Child("navigationEndpoint").Child("browseEndpoint"); be != nil {
				if id := be.Str("browseId"); IsPodcastTarget(id, be.PageType()) {
					if ep.Podcast == nil {
						ep.Podcast = &domain.PodcastRef{}
					}
					ep.Podcast.ID = id
				}
			}
		}
	}
	if subtitle == "" {
		subtitle = textOf(n.Child("subtitle"))
	}
	applyEpisodeSubtitle(&ep, subtitle)

	ep.Description = textOf(n.Child("description"))

	// Duration lives in a fixed column on some surfaces, as it does for tracks.
	if ep.DurationMs == 0 {
		for _, fc := range n.Nodes("fixedColumns") {
			if d := DurationMs(textOf(fc.Child("musicResponsiveListItemFixedColumnRenderer").Child("text"))); d > 0 {
				ep.DurationMs = d
				break
			}
		}
	}
	return ep, true
}

// rowTitle reads the first column, which every row shape puts the name in.
func rowTitle(n Node) string {
	if cols := flexColumns(n); len(cols) > 0 {
		if t := textOf(cols[0].Child("text")); t != "" {
			return t
		}
	}
	return textOf(n.Child("title"))
}

/*
ParsePodcastPage reads a show's browse response.

The header shape varies — a show page uses the two-column header, a channel
page the immersive one — so the title is taken from whichever is present
rather than from a fixed path. Episodes are ordinary list rows.
*/
func ParsePodcastPage(doc Node, id string, pc ParseContext) (domain.Podcast, bool) {
	out := domain.Podcast{ID: id, Episodes: []domain.Episode{}}

	for _, key := range []string{
		"musicDetailHeaderRenderer",
		"musicResponsiveHeaderRenderer",
		"musicImmersiveHeaderRenderer",
		"musicVisualHeaderRenderer",
	} {
		h := Find(doc, key)
		if h == nil {
			continue
		}
		out.Title = textOf(h.Child("title"))
		out.Description = textOf(h.Child("description"))
		out.Artwork = headerArtwork(h)
		if out.Author == "" {
			out.Author = strings.TrimSpace(textOf(h.Child("straplineTextOne")))
		}
		if out.Author == "" {
			out.Author = strings.TrimSpace(textOf(h.Child("subtitle")))
		}
		if out.Title != "" {
			break
		}
	}
	if out.Title == "" {
		out.Title = textOf(Find(doc, "musicDescriptionShelfRenderer").Child("header"))
	}

	for _, row := range FindAll(doc, NodeListItem) {
		if ep, ok := ParseEpisode(row); ok {
			out.Episodes = append(out.Episodes, ep)
		}
	}
	// Some shows list episodes as multi-row items instead.
	for _, row := range FindAll(doc, "musicMultiRowListItemRenderer") {
		if ep, ok := ParseEpisode(row); ok {
			out.Episodes = append(out.Episodes, ep)
		}
	}

	if out.Artwork == nil {
		out.Artwork = domain.ArtworkSet{}
	}
	if out.Title == "" && len(out.Episodes) == 0 {
		pc.unknown("podcastPage")
		return domain.Podcast{}, false
	}
	return out, true
}

/*
applyEpisodeSubtitle splits a bulleted subtitle into its parts.

Each part is classified by shape rather than by position, because the order
differs between surfaces: a view count, a publication time, and whatever is
left is the show's name.
*/
func applyEpisodeSubtitle(ep *domain.Episode, subtitle string) {
	for _, raw := range strings.Split(subtitle, "•") {
		part := strings.TrimSpace(raw)
		if part == "" {
			continue
		}
		switch {
		case looksLikeMetadata(part):
			if ep.PlayCount == "" {
				ep.PlayCount = part
			}
		case looksLikePublished(part):
			if ep.PublishedText == "" {
				ep.PublishedText = part
			}
		default:
			if ep.Podcast == nil {
				ep.Podcast = &domain.PodcastRef{}
			}
			if ep.Podcast.Title == "" {
				ep.Podcast.Title = part
			}
		}
	}
	// The show stands in for the artist wherever a Track's artist is shown.
	if ep.Podcast != nil && ep.Podcast.Title != "" && len(ep.Artists) == 0 {
		ep.Artists = []domain.ArtistRef{{Name: ep.Podcast.Title}}
	}
}

// looksLikePublished recognises the relative and short absolute dates YouTube
// uses ("5d ago", "3 weeks ago", "Sep 7").
func looksLikePublished(s string) bool {
	t := strings.ToLower(strings.TrimSpace(s))
	if strings.HasSuffix(t, "ago") {
		return true
	}
	for _, m := range []string{
		"jan", "feb", "mar", "apr", "may", "jun",
		"jul", "aug", "sep", "oct", "nov", "dec",
	} {
		if strings.HasPrefix(t, m) {
			return true
		}
	}
	return false
}
