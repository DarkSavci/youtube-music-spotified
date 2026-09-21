// Package domain holds the vocabulary of the application.
//
// These types are the insulation layer between YouTube Music's wire format and
// everything else. No InnerTube vocabulary appears here: no browseId, no
// renderer node shapes, no runs[0].text. Parsers translate into these types;
// nothing downstream should ever need to know where they came from.
//
// packages/types is generated from this package, so changes here are contract
// changes for the UI as well.
package domain

import "time"

// ---------- artwork ----------

// Artwork is one size of an image. A set of Artwork is kept sorted ascending
// by Width.
type Artwork struct {
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// ArtworkSet is every available size for one image, ascending by width.
type ArtworkSet []Artwork

// AtLeast returns the smallest Artwork at least minWidth wide, or the largest
// available if none is big enough. Zero value if the set is empty.
func (s ArtworkSet) AtLeast(minWidth int) Artwork {
	if len(s) == 0 {
		return Artwork{}
	}
	for _, a := range s {
		if a.Width >= minWidth {
			return a
		}
	}
	return s[len(s)-1]
}

// ---------- references ----------

// ArtistRef names an Artist without carrying the full entity. ID may be empty:
// YouTube Music sometimes credits an artist it has no page for.
type ArtistRef struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
}

// AlbumRef names an Album without carrying the full entity.
type AlbumRef struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
}

// ---------- entities ----------

// Track is a playable item. ID is the YouTube video identifier.
//
// A Track may be a song or a music video; IsVideo distinguishes them, and the
// UI hides videos by default.
type Track struct {
	ID         string      `json:"id"`
	Title      string      `json:"title"`
	Artists    []ArtistRef `json:"artists"`
	Album      *AlbumRef   `json:"album,omitempty"`
	DurationMs int64       `json:"durationMs"`
	Artwork    ArtworkSet  `json:"artwork"`

	Explicit bool `json:"explicit"`
	IsVideo  bool `json:"isVideo"`

	// Playable is false when YouTube reports the Track as unavailable in this
	// region or otherwise blocked. The UI renders these greyed and unclickable
	// rather than hiding them, so a playlist keeps its shape.
	Playable bool `json:"playable"`

	// PlayCount is YouTube's own play count where exposed, as display text
	// ("68M plays"). We show this where Spotify shows a saves count, labelled
	// honestly. Empty when not exposed.
	PlayCount string `json:"playCount,omitempty"`

	// LibraryAddToken and LibraryRemoveToken are opaque single-use tokens that
	// toggle library membership. They cannot be constructed, only echoed back,
	// and they expire with the response that carried them.
	LibraryAddToken    string `json:"-"`
	LibraryRemoveToken string `json:"-"`

	// PlaylistItemID identifies this Track's membership in a specific Playlist.
	// Required to remove or reorder it. Only set when the Track was read as part
	// of a Playlist.
	PlaylistItemID string `json:"playlistItemId,omitempty"`

	// AddedAt is when we first observed this Track in its containing Playlist.
	// Ours, not YouTube's — YouTube does not expose an added date. Nil means
	// "present before we started tracking", which the UI renders as an em dash
	// and sorts last.
	AddedAt *time.Time `json:"addedAt,omitempty"`
}

// Album is a release.
type Album struct {
	ID            string      `json:"id"`
	Title         string      `json:"title"`
	Artists       []ArtistRef `json:"artists"`
	Year          string      `json:"year,omitempty"`
	TrackCount    int         `json:"trackCount"`
	DurationMs    int64       `json:"durationMs,omitempty"`
	Artwork       ArtworkSet  `json:"artwork"`
	DominantColor string      `json:"dominantColor,omitempty"`
	Description   string      `json:"description,omitempty"`
	Explicit      bool        `json:"explicit"`
	Tracks        []Track     `json:"tracks,omitempty"`
}

