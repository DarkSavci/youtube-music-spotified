/*
Package loudness reports how loud a Track is, before a note of it plays.

Volume normalisation used to be a leveller: it measured what was coming out of
the speakers and corrected slowly toward a reference, because YouTube was
assumed to publish no per-track figure. It does. Every player response carries
the track's integrated loudness, which is what YouTube's own normalisation
runs on.

That difference is the whole point of this package. A leveller cannot act
before a track starts, so the opening seconds of a loud track are loud; and it
moves slowly on purpose, because reacting quickly to the music pumps. Knowing
the figure in advance makes the correction exact, immediate, and constant for
the whole track — which is what replay gain is.
*/
package loudness

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// ErrUnknown means the player response carried no loudness for this track. It
// is an ordinary outcome: playback continues without a correction.
var ErrUnknown = errors.New("loudness: not published for this track")

// Caller is the InnerTube surface this needs. One endpoint, so the seam stays
// narrow enough to fake in a test without standing up a client.
type Caller interface {
	Call(ctx context.Context, endpoint string, body map[string]any) (json.RawMessage, error)
}

/*
Service reads and remembers each Track's loudness.

Cached without expiry because loudness is a property of the recording: unlike
a stream URL it does not go stale, is not bound to this device, and says
nothing the catalog does not already say.
*/
type Service struct {
	Client Caller

	mu   sync.RWMutex
	seen map[string]float64

	// inflight shares one lookup among everyone asking at once: both decks
	// and the relay can ask for the same track within milliseconds.
	flightMu sync.Mutex
	inflight map[string]*lookup
}

type lookup struct {
	done chan struct{}
	lkfs float64
	err  error
}

// audioConfig is the subset of a player response this reads.
type audioConfig struct {
	PlayerConfig struct {
		AudioConfig struct {
			// TrackAbsoluteLoudnessLkfs is the measured integrated loudness.
			TrackAbsoluteLoudnessLkfs *float64 `json:"trackAbsoluteLoudnessLkfs"`
			// LoudnessDb is the negated gain YouTube would apply to reach its
			// own target, and LoudnessTargetLkfs is that target. Together they
			// give the same figure when the absolute one is absent.
			LoudnessDb         *float64 `json:"loudnessDb"`
			LoudnessTargetLkfs *float64 `json:"loudnessTargetLkfs"`
		} `json:"audioConfig"`
	} `json:"playerConfig"`
}

/*
For returns a Track's integrated loudness in LKFS.

The figure is negative — music sits well below full scale — and a caller turns
it into a gain by subtracting it from the target it wants.
*/
func (s *Service) For(ctx context.Context, videoID string) (float64, error) {
	if s == nil || s.Client == nil || videoID == "" {
		return 0, ErrUnknown
	}

	s.mu.RLock()
	v, ok := s.seen[videoID]
	s.mu.RUnlock()
	if ok {
		return v, nil
	}

	s.flightMu.Lock()
	if l, ok := s.inflight[videoID]; ok {
		s.flightMu.Unlock()
		select {
		case <-l.done:
			return l.lkfs, l.err
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	if s.inflight == nil {
		s.inflight = make(map[string]*lookup)
	}
	l := &lookup{done: make(chan struct{})}
	s.inflight[videoID] = l
	s.flightMu.Unlock()

	// Shared, so not ended by whichever asker happened to come first.
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	l.lkfs, l.err = s.fetch(fctx, videoID)
	cancel()

	s.flightMu.Lock()
	delete(s.inflight, videoID)
	s.flightMu.Unlock()
	close(l.done)
	return l.lkfs, l.err
}

// fetch asks upstream for a track's loudness and remembers the answer.
func (s *Service) fetch(ctx context.Context, videoID string) (float64, error) {
	raw, err := s.Client.Call(ctx, "player", map[string]any{"videoId": videoID})
	if err != nil {
		return 0, err
	}
	var cfg audioConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return 0, err
	}

	lkfs, ok := lkfsFrom(cfg)
	if !ok {
		return 0, ErrUnknown
	}

	s.mu.Lock()
	if s.seen == nil {
		s.seen = make(map[string]float64)
	}
	s.seen[videoID] = lkfs
	s.mu.Unlock()
	return lkfs, nil
}

/*
lkfsFrom picks the loudness out of whichever fields the response carries.

Not every response has the absolute figure, but one that normalises at all
carries the gain and the target it was computed against, and those reconstruct
it exactly: the gain is stored negated, so target plus loudnessDb is the
track's own loudness.
*/
func lkfsFrom(cfg audioConfig) (float64, bool) {
	ac := cfg.PlayerConfig.AudioConfig
	if ac.TrackAbsoluteLoudnessLkfs != nil {
		return *ac.TrackAbsoluteLoudnessLkfs, true
	}
	if ac.LoudnessDb != nil && ac.LoudnessTargetLkfs != nil {
		return *ac.LoudnessTargetLkfs + *ac.LoudnessDb, true
	}
	return 0, false
}

/*
GainDb is the correction that brings a track to a target loudness.

Clamped, because the gain is only as good as the figure behind it and an
outlier would arrive as a jolt: a track reported at -40 LKFS would otherwise
be lifted twenty-six decibels, which is far more likely to be a bad reading
than a genuinely quiet recording.
*/
func GainDb(trackLkfs, targetLkfs float64) float64 {
	const limit = 12
	gain := targetLkfs - trackLkfs
	switch {
	case gain > limit:
		return limit
	case gain < -limit:
		return -limit
	default:
		return gain
	}
}
