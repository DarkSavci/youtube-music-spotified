package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"spotifier/internal/control"
	"spotifier/internal/mixes"
	"spotifier/internal/respcache"
)

// Generated mixes.
//
// Built from the local Play log plus YouTube's own radio: we choose the seeds
// from a complete record of what was actually listened to, and let YouTube
// expand each one. That is the half of the problem we are better placed to
// solve than they are.

func (s *Server) handleMixes(w http.ResponseWriter, r *http.Request) {
	if s.deps.Mixes == nil {
		// No history store means no mixes. An empty list is the honest answer;
		// it renders as "nothing yet" rather than an error.
		s.write(w, http.StatusOK, []mixes.Mix{})
		return
	}
	if s.deps.Responses == nil {
		out, err := s.deps.Mixes.All(r.Context(), control.DefaultUserID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if out == nil {
			out = []mixes.Mix{}
		}
		s.write(w, http.StatusOK, out)
		return
	}

	// On Repeat is read fresh; the radio-built mixes are kept for a day and
	// rebuilt in the background once they are older, the old ones showing
	// meanwhile. A rebuild that fails (a rate limit, most often) keeps the
	// old set: Seeded returns the error instead of a partial or empty one.
	out := []mixes.Mix{}
	if onRepeat, err := s.deps.Mixes.OnRepeat(r.Context(), control.DefaultUserID); err == nil && len(onRepeat.Tracks) > 0 {
		out = append(out, onRepeat)
	}
	key := cacheKey("me", "mixes")
	if _, kept := s.deps.Responses.Peek(r.Context(), key, policyMixes); !kept && s.mixesFailedRecently() {
		// Nothing kept and the last build failed moments ago: asking again
		// now is a dozen radio calls that would fail the same way.
		s.write(w, http.StatusOK, out)
		return
	}
	e, res, err := s.deps.Responses.Get(r.Context(), key, policyMixes,
		func(ctx context.Context) (respcache.Entry, error) {
			seeded, err := s.deps.Mixes.Seeded(ctx, control.DefaultUserID)
			if errors.Is(err, mixes.ErrThinHistory) {
				// Not enough listening yet. An answer, but one that more
				// listening changes soon, so it is kept only briefly.
				return respcache.Entry{Status: http.StatusOK, Body: []byte("[]"),
					FreshUntil: s.deps.Responses.Now().Add(thinHistoryFresh)}, nil
			}
			if err != nil {
				return respcache.Entry{}, err
			}
			body, err := json.Marshal(seeded)
			return respcache.Entry{Status: http.StatusOK, Body: body}, err
		})
	switch {
	case errors.Is(err, context.Canceled):
		// The page went away; the build carries on detached and keeps its
		// result. Nothing failed.
	case err != nil:
		s.noteMixesFailed()
		s.deps.Log.Info("mixes not rebuilt", "err", err)
	default:
		var seeded []mixes.Mix
		if json.Unmarshal(e.Body, &seeded) == nil {
			out = append(out, seeded...)
		}
		w.Header().Set("X-Cache", string(res))
	}
	s.write(w, http.StatusOK, out)
}

// thinHistoryFresh is how long "not enough listening for mixes yet" is kept.
const thinHistoryFresh = 10 * time.Minute

// mixesRetryAfter is how long a failed first build of the mixes waits.
const mixesRetryAfter = 5 * time.Minute

func (s *Server) mixesFailedRecently() bool {
	s.mixesMu.Lock()
	defer s.mixesMu.Unlock()
	return !s.mixesFailedAt.IsZero() && s.deps.Responses.Now().Sub(s.mixesFailedAt) < mixesRetryAfter
}

func (s *Server) noteMixesFailed() {
	s.mixesMu.Lock()
	s.mixesFailedAt = s.deps.Responses.Now()
	s.mixesMu.Unlock()
}