// Artist is a performer with a YouTube Music page. ID is the channel identifier.
type Artist struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Artwork       ArtworkSet `json:"artwork"`
	DominantColor string     `json:"dominantColor,omitempty"`
	Description   string     `json:"description,omitempty"`

	// Subscribers is display text ("1.2M subscribers").
	Subscribers string `json:"subscribers,omitempty"`

	// Following reports whether the signed-in account already follows this
	// Artist. The subscribe button in the artist header carries it, which was
	// previously assumed not to exist — the Follow button was optimistic as a
	// result, and showed "Follow" for artists the account already followed.
	Following bool `json:"following"`

	// MonthlyListeners is YouTube's own "monthly audience" figure, which it
	// does publish — this was previously assumed not to exist, and the artist
	// page showed subscribers in its place with a note explaining the
	// substitution. Display text, because that is how it arrives.
	MonthlyListeners string `json:"monthlyListeners,omitempty"`

	// RadioID and ShuffleID seed endless playback from this Artist.
	RadioID   string `json:"radioId,omitempty"`
	ShuffleID string `json:"shuffleId,omitempty"`

	TopTracks []Track `json:"topTracks,omitempty"`
	Albums    []Album `json:"albums,omitempty"`
	Singles   []Album `json:"singles,omitempty"`
	// DescriptionURL is the source the biography links to, usually Wikipedia.
	// The text arrives with linked runs and flattening it to a string dropped
	// them, leaving prose with no way back to where it came from.
	DescriptionURL string `json:"descriptionUrl,omitempty"`

	// Related carries whole Artists rather than references, because "fans also
	// like" is rendered as cards and a card needs artwork. Narrowing these to
	// a name and an identifier discarded the thumbnails that were already in
	// the response, and the row drew five empty circles.
	Related []Artist `json:"related,omitempty"`
}

// Playlist is an ordered collection of Tracks.
type Playlist struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Description   string     `json:"description,omitempty"`
	Owner         string     `json:"owner,omitempty"`
	OwnerID       string     `json:"ownerId,omitempty"`
	TrackCount    int        `json:"trackCount"`
	DurationMs    int64      `json:"durationMs,omitempty"`
	Artwork       ArtworkSet `json:"artwork"`
	DominantColor string     `json:"dominantColor,omitempty"`
	Collaborative bool       `json:"collaborative"`

	// Editable is true when the signed-in user may modify this Playlist.
	Editable bool    `json:"editable"`
	Tracks   []Track `json:"tracks,omitempty"`
}

// ---------- browse surfaces ----------

// ShelfItemKind tags the heterogeneous contents of a Shelf.
type ShelfItemKind string

const (
	KindTrack    ShelfItemKind = "track"
	KindAlbum    ShelfItemKind = "album"
	KindArtist   ShelfItemKind = "artist"
	KindPlaylist ShelfItemKind = "playlist"
	KindPodcast  ShelfItemKind = "podcast"
	KindEpisode  ShelfItemKind = "episode"
)

// ShelfItem is one card in a Shelf. Exactly one payload field is non-nil,
// indicated by Kind.
type ShelfItem struct {
	Kind     ShelfItemKind `json:"kind"`
	Track    *Track        `json:"track,omitempty"`
	Album    *Album        `json:"album,omitempty"`
	Artist   *Artist       `json:"artist,omitempty"`
	Playlist *Playlist     `json:"playlist,omitempty"`
	Podcast  *Podcast      `json:"podcast,omitempty"`
	Episode  *Episode      `json:"episode,omitempty"`
}

// Shelf is a horizontally scrolling row of cards on a browse surface.
type Shelf struct {
	Title string      `json:"title"`
	Items []ShelfItem `json:"items"`

	// ShowAllID addresses the full grid behind this Shelf, empty when there
	// isn't one.
	ShowAllID string `json:"showAllId,omitempty"`

	// Continuation fetches more items in this Shelf, empty when exhausted.
	Continuation string `json:"continuation,omitempty"`
}

// MoodChip is one entry in the mood-and-genre grid.
//
// YouTube supplies a per-chip colour, which is what Spotify's browse-all tiles
// use theirs for — so the grid can be rendered as those tiles directly rather
// than inventing a palette.
type MoodChip struct {
	ID     string `json:"id"`
	Params string `json:"params,omitempty"`
	Title  string `json:"title"`

	// Color is "#RRGGBB", derived from YouTube's own stripe colour.
	Color string `json:"color,omitempty"`
}

// BrowsePage is any shelf-based surface: home, explore, charts, moods.
//
// Moods is populated only by grid-shaped surfaces; Shelves only by row-shaped
// ones. A surface may legitimately produce one and not the other, so callers
// must not assume either is present.
type BrowsePage struct {
	Title        string     `json:"title,omitempty"`
	Shelves      []Shelf    `json:"shelves"`
	Moods        []MoodChip `json:"moods,omitempty"`
	Continuation string     `json:"continuation,omitempty"`
}

// ---------- search ----------

// SearchFilter narrows a search to one result kind. Empty means everything.
type SearchFilter string

