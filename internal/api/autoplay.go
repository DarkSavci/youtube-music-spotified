package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/innertube"
	"spotifier/internal/session"
)

/*
Autoplay: the queue never runs out, the way YouTube Music's Up next doesn't.

Starting a song from a search result or a Home shelf starts its radio —
YouTube's own "next" queue for that song, the one its app plays — rather
than queueing the other results around it. As the queue runs low, the next
page of that radio is fetched with the continuation token YouTube hands
back, so listening carries on indefinitely. A queue that is not a radio (an
album, a playlist) carries on the same way once it ends, from a radio of its
last track.
*/

// autoplayLow is how few tracks may remain after the current one before more
// are fetched.
const autoplayLow = 5

type autoplay struct {
	mu      sync.Mutex
	enabled bool
	// key identifies the queue the radio state belongs to, so a new queue
	// the listener starts does not continue the previous one's radio.
	key  string
	seed string
	// mix names the generated queue the radio pages come from when it is not
	// the seed's own radio: an artist's mix or shuffle. Zero for a song's
	// radio.
	mix   domain.MixSeed
	token string
	// exhausted is set when a radio has no more pages.
	exhausted bool
	busy      bool
	// failedAt holds off retrying a fetch that just failed, for failDelay,
	// which doubles with each failure in a row.
	failedAt  time.Time
	failDelay time.Duration

	// fetchedAt is when the last page was asked for. Pages are at least gap
	// apart: a radio whose pages kept repeating what the queue already had
	// used to be paged through back to back, several calls a second, until
	// something new turned up.
	fetchedAt time.Time
	gap       time.Duration
	// dry counts pages in a row that added nothing. After maxDry autoplay
	// stops for this queue until it changes.
	dry    int
	gaveUp bool
	// index and length are the queue position last looked at. Position
	// reports arrive several times a second and change neither, so they no
	// longer cause a look at all.
	index, length int
	seen          string
	// retry is the pending re-check after a wait (pacing or a failure).
	retry *time.Timer
}

const (
	autoplayGap     = 8 * time.Second
	autoplayMaxDry  = 3
	autoplayFailMin = 30 * time.Second
	autoplayFailMax = 10 * time.Minute
)

func newAutoplay() *autoplay {
	return &autoplay{enabled: true, gap: autoplayGap, failDelay: autoplayFailMin, index: -1, length: -1}
}

// queueKey identifies a queue by where it came from and how it starts. A
// radio appending to it changes neither.
func queueKey(q domain.Queue) string {
	if len(q.Items) == 0 {
		return ""
	}
	return q.Origin + "\x00" + q.Items[0].ID
}

// SetAutoplay switches autoplay on or off.
func (s *Server) SetAutoplay(on bool) {
	s.autoplay.mu.Lock()
	s.autoplay.enabled = on
	// Look again at the next update even if the queue has not moved.
	s.autoplay.seen = ""
	s.autoplay.mu.Unlock()
}

// RunAutoplay keeps the session's queue topped up until ctx ends.
func (s *Server) RunAutoplay(ctx context.Context) {
	if s.deps.Session == nil || s.deps.Catalog == nil {
		return
	}
	updates, cancel := s.deps.Session.Subscribe()
	defer cancel()
	ctx = innertube.WithRoute(ctx, "autoplay")
	s.topUp(ctx, s.deps.Session.Projection(), true)
	for {
		select {
		case <-ctx.Done():
			return
		case p, ok := <-updates:
			if !ok {
				return
			}
			s.topUp(ctx, p, false)
		}
	}
}

