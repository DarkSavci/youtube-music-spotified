package lyrics

import (
	"context"
	"fmt"

	"spotifier/internal/domain"
	"spotifier/internal/innertube"
	"spotifier/internal/obs"
	"spotifier/internal/renderers"
)

/*
YouTube Music lyrics.

Two calls, not one: `next` for the track returns a tabbed response whose lyrics
tab carries an MPLY… identifier, and that identifier is what `browse` reads.
There is no endpoint that goes straight from a video id to words.

The result is never timed. That is a property of the source, not a limitation
here, and it is why Service has a second provider at all.
*/
type InnerTube struct {
	client *innertube.Client
	rec    *obs.Recorder
}

func NewInnerTube(c *innertube.Client, rec *obs.Recorder) *InnerTube {
	return &InnerTube{client: c, rec: rec}
}

var _ Provider = (*InnerTube)(nil)

func (i *InnerTube) Name() string { return "YouTube Music" }

func (i *InnerTube) Lyrics(ctx context.Context, track domain.Track) (domain.Lyrics, error) {
	if track.ID == "" {
		return domain.Lyrics{}, ErrNotFound
	}

	raw, err := i.client.Call(ctx, "next", map[string]any{"videoId": track.ID})
	if err != nil {
		return domain.Lyrics{}, fmt.Errorf("lyrics: next: %w", err)
	}
	doc, err := renderers.Parse(raw)
	if err != nil {
		return domain.Lyrics{}, fmt.Errorf("lyrics: decode next: %w", err)
	}
	_, lyricsID := renderers.ParseWatchQueue(doc)
	if lyricsID == "" {
		// A track with no lyrics tab simply has none here.
		return domain.Lyrics{}, ErrNotFound
	}

	/*
	 * Ask as a mobile client first.
	 *
	 * YouTube returns timed lyrics only to its mobile clients; the web client
	 * is given the same words with no timings at all. That difference is why
	 * timed lyrics looked unavailable from YouTube and were fetched from a
	 * third party instead — which has nothing for most of the catalogue
	 * outside English.
	 *
	 * The timed payload is large, so it is requested only when lyrics are
	 * actually being shown, which is the only time this runs.
	 */
	if timedRaw, terr := i.client.CallAs(ctx, "browse",
		map[string]any{"browseId": lyricsID}, &innertube.MobileMusic); terr == nil {
		if timedDoc, derr := renderers.Parse(timedRaw); derr == nil {
			if lines, src := renderers.ParseTimedLyrics(timedDoc); len(lines) > 0 {
				if src == "" {
					src = "YouTube Music"
				}
				return domain.Lyrics{Source: src, Lines: lines}, nil
			}
		}
	}

	raw, err = i.client.Call(ctx, "browse", map[string]any{"browseId": lyricsID})
	if err != nil {
		return domain.Lyrics{}, fmt.Errorf("lyrics: browse: %w", err)
	}
	doc, err = renderers.Parse(raw)
	if err != nil {
		return domain.Lyrics{}, fmt.Errorf("lyrics: decode browse: %w", err)
	}

	text, source := renderers.ParseLyrics(doc)
	if text == "" {
		return domain.Lyrics{}, ErrNotFound
	}
	if source == "" {
		source = "YouTube Music"
	}
	return domain.Lyrics{Plain: text, Source: source}, nil
}