const (
	FilterNone      SearchFilter = ""
	FilterSongs     SearchFilter = "songs"
	FilterVideos    SearchFilter = "videos"
	FilterAlbums    SearchFilter = "albums"
	FilterArtists   SearchFilter = "artists"
	FilterPlaylists SearchFilter = "playlists"
	FilterPodcasts  SearchFilter = "podcasts"
	FilterEpisodes  SearchFilter = "episodes"
)

// SearchResults is one page of search output.
//
// TopResult is the large card YouTube Music returns for a confident match. It
// may be any kind, and may be directly playable rather than a browse
// destination.
type SearchResults struct {
	Query     string     `json:"query"`
	TopResult *ShelfItem `json:"topResult,omitempty"`
	// TopResultItems are what YouTube shows inside the top result's card:
	// the album's songs, the artist's top songs, other versions of a song.
	TopResultItems []ShelfItem `json:"topResultItems,omitempty"`
	Shelves        []Shelf     `json:"shelves"`
	Continuation   string      `json:"continuation,omitempty"`
}

// ---------- library ----------

// LibraryItemKind tags a saved item's type.
type LibraryItemKind string

const (
	LibPlaylist LibraryItemKind = "playlist"
	LibAlbum    LibraryItemKind = "album"
	LibArtist   LibraryItemKind = "artist"
	LibPodcast  LibraryItemKind = "podcast"
)

// LibraryItem is one entry in the merged sidebar list. YouTube Music has no
// unified library surface: this shape is produced by fanning out across several
// upstream surfaces and normalising.
type LibraryItem struct {
	ID            string          `json:"id"`
	Kind          LibraryItemKind `json:"kind"`
	Title         string          `json:"title"`
	Subtitle      string          `json:"subtitle,omitempty"`
	Artwork       ArtworkSet      `json:"artwork"`
	DominantColor string          `json:"dominantColor,omitempty"`

	// AddedAt, FolderID and Pinned are ours — YouTube Music has no equivalent.
	// AddedAt is nil for items present before we started tracking.
	AddedAt  *time.Time `json:"addedAt,omitempty"`
	FolderID string     `json:"folderId,omitempty"`
	Pinned   bool       `json:"pinned"`

	// LastPlayedAt comes from the Play log and drives the Recents sort.
	LastPlayedAt *time.Time `json:"lastPlayedAt,omitempty"`
}

// Folder is a user-created container for LibraryItems. Entirely ours.
type Folder struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ParentID string `json:"parentId,omitempty"`
}

// ---------- playback ----------

// StreamKind says how a Stream should be handed to a PlaybackEngine.
type StreamKind string

const (
	// StreamURL carries a resolved, expiring, IP-bound media URL. The native
	// engine fetches it.
	StreamURL StreamKind = "url"

	// StreamVideoID carries only the identifier. The iframe engine needs no
	// URL — it hands the id to YouTube's own player.
	StreamVideoID StreamKind = "videoId"
)

// Stream is a handle to playable audio.
//
// It is deliberately not always a URL: the iframe engine needs a videoId and
// the native engine needs a URL, and the Session core must not need to know
// which engine is active.
//
// A Stream of kind StreamURL is bound to the Device that resolved it — the
// requesting IP is inside the URL's signature — and expires. It must never be
// transferred to another Device or cached across sessions.
type Stream struct {
	Kind    StreamKind `json:"kind"`
	VideoID string     `json:"videoId"`

	// URL is set only when Kind is StreamURL.
	URL string `json:"url,omitempty"`

	MimeType   string    `json:"mimeType,omitempty"`
	Bitrate    int       `json:"bitrate,omitempty"`
	SizeBytes  int64     `json:"sizeBytes,omitempty"`
	DurationMs int64     `json:"durationMs,omitempty"`
	ExpiresAt  time.Time `json:"expiresAt,omitzero"`
}

// Expired reports whether a resolved Stream is past its usable window.
func (s Stream) Expired(now time.Time) bool {
	return s.Kind == StreamURL && !s.ExpiresAt.IsZero() && now.After(s.ExpiresAt)
}

// RepeatMode is the queue's repeat behaviour.
type RepeatMode string

const (
	RepeatOff RepeatMode = "off"
	RepeatOne RepeatMode = "one"
	RepeatAll RepeatMode = "all"
)

// Queue is the ordered list of Tracks for a Session, plus the current index.
//
// Invariant: when Items is non-empty, 0 <= Index < len(Items).
type Queue struct {
	Items []Track `json:"items"`
	Index int     `json:"index"`

	// Origin describes where the Queue came from, for the "Next from …" label.
	Origin string `json:"origin,omitempty"`
}

