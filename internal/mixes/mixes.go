// Package mixes generates playlists from the Play log.
//
// The approach is deliberately not "build a recommender". YouTube's
// recommendations are good and we cannot beat them from a single user's
// history. What we can do — and what YouTube does not — is choose the seeds
// from a complete local record of what someone actually listened to, then let
// YouTube's own radio expand each one.
//
// That ordering matters. On Repeat and the period mixes need no
// recommendation machinery at all, only an aggregate over data nobody else
// will show the user, which is why they come first and are the most reliable.
package mixes

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"spotifier/internal/catalog"
	"spotifier/internal/control"
	"spotifier/internal/domain"
)

// Kind tags a generated mix, so the UI can group and label them.
type Kind string

const (
	KindOnRepeat    Kind = "on_repeat"
	KindDaily       Kind = "daily"
	KindDiscover    Kind = "discover"
	KindTimeCapsule Kind = "time_capsule"
)

// Mix is a generated playlist.
type Mix struct {
	ID          string         `json:"id"`
	Kind        Kind           `json:"kind"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Tracks      []domain.Track `json:"tracks"`
	// Seeds names what the mix was built from, so the UI can say why a mix
	// looks the way it does rather than presenting it as an oracle.
	Seeds []string `json:"seeds,omitempty"`
}

// Generator builds mixes from listening history plus YouTube's radio.
type Generator struct {
	store   *control.Store
	catalog catalog.Catalog
}

func New(store *control.Store, cat catalog.Catalog) *Generator {
	return &Generator{store: store, catalog: cat}
}

// minHistoryForSeeding is how many distinct artists must exist before seeded
// mixes are offered.
//
// Below this the "mixes" would be one artist's radio wearing a different hat,
// which is worse than not offering them: it looks broken rather than empty.
const minHistoryForSeeding = 3

// All returns every mix worth showing, cheapest and most reliable first.
//
// A failing seed drops its mix rather than failing the set. A partial shelf is
// far better than an error where music should be.
func (g *Generator) All(ctx context.Context, userID int64) ([]Mix, error) {
	if g.store == nil {
		return nil, fmt.Errorf("mixes: no history store")
	}

	var out []Mix

	// On Repeat: a pure aggregate, no network, never wrong.
	if onRepeat, err := g.OnRepeat(ctx, userID); err == nil && len(onRepeat.Tracks) > 0 {
		out = append(out, onRepeat)
	}

	artists, err := g.store.TopArtists(ctx, userID, control.Last(90*24*time.Hour), 24)
	if err != nil {
		return out, nil
	}
	if len(artists) < minHistoryForSeeding {
		// Not enough history to seed anything meaningful. Returning what we
		// have is honest; inventing mixes from two artists is not.
		return out, nil
	}

	daily, err := g.DailyMixes(ctx, userID, artists, 3)
	if err == nil {
		out = append(out, daily...)
	}
	if discover, err := g.Discover(ctx, userID, artists); err == nil && len(discover.Tracks) > 0 {
		out = append(out, discover)
	}
	return out, nil
}

// OnRepeat is what the listener has played most recently and most often.
func (g *Generator) OnRepeat(ctx context.Context, userID int64) (Mix, error) {
	stats, err := g.store.OnRepeat(ctx, userID, 40)
	if err != nil {
		return Mix{}, err
	}
	return Mix{
		ID:          "on-repeat",
		Kind:        KindOnRepeat,
		Title:       "On Repeat",
		Description: "What you have been playing most over the last 30 days.",
		Tracks:      tracksFromStats(stats),
	}, nil
}

// DailyMixes builds one mix per cluster of the listener's top artists.
//
// Clusters are formed by simple partition rather than by similarity: with a
// single user's history there is not enough signal for a meaningful similarity
// measure, and pretending otherwise produces mixes that look arbitrary while
// claiming not to be. Partitioning by rank at least yields mixes that differ
// from each other in a way the listener can feel.
func (g *Generator) DailyMixes(ctx context.Context, userID int64, artists []control.ArtistStat, count int) ([]Mix, error) {
	if len(artists) < minHistoryForSeeding {
		return nil, nil
	}
	clusters := partition(artists, count)

	var (
		wg  sync.WaitGroup
		mu  sync.Mutex
		out []Mix
	)
	for i, cluster := range clusters {
		if len(cluster) == 0 {
			continue
		}
		wg.Add(1)
		go func(index int, cluster []control.ArtistStat) {
			defer wg.Done()
			tracks, seeds := g.expand(ctx, userID, cluster, 30, false)
			if len(tracks) < 5 {
				// Too thin to present as a mix.
				return
			}
			mu.Lock()
			defer mu.Unlock()
			out = append(out, Mix{
				ID:          fmt.Sprintf("daily-%d", index+1),
				Kind:        KindDaily,
				Title:       fmt.Sprintf("Daily Mix %d", index+1),
				Description: describeSeeds(seeds),
				Tracks:      tracks,
				Seeds:       seeds,
			})
		}(i, cluster)
	}
	wg.Wait()

	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// Discover is radio from familiar artists, with everything already heard
// removed — so the result is genuinely new rather than a greatest-hits replay.
func (g *Generator) Discover(ctx context.Context, userID int64, artists []control.ArtistStat) (Mix, error) {
	seedArtists := artists
	if len(seedArtists) > 8 {
		seedArtists = seedArtists[:8]
	}
	tracks, seeds := g.expand(ctx, userID, seedArtists, 30, true)
	return Mix{
		ID:          "discover",
		Kind:        KindDiscover,
		Title:       "Discover Weekly",
		Description: "Tracks you have not heard, from artists adjacent to what you play.",
		Tracks:      tracks,
		Seeds:       seeds,
	}, nil
}

// expand turns seed artists into tracks via YouTube's radio.
//
// excludeHeard drops anything already in the Play log, which is what separates
// a discovery mix from a familiarity mix.
func (g *Generator) expand(
	ctx context.Context,
	userID int64,
	artists []control.ArtistStat,
	limit int,
	excludeHeard bool,
) ([]domain.Track, []string) {
	heard := map[string]bool{}
	if excludeHeard {
		if known, err := g.store.TopTracks(ctx, userID, control.Last(3650*24*time.Hour), 2000); err == nil {
			for _, t := range known {
				heard[t.TrackID] = true
			}
		}
	}

	// One seed track per artist, resolved concurrently — a mix is several
	// independent radio calls and running them in series is needlessly slow.
	type result struct {
		artist string
		tracks []domain.Track
	}
	results := make([]result, len(artists))
	var wg sync.WaitGroup

	for i, a := range artists {
		seed, err := g.seedTrackFor(ctx, userID, a)
		if err != nil || seed == "" {
			continue
		}
		wg.Add(1)
		go func(index int, artist, seedID string) {
			defer wg.Done()
			tracks, err := g.catalog.Radio(ctx, seedID)
			if err != nil {
				return
			}
			results[index] = result{artist: artist, tracks: tracks}
		}(i, a.Artist, seed)
	}
	wg.Wait()

	// Interleave so no single artist dominates the opening of the mix.
	var (
		out   []domain.Track
		seen  = map[string]bool{}
		seeds []string
	)
	for _, r := range results {
		if r.artist != "" {
			seeds = append(seeds, r.artist)
		}
	}
	for round := 0; len(out) < limit; round++ {
		progressed := false
		for _, r := range results {
			if round >= len(r.tracks) {
				continue
			}
			progressed = true
			t := r.tracks[round]
			if t.ID == "" || seen[t.ID] || (excludeHeard && heard[t.ID]) {
				continue
			}
			seen[t.ID] = true
			out = append(out, t)
			if len(out) >= limit {
				break
			}
		}
		if !progressed {
			break
		}
	}
	return out, seeds
}

// seedTrackFor picks a track by this artist that the listener actually played,
// so the radio starts somewhere meaningful rather than from the artist's most
// popular song.
func (g *Generator) seedTrackFor(ctx context.Context, userID int64, a control.ArtistStat) (string, error) {
	tracks, err := g.store.TopTracks(ctx, userID, control.Last(365*24*time.Hour), 200)
	if err != nil {
		return "", err
	}
	for _, t := range tracks {
		if t.ArtistID == a.ArtistID || strings.EqualFold(t.Artist, a.Artist) {
			return t.TrackID, nil
		}
	}
	return "", nil
}

// partition splits ranked artists round-robin, so each cluster gets a mix of
// heavily and lightly played artists rather than one cluster of favourites and
// one of stragglers.
func partition(artists []control.ArtistStat, groups int) [][]control.ArtistStat {
	if groups < 1 {
		groups = 1
	}
	out := make([][]control.ArtistStat, groups)
	for i, a := range artists {
		g := i % groups
		out[g] = append(out[g], a)
	}
	return out
}

func describeSeeds(seeds []string) string {
	switch len(seeds) {
	case 0:
		return "Built from your listening."
	case 1:
		return seeds[0] + " and similar artists."
	case 2:
		return seeds[0] + ", " + seeds[1] + " and similar artists."
	default:
		return strings.Join(seeds[:3], ", ") + " and more."
	}
}

// statArtwork is a logged track's cover. Plays logged before covers were kept
// fall back to YouTube's own thumbnail for the video, which every track has,
// rather than leaving On Repeat a tile of empty squares.
func statArtwork(s control.TrackStat) domain.ArtworkSet {
	if s.Artwork != "" {
		return domain.ArtworkSet{{URL: s.Artwork, Width: 226, Height: 226}}
	}
	// hq720 is the video frame without the letterbox bars hqdefault adds,
	// so its centre square is the cover itself.
	return domain.ArtworkSet{{URL: "https://i.ytimg.com/vi/" + s.TrackID + "/hq720.jpg", Width: 1280, Height: 720}}
}

func tracksFromStats(stats []control.TrackStat) []domain.Track {
	out := make([]domain.Track, 0, len(stats))
	for _, s := range stats {
		out = append(out, domain.Track{
			ID:       s.TrackID,
			Title:    s.Title,
			Artists:  []domain.ArtistRef{{ID: s.ArtistID, Name: s.Artist}},
			Artwork:  statArtwork(s),
			Playable: true,
		})
	}
	return out
}
