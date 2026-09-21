package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"spotifier/internal/control"
)

// Statistics surfaces.
//
// These render what only we can: the reader's own listening history, at full
// fidelity, with no product reason to withhold any of it. The artist page uses
// affinity where a global listener count would otherwise go.

func (s *Server) requireControl(w http.ResponseWriter) bool {
	if s.deps.Control == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "statistics unavailable"})
		return false
	}
	return true
}

// periodFrom reads a window from the query string, defaulting to 30 days.
func periodFrom(r *http.Request) control.Period {
	days := 30
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 3650 {
			days = n
		}
	}
	return control.Last(time.Duration(days) * 24 * time.Hour)
}

func limitFrom(r *http.Request, def int) int {
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			return n
		}
	}
	return def
}

// handleRecordPlays accepts listening events from the client.
//
// Events carry a client-generated identifier and the write is idempotent on
// it, so a client that retries after a dropped connection cannot double-count
// a listen — which would quietly corrupt every statistic downstream.
func (s *Server) handleRecordPlays(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	var body struct {
		Plays []control.Play `json:"plays"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if err := s.deps.Control.RecordPlays(r.Context(), control.DefaultUserID, body.Plays); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTopTracks(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	out, err := s.deps.Control.TopTracks(r.Context(), control.DefaultUserID, periodFrom(r), limitFrom(r, 50))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if out == nil {
		out = []control.TrackStat{}
	}
	s.write(w, http.StatusOK, out)
}

func (s *Server) handleTopArtists(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	out, err := s.deps.Control.TopArtists(r.Context(), control.DefaultUserID, periodFrom(r), limitFrom(r, 50))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if out == nil {
		out = []control.ArtistStat{}
	}
	s.write(w, http.StatusOK, out)
}

func (s *Server) handleOnRepeat(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	out, err := s.deps.Control.OnRepeat(r.Context(), control.DefaultUserID, limitFrom(r, 30))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if out == nil {
		out = []control.TrackStat{}
	}
	s.write(w, http.StatusOK, out)
}

// handleAffinity is what the artist page shows in place of monthly listeners.
func (s *Server) handleAffinity(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	out, err := s.deps.Control.Affinity(r.Context(), control.DefaultUserID, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, out)
}
