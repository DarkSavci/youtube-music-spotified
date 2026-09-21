/*
Package report tells YouTube what was played.

Everything else Spotifier does is read-only against the catalogue: it browses,
resolves and plays, and the account never learns it was here. That is a
deliberate property, and this package is the one place that breaks it — so it
is opt-in, and it is the only thing in the codebase that writes to the user's
YouTube account.

Reporting is what buys cross-device continuity. YouTube's own clients ping a
pair of pre-signed URLs from the player response as they play, and that is
what feeds watch history, recommendations, and picking a track back up on
another device. A client that never pings is invisible to all of it.

The pings are plain authenticated GETs to s.youtube.com, not InnerTube calls.
The URLs arrive already signed — carrying the video, the session and the
length — so this adds only the playback nonce and the position.
*/
package report

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"net/url"
	"strconv"
	"sync"
	"time"
)

// Caller is the InnerTube surface this needs: one player call, and a way to
// fetch a signed URL as the signed-in user.
type Caller interface {
	Call(ctx context.Context, endpoint string, body map[string]any) (json.RawMessage, error)
	GetSigned(ctx context.Context, rawURL string) (int, error)
}

// tracking is the subset of a player response that says where to report.
type tracking struct {
	PlaybackTracking struct {
		VideostatsPlaybackURL  struct{ BaseURL string } `json:"videostatsPlaybackUrl"`
		VideostatsWatchtimeURL struct{ BaseURL string } `json:"videostatsWatchtimeUrl"`
	} `json:"playbackTracking"`
	VideoDetails struct {
		LengthSeconds string `json:"lengthSeconds"`
	} `json:"videoDetails"`
}

/*
Reporter pings YouTube as a track plays.

One per process. It holds the tracking URLs for the track in hand and the
nonce identifying this run of it, both of which change on every track.
*/
type Reporter struct {
	Client Caller
	Log    *slog.Logger

	mu       sync.Mutex
	enabled  bool
	videoID  string
	cpn      string
	playback string
	watch    string
	lengthS  int64
	// lastSentMs stops a position that has not moved from being reported
	// again, which is what happens while paused.
	lastSentMs int64
	started    bool
}

// SetEnabled turns reporting on or off. Off is the default: writing to
// someone's account is not something to do because they installed a player.
func (r *Reporter) SetEnabled(on bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.enabled = on
	if !on {
		r.videoID, r.cpn = "", ""
	}
}

// Enabled reports whether playback is being sent upstream.
func (r *Reporter) Enabled() bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.enabled
}

/*
Track prepares reporting for a track, replacing whatever came before.

Fetching the player response is what yields the signed URLs, so this costs one
call per track. It is cheap next to resolution and happens alongside it.
*/
func (r *Reporter) Track(ctx context.Context, videoID string) error {
	if r == nil || r.Client == nil || videoID == "" || !r.Enabled() {
		return nil
	}
	r.mu.Lock()
	same := r.videoID == videoID
	r.mu.Unlock()
	if same {
		return nil
	}

	raw, err := r.Client.Call(ctx, "player", map[string]any{"videoId": videoID})
	if err != nil {
		return fmt.Errorf("report: player: %w", err)
	}
	var t tracking
	if err := json.Unmarshal(raw, &t); err != nil {
		return fmt.Errorf("report: parse: %w", err)
	}
	playback := t.PlaybackTracking.VideostatsPlaybackURL.BaseURL
	watch := t.PlaybackTracking.VideostatsWatchtimeURL.BaseURL
	if playback == "" || watch == "" {
		// Nothing to report to. Not an error: some items carry no tracking.
		return nil
	}
	length, _ := strconv.ParseInt(t.VideoDetails.LengthSeconds, 10, 64)

	r.mu.Lock()
	r.videoID, r.cpn = videoID, newCPN()
	r.playback, r.watch = playback, watch
	r.lengthS, r.lastSentMs, r.started = length, 0, false
	r.mu.Unlock()
	return nil
}

/*
Progress reports how far into the current track playback has reached.

The first call also sends the "playback" ping, which is what marks the track
as started — watch time without it is not attributed.

Positions that have not advanced are dropped, so a paused player stops
reporting rather than insisting on the same second forever.
*/
func (r *Reporter) Progress(ctx context.Context, videoID string, positionMs int64) {
	if r == nil || r.Client == nil || !r.Enabled() {
		return
	}
	r.mu.Lock()
	if r.videoID != videoID || r.watch == "" {
		r.mu.Unlock()
		return
	}
	if positionMs <= r.lastSentMs {
		r.mu.Unlock()
		return
	}
	first := !r.started
	r.started = true
	r.lastSentMs = positionMs
	cpn, playback, watch, length := r.cpn, r.playback, r.watch, r.lengthS
	r.mu.Unlock()

	if first {
		r.ping(ctx, withParams(playback, cpn, 0, length))
	}
	r.ping(ctx, withParams(watch, cpn, positionMs, length))
}

func (r *Reporter) ping(ctx context.Context, rawURL string) {
	status, err := r.Client.GetSigned(ctx, rawURL)
	if err != nil {
		if r.Log != nil {
			r.Log.Debug("report: ping failed", "err", err)
		}
		return
	}
	// A refusal is worth knowing about — it usually means the session is no
	// longer good — but never worth interrupting playback for.
	if status >= 400 && r.Log != nil {
		r.Log.Debug("report: ping refused", "status", status)
	}
}

/*
withParams adds this playback's identity and position to a signed URL.

cpn identifies one run of one track, so YouTube can tell a replay from a
resume. cmt is where playback has reached; st and et bound the segment being
reported, which for a running player is simply "up to here".
*/
func withParams(base, cpn string, positionMs, lengthS int64) string {
	secs := float64(positionMs) / 1000
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	q.Set("ver", "2")
	q.Set("cpn", cpn)
	q.Set("cmt", trim(secs))
	q.Set("st", "0")
	q.Set("et", trim(secs))
	if lengthS > 0 {
		q.Set("len", strconv.FormatInt(lengthS, 10))
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func trim(f float64) string { return strconv.FormatFloat(f, 'f', 3, 64) }

// cpnAlphabet is the set YouTube's own players draw a nonce from.
const cpnAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// newCPN makes a client playback nonce: sixteen characters identifying one
// run of one track.
func newCPN() string {
	b := make([]byte, 16)
	for i := range b {
		b[i] = cpnAlphabet[rand.Intn(len(cpnAlphabet))]
	}
	return string(b)
}

// Interval is how often a player should report while playing. YouTube's own
// clients flush on roughly this cadence.
const Interval = 30 * time.Second