// topUp fetches more of the queue's radio when it is running low.
//
// Not while repeat is on: repeating means the queue loops as it is. Radio
// appended to a repeating playlist played before it came round again, and
// shuffle then mixed those strangers through the rest of it (#26, #28).
//
// force re-checks a queue whose position has not moved: the first look, a
// setting that changed, and the re-check scheduled after a wait.
func (s *Server) topUp(ctx context.Context, p session.Projection, force bool) {
	q := p.State.Queue
	a := s.autoplay
	a.mu.Lock()
	defer a.mu.Unlock()
	key := queueKey(q)
	// Settings that decide whether autoplay applies count as changes too.
	seen := fmt.Sprintf("%s\x00%s\x00%t", key, p.State.Repeat, p.FollowingRoom)
	moved := q.Index != a.index || len(q.Items) != a.length || seen != a.seen
	a.index, a.length, a.seen = q.Index, len(q.Items), seen
	if moved {
		// Something changed: whatever autoplay gave up on, it may be worth
		// another look now.
		a.gaveUp = false
	} else if !force {
		return
	}
	if p.FollowingRoom || p.State.Repeat != domain.RepeatOff || len(q.Items) == 0 || len(q.Items)-1-q.Index >= autoplayLow {
		return
	}
	if !a.enabled || a.busy || a.gaveUp {
		return
	}
	now := time.Now()
	wait := a.failDelay - now.Sub(a.failedAt)
	if w := a.gap - now.Sub(a.fetchedAt); w > wait {
		wait = w
	}
	if wait > 0 {
		s.recheckAutoplay(ctx, wait)
		return
	}
	if key != a.key {
		// A queue autoplay has not seen: continue it from its last track.
		a.key, a.seed, a.mix, a.token, a.exhausted = key, q.Items[len(q.Items)-1].ID, domain.MixSeed{}, "", false
		a.dry = 0
	}
	if a.exhausted {
		// The radio ran dry: start another from where the queue now ends.
		a.seed, a.mix, a.token, a.exhausted = q.Items[len(q.Items)-1].ID, domain.MixSeed{}, "", false
	}
	a.busy = true
	a.fetchedAt = now
	go s.extendRadio(ctx, a.key, a.seed, a.mix, a.token)
}

// recheckAutoplay looks at the queue again after d, once. Called with a.mu
// held.
func (s *Server) recheckAutoplay(ctx context.Context, d time.Duration) {
	a := s.autoplay
	if a.retry != nil {
		return
	}
	a.retry = time.AfterFunc(d, func() {
		a.mu.Lock()
		a.retry = nil
		a.mu.Unlock()
		if ctx.Err() == nil {
			s.topUp(ctx, s.deps.Session.Projection(), true)
		}
	})
}

// radioPage reads one page of either kind of radio.
func (s *Server) radioPage(ctx context.Context, seed string, mix domain.MixSeed, token string) ([]domain.Track, string, error) {
	if mix.PlaylistID != "" {
		return s.deps.Catalog.MixPage(ctx, mix, token)
	}
	return s.deps.Catalog.RadioPage(ctx, seed, token)
}

// extendRadio fetches a page of radio and appends what is new to the queue.
func (s *Server) extendRadio(ctx context.Context, key, seed string, mix domain.MixSeed, token string) {
	a := s.autoplay
	fctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	tracks, next, err := s.radioPage(fctx, seed, mix, token)

	a.mu.Lock()
	defer a.mu.Unlock()
	a.busy = false
	if err != nil {
		if !a.failedAt.IsZero() && time.Since(a.failedAt) < 2*a.failDelay+a.gap {
			// Failing again straight after the last failure: wait longer.
			a.failDelay = min(a.failDelay*2, autoplayFailMax)
		}
		a.failedAt = time.Now()
		s.deps.Log.Debug("autoplay: radio fetch failed", "seed", seed, "err", err, "retryIn", a.failDelay)
		s.recheckAutoplay(ctx, a.failDelay)
		return
	}
	a.failDelay = autoplayFailMin
	a.failedAt = time.Time{}

	q := s.deps.Session.Projection().State.Queue
	if queueKey(q) != key {
		// The listener started something else meanwhile. Its updates arrived
		// while this fetch was busy and were turned away, so look at it now
		// rather than waiting for it to move.
		s.recheckAutoplay(ctx, 0)
		return
	}
	have := make(map[string]bool, len(q.Items))
	for _, t := range q.Items {
		have[t.ID] = true
	}
	var fresh []domain.Track
	for _, t := range tracks {
		if t.ID != "" && t.Playable && !have[t.ID] {
			have[t.ID] = true
			fresh = append(fresh, t)
		}
	}
	a.token = next
	a.exhausted = next == ""
	if len(fresh) == 0 {
		a.dry++
		if a.dry >= autoplayMaxDry {
			// Page after page of what the queue already has: stop asking
			// until the queue changes, rather than paging through the lot.
			a.gaveUp = true
			s.deps.Log.Info("autoplay: radio has nothing new; stopping", "seed", seed, "pages", a.dry)
			return
		}
		// A page of repeats: the next one comes after the usual gap.
		s.recheckAutoplay(ctx, a.gap)
		return
	}
	a.dry = 0
	_, _ = s.deps.Session.Command(ctx, "autoplay", session.Command{
		Kind:   session.CmdEnqueue,
		Insert: fresh,
		At:     -1,
	})
}

