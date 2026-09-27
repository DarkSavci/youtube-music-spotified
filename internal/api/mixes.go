package api

import (
	"context"
	"encoding/json"
	"net/http"

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
	// meanwhile.
	out := []mixes.Mix{}
	if onRepeat, err := s.deps.Mixes.OnRepeat(r.Context(), control.DefaultUserID); err == nil && len(onRepeat.Tracks) > 0 {
		out = append(out, onRepeat)
	}
	e, res, err := s.deps.Responses.Get(r.Context(), cacheKey("me", "mixes"), policyMixes,
		func(ctx context.Context) (respcache.Entry, error) {
			seeded, err := s.deps.Mixes.Seeded(ctx, control.DefaultUserID)
			if err != nil {
				return respcache.Entry{}, err
			}
			if seeded == nil {
				seeded = []mixes.Mix{}
			}
			body, err := json.Marshal(seeded)
			return respcache.Entry{Status: http.StatusOK, Body: body}, err
		})
	if err == nil {
		var seeded []mixes.Mix
		if json.Unmarshal(e.Body, &seeded) == nil {
			out = append(out, seeded...)
		}
		w.Header().Set("X-Cache", string(res))
	}
	s.write(w, http.StatusOK, out)
}
