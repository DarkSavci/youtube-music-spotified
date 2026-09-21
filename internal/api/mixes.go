package api

import (
	"net/http"

	"spotifier/internal/control"
	"spotifier/internal/mixes"
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
	out, err := s.deps.Mixes.All(r.Context(), control.DefaultUserID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if out == nil {
		out = []mixes.Mix{}
	}
	s.write(w, http.StatusOK, out)
}
