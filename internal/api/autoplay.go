package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"spotifier/internal/domain"
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
	key   string
	seed  string
	token string
	// exhausted is set when a radio has no more pages.
	exhausted bool
	busy      bool
	// failedAt holds off retrying a fetch that just failed.
	failedAt time.Time
}

func newAutoplay() *autoplay { return &autoplay{enabled: true} }

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
	s.autoplay.mu.Unlock()
}

// RunAutoplay keeps the session's queue topped up until ctx ends.
func (s *Server) RunAutoplay(ctx context.Context) {
	if s.deps.Session == nil || s.deps.Catalog == nil {
		return
	}
	updates, cancel := s.deps.Session.Subscribe()
	defer cancel()
	s.topUp(ctx, s.deps.Session.Projection())
	for {
		select {
		case <-ctx.Done():
			return
		case p, ok := <-updates:
			if !ok {
				return
			}
			s.topUp(ctx, p)
		}
	}
}

// topUp fetches more of the queue's radio when it is running low.
//
// Not while repeat is on: repeating means the queue loops as it is. Radio
// appended to a repeating playlist played before it came round again, and
// shuffle then mixed those strangers through the rest of it (#26, #28).
func (s *Server) topUp(ctx context.Context, p session.Projection) {
	q := p.State.Queue
	if p.FollowingRoom || p.State.Repeat != domain.RepeatOff || len(q.Items) == 0 || len(q.Items)-1-q.Index >= autoplayLow {
		return
	}
	a := s.autoplay
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.enabled || a.busy || time.Since(a.failedAt) < 30*time.Second {
		return
	}
	if key := queueKey(q); key != a.key {
		// A queue autoplay has not seen: continue it from its last track.
		a.key, a.seed, a.token, a.exhausted = key, q.Items[len(q.Items)-1].ID, "", false
	}
	if a.exhausted {
		// The radio ran dry: start another from where the queue now ends.
		a.seed, a.token, a.exhausted = q.Items[len(q.Items)-1].ID, "", false
	}
	a.busy = true
	go s.extendRadio(ctx, a.key, a.seed, a.token)
}

// extendRadio fetches a page of radio and appends what is new to the queue.
func (s *Server) extendRadio(ctx context.Context, key, seed, token string) {
	a := s.autoplay
	fctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	tracks, next, err := s.deps.Catalog.RadioPage(fctx, seed, token)

	a.mu.Lock()
	defer a.mu.Unlock()
	a.busy = false
	if err != nil {
		a.failedAt = time.Now()
		s.deps.Log.Debug("autoplay: radio fetch failed", "seed", seed, "err", err)
		return
	}

	q := s.deps.Session.Projection().State.Queue
	if queueKey(q) != key {
		return // the listener started something else meanwhile
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
		if !a.exhausted {
			// A page of repeats: the next one is fetched on the next update.
			return
		}
		a.failedAt = time.Now()
		return
	}
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
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Track.ID == "" {
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
	a.key, a.seed, a.token, a.exhausted, a.failedAt = queueKey(q), body.Track.ID, "", false, time.Time{}
	if !a.busy {
		a.busy = true
		go s.extendRadio(context.WithoutCancel(r.Context()), a.key, a.seed, "")
	}
	a.mu.Unlock()

	s.write(w, http.StatusOK, map[string]any{
		"rejected":   string(reject),
		"projection": s.deps.Session.Projection(),
	})
}