// Current returns the Track at Index, or nil if the Queue is empty.
//
// Value receiver so it works on a Queue read out of a Session by value. The
// returned pointer aims into the shared backing array and is for reading.
func (q Queue) Current() *Track {
	if len(q.Items) == 0 || q.Index < 0 || q.Index >= len(q.Items) {
		return nil
	}
	return &q.Items[q.Index]
}

// PlayState is the coarse playback status.
type PlayState string

const (
	StateIdle    PlayState = "idle"
	StateLoading PlayState = "loading"
	StatePlaying PlayState = "playing"
	StatePaused  PlayState = "paused"
	StateStalled PlayState = "stalled"
)

// Session is the semantic state of listening: queue, position, and mode.
//
// This one struct is the persistence format, the wire format, and the payload
// of a Connect transfer. It is authoritative in Go and never contains a
// resolved Stream URL, because those are Device-bound.
type Session struct {
	// Version increases on every accepted command and totally orders state.
	// A projection with a Version at or below one already seen is dropped.
	Version uint64 `json:"version"`

	// Epoch increases on every track change and every Device transfer. Engine
	// reports carrying a stale Epoch are discarded, which prevents a
	// swapped-out engine's late "ended" from skipping the track that just
	// started.
	Epoch uint64 `json:"epoch"`

	Queue   Queue      `json:"queue"`
	State   PlayState  `json:"state"`
	Repeat  RepeatMode `json:"repeat"`
	Shuffle bool       `json:"shuffle"`
	Volume  float64    `json:"volume"`

	// PositionMs and PositionAt form an anchor. Consumers interpolate from
	// these rather than receiving position events at frame rate.
	PositionMs int64     `json:"positionMs"`
	PositionAt time.Time `json:"positionAt"`

	// OwnerDeviceID is the Device currently producing sound. Exactly one.
	OwnerDeviceID string `json:"ownerDeviceId,omitempty"`

	// Degraded records Tracks that failed to play, by queue index.
	Degraded []TrackFault `json:"degraded,omitempty"`
}

// TrackFault records why a queued Track could not be played.
type TrackFault struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

// ---------- lyrics ----------

// Lyrics is a Track's words, timed when the source provides timings.
//
// Two shapes rather than one, because they are genuinely different things to
// render: Plain is a block of text to read, Lines are cues to follow. A
// consumer that only knows how to show text still works with a synced result,
// because Plain is always populated.
type Lyrics struct {
	TrackID string `json:"trackId"`
	// Source is displayed as attribution and is required by the providers'
	// terms, so it is not optional decoration.
	Source string `json:"source"`
	// Plain is the whole text, newline-separated. Always present.
	Plain string `json:"plain"`
	// Lines carry timings. Empty when the source has none.
	Lines []LyricLine `json:"lines"`
	// Synced is true when Lines can be followed against playback position.
	Synced bool `json:"synced"`
}

// LyricLine is one timed line.
type LyricLine struct {
	AtMs int64  `json:"atMs"`
	Text string `json:"text"`
}

// ---------- podcasts ----------

/*
Podcast is a show, and Episode is one instalment of it.

These were treated as outside the product's scope and skipped by the parser,
on the reasoning that this is a music client. That was wrong about YouTube
Music, which carries podcasts as a first-class kind with its own search filter
and browse pages, so a search for a show returned nothing and the filter chip
for it did not exist.

An Episode is a Track with a publication date and a show: it resolves and plays
through exactly the same path, because upstream it is a video like any other.
That is why Episode embeds Track rather than paralleling it — the playback
engine, the queue and the play log need no knowledge of podcasts at all.
*/
type Podcast struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Author      string     `json:"author,omitempty"`
	AuthorID    string     `json:"authorId,omitempty"`
	Description string     `json:"description,omitempty"`
	Artwork     ArtworkSet `json:"artwork"`
	Episodes    []Episode  `json:"episodes"`
}

// PodcastRef names a show without carrying its episodes.
type PodcastRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type Episode struct {
	Track
	// PublishedText is display text ("3 days ago", "Sep 14"), because that is
	// how it arrives and no absolute date is given alongside it.
	PublishedText string      `json:"publishedText,omitempty"`
	Podcast       *PodcastRef `json:"podcast,omitempty"`
	// Description is the episode's notes, which shows publish alongside each
	// instalment and which have no equivalent for a music track.
	Description string `json:"description,omitempty"`
}
