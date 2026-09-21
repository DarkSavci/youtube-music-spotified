package api

import "spotifier/internal/domain"

/*
Empty lists, never null.

Go marshals a nil slice as JSON null, and the client maps over these fields
directly. One null `shelves` took the whole page down with "Cannot read
properties of null (reading 'map')" — and because it unmounted the tree, the
visible symptoms were an empty sidebar, missing filter chips and a settings
page that would not open. Nothing pointed at the endpoint that actually
produced it.

Guarding each `.map` on the client would work too, but there are dozens of
them and one missed guard brings the window down again. The boundary is the
place to be certain: every list this package writes is a list.
*/

// art is on every entity and is indexed by the client when picking a size.
func art(a domain.ArtworkSet) domain.ArtworkSet {
	if a == nil {
		return domain.ArtworkSet{}
	}
	return a
}

func nonNilTracks(t []domain.Track) []domain.Track {
	if t == nil {
		return []domain.Track{}
	}
	for i := range t {
		t[i].Artwork = art(t[i].Artwork)
		t[i].Artists = nonNilArtistRefs(t[i].Artists)
	}
	return t
}

func nonNilAlbums(a []domain.Album) []domain.Album {
	if a == nil {
		return []domain.Album{}
	}
	for i := range a {
		a[i].Tracks = nonNilTracks(a[i].Tracks)
		a[i].Artists = nonNilArtistRefs(a[i].Artists)
		a[i].Artwork = art(a[i].Artwork)
	}
	return a
}

func nonNilArtistRefs(a []domain.ArtistRef) []domain.ArtistRef {
	if a == nil {
		return []domain.ArtistRef{}
	}
	return a
}

func nonNilShelves(s []domain.Shelf) []domain.Shelf {
	if s == nil {
		return []domain.Shelf{}
	}
	for i := range s {
		if s[i].Items == nil {
			s[i].Items = []domain.ShelfItem{}
		}
		for j := range s[i].Items {
			it := &s[i].Items[j]
			if it.Track != nil {
				it.Track.Artwork = art(it.Track.Artwork)
				it.Track.Artists = nonNilArtistRefs(it.Track.Artists)
			}
			if it.Album != nil {
				it.Album.Artwork = art(it.Album.Artwork)
				it.Album.Artists = nonNilArtistRefs(it.Album.Artists)
			}
			if it.Artist != nil {
				it.Artist.Artwork = art(it.Artist.Artwork)
			}
			if it.Playlist != nil {
				it.Playlist.Artwork = art(it.Playlist.Artwork)
			}
			if it.Podcast != nil {
				it.Podcast.Artwork = art(it.Podcast.Artwork)
				if it.Podcast.Episodes == nil {
					it.Podcast.Episodes = []domain.Episode{}
				}
			}
			if it.Episode != nil {
				it.Episode.Artwork = art(it.Episode.Artwork)
				it.Episode.Artists = nonNilArtistRefs(it.Episode.Artists)
			}
		}
	}
	return s
}

func normalizeBrowsePage(p domain.BrowsePage) domain.BrowsePage {
	p.Shelves = nonNilShelves(p.Shelves)
	if p.Moods == nil {
		p.Moods = []domain.MoodChip{}
	}
	return p
}

func normalizeSearch(r domain.SearchResults) domain.SearchResults {
	r.Shelves = nonNilShelves(r.Shelves)
	return r
}

func normalizeAlbum(a domain.Album) domain.Album {
	a.Tracks = nonNilTracks(a.Tracks)
	a.Artists = nonNilArtistRefs(a.Artists)
	a.Artwork = art(a.Artwork)
	return a
}

func normalizePlaylist(p domain.Playlist) domain.Playlist {
	p.Tracks = nonNilTracks(p.Tracks)
	p.Artwork = art(p.Artwork)
	return p
}

func normalizeArtist(a domain.Artist) domain.Artist {
	a.TopTracks = nonNilTracks(a.TopTracks)
	a.Albums = nonNilAlbums(a.Albums)
	a.Singles = nonNilAlbums(a.Singles)
	if a.Related == nil {
		a.Related = []domain.Artist{}
	}
	for i := range a.Related {
		a.Related[i].Artwork = art(a.Related[i].Artwork)
	}
	a.Artwork = art(a.Artwork)
	return a
}

func normalizePodcast(p domain.Podcast) domain.Podcast {
	p.Artwork = art(p.Artwork)
	if p.Episodes == nil {
		p.Episodes = []domain.Episode{}
	}
	for i := range p.Episodes {
		p.Episodes[i].Artwork = art(p.Episodes[i].Artwork)
		p.Episodes[i].Artists = nonNilArtistRefs(p.Episodes[i].Artists)
	}
	return p
}
