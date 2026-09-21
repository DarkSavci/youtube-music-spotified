// Package lyrics fetches a Track's words.
//
// Two sources, because they give different things. YouTube Music returns the
// text it already has for a track, authenticated and attributed, but never
// timed. LRCLIB returns community-contributed lyrics that are often timed,
// which is what makes a lyrics view follow the music instead of being a wall
// of text to scroll.
//
// Timed lyrics are the reason this is a seam rather than one function: the two
// sources disagree about what a result even is, and the choice between them is
// the user's, not the code's (see Service).
package lyrics

import (
	"context"
	"errors"
	"strings"

	"spotifier/internal/domain"
)

// ErrNotFound means no source had words for this Track. It is an ordinary
// outcome — plenty of tracks have no lyrics anywhere — not a failure.
var ErrNotFound = errors.New("lyrics: none found")

// Provider is one source of lyrics.
//
// It takes the whole Track rather than an identifier because the sources key
// on different things: YouTube on the video id, LRCLIB on title, artist and
// duration. Passing the Track keeps that difference inside the adapters.
type Provider interface {
	Name() string
	Lyrics(ctx context.Context, track domain.Track) (domain.Lyrics, error)
}

/*
Service resolves lyrics from the available sources.

Order is deliberate and depends on what the user asked for. When timed lyrics
are wanted, the timed source is tried first, because a plain result from the
other one would satisfy a "first non-empty" rule and the timing — the whole
point — would be silently lost. When they are not wanted, the timed source is
never contacted at all, so nothing about what is playing leaves the machine
beyond what YouTube already knows.
*/
type Service struct {
	// Primary is YouTube Music. It needs no third party and is always used.
	Primary Provider
	// Timed is the optional source that can return timings. Nil, or disabled
	// by the caller, means it is never contacted.
	Timed Provider
}

// Lyrics returns the best available words for a Track.
//
// preferTimed selects the order. It is a parameter rather than a field so the
// setting can change between calls without rebuilding the service.
func (s *Service) Lyrics(ctx context.Context, track domain.Track, preferTimed bool) (domain.Lyrics, error) {
	/*
	 * Prefer a timed result, whichever source has one.
	 *
	 * YouTube returns timed lyrics to a mobile client context, so it can now
	 * satisfy a request for timings itself — and it has the catalogue, where
	 * the third party is thin outside English. But it does not have timings
	 * for everything, and a fixed order either ignores the third party when
	 * YouTube answers with plain words, or contacts it when YouTube already
	 * had timings. Neither is what the listener asked for.
	 *
	 * So: ask YouTube, keep an untimed answer as a fallback, and only reach
	 * for the third party when timings were wanted and are still missing.
	 */
	var fallback domain.Lyrics
	var lastErr error

	ask := func(p Provider) (domain.Lyrics, bool) {
		if p == nil {
			return domain.Lyrics{}, false
		}
		got, err := p.Lyrics(ctx, track)
		if err != nil {
			if !errors.Is(err, ErrNotFound) {
				lastErr = err
			}
			return domain.Lyrics{}, false
		}
		if strings.TrimSpace(got.Plain) == "" && len(got.Lines) == 0 {
			return domain.Lyrics{}, false
		}
		got.TrackID = track.ID
		return normalise(got), true
	}

	if got, ok := ask(s.Primary); ok {
		if got.Synced || !preferTimed {
			return got, nil
		}
		fallback = got
	}

	if preferTimed {
		if got, ok := ask(s.Timed); ok {
			if got.Synced || fallback.Plain == "" {
				return got, nil
			}
		}
	}

	if fallback.Plain != "" || len(fallback.Lines) > 0 {
		return fallback, nil
	}
	if lastErr != nil {
		return domain.Lyrics{}, lastErr
	}
	return domain.Lyrics{}, ErrNotFound
}

// normalise guarantees the invariant every consumer relies on: Plain is
// always populated, even for a timed result, so a view that only knows how to
// print text still works.
func normalise(l domain.Lyrics) domain.Lyrics {
	if l.Lines == nil {
		l.Lines = []domain.LyricLine{}
	}
	l.Synced = len(l.Lines) > 0
	if strings.TrimSpace(l.Plain) == "" && l.Synced {
		parts := make([]string, 0, len(l.Lines))
		for _, line := range l.Lines {
			parts = append(parts, line.Text)
		}
		l.Plain = strings.Join(parts, "\n")
	}
	return l
}