/*
handleStartRadio plays a song and makes its radio the queue.

The song starts at once; the radio arrives a moment later and fills in
behind it. Waiting for the radio before playing would put a network round
trip in front of every click.
*/
func (s *Server) handleStartRadio(w http.ResponseWriter, r *http.Request) {
	if s.deps.Session == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "session unavailable"})
		return
	}
	var body struct {
		DeviceID string       `json:"deviceId"`
		Track    domain.Track `json:"track"`
		Origin   string       `json:"origin"`
		// PlaylistID and VideoID start a named radio instead of a song's: an
		// artist's mix or shuffle, which the artist page carries as a list
		// and the song it starts from.
		PlaylistID string `json:"playlistId"`
		VideoID    string `json:"videoId"`
		Params     string `json:"params"`
		// MinTracks refuses a named radio shorter than this without playing
		// it, so the caller can play something fuller instead: a small
		// artist's shuffle can be three songs long.
		MinTracks int `json:"minTracks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if body.PlaylistID != "" && body.VideoID != "" {
		s.startMix(w, r, body.DeviceID, domain.MixSeed{VideoID: body.VideoID, PlaylistID: body.PlaylistID, Params: body.Params}, body.Origin, body.MinTracks)
		return
	}
	if body.Track.ID == "" {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	origin := body.Origin
	if origin == "" {
		origin = body.Track.Title + " radio"
	}
	reject, err := s.deps.Session.Command(r.Context(), body.DeviceID, session.Command{
		Kind: session.CmdPlay, Tracks: []domain.Track{body.Track}, StartIndex: 0, Origin: origin,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// The radio belongs to this new queue, seeded by the song itself.
	q := s.deps.Session.Projection().State.Queue
	a := s.autoplay
	a.mu.Lock()
	a.key, a.seed, a.mix, a.token, a.exhausted, a.failedAt = queueKey(q), body.Track.ID, domain.MixSeed{}, "", false, time.Time{}
	if !a.busy {
		a.busy = true
		go s.extendRadio(context.WithoutCancel(r.Context()), a.key, a.seed, domain.MixSeed{}, "")
	}
	a.mu.Unlock()

	s.write(w, http.StatusOK, map[string]any{
		"rejected":   string(reject),
		"projection": s.deps.Session.Projection(),
	})
}

/*
startMix plays one of YouTube's named radios: an artist's mix, which is the
artist and music like theirs, or its shuffle.

Unlike a song's radio there is no song in hand to start at once: the list
names its first song only by id. So the first page is fetched before playing,
and later pages continue it the way a song's radio continues.
*/
func (s *Server) startMix(w http.ResponseWriter, r *http.Request, deviceID string, mix domain.MixSeed, origin string, minTracks int) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	tracks, next, err := s.deps.Catalog.MixPage(ctx, mix, "")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var queue []domain.Track
	seen := map[string]bool{}
	for _, t := range tracks {
		if t.ID != "" && t.Playable && !seen[t.ID] {
			seen[t.ID] = true
			queue = append(queue, t)
		}
	}
	if len(queue) == 0 {
		s.write(w, http.StatusBadGateway, apiError{Error: "the radio came back empty"})
		return
	}
	if len(queue) < minTracks {
		s.write(w, http.StatusConflict, map[string]any{"error": "the radio is too short", "short": true, "tracks": len(queue)})
		return
	}
	if origin == "" {
		origin = "Radio"
	}
	reject, err := s.deps.Session.Command(r.Context(), deviceID, session.Command{
		Kind: session.CmdPlay, Tracks: queue, StartIndex: 0, Origin: origin,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}

	q := s.deps.Session.Projection().State.Queue
	a := s.autoplay
	a.mu.Lock()
	a.key, a.seed, a.mix, a.token, a.exhausted, a.failedAt = queueKey(q), mix.VideoID, mix, next, next == "", time.Time{}
	a.mu.Unlock()

	s.write(w, http.StatusOK, map[string]any{
		"rejected":   string(reject),
		"projection": s.deps.Session.Projection(),
	})
}
