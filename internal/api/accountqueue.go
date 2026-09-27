package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/identity"
	"spotifier/internal/respcache"
)

/*
The account's search history, and its queue on other devices.

Both are things YouTube Music's own website reads: the history when the search
box is focused and empty, the queue at start-up. Here neither is read until it
is asked for — the history when the search page is open with nothing typed,
the queue when the listener asks to carry on from another device — because
every call counts against a budget the account is already short of. Signed
out, both answer empty without asking YouTube anything.
*/

// The history is kept briefly, and in memory only: it is the account's own
// queries, and a removal or a new search should show soon.
var (
	searchHistoryKey    = cacheKey("me", "search-history")
	policySearchHistory = respcache.Policy{Fresh: 2 * time.Minute, Keep: 10 * time.Minute, Memory: true}
)

func (s *Server) handleSearchHistory(w http.ResponseWriter, r *http.Request) {
	h, ok := s.account().Identity.(identity.SearchHistory)
	if !ok {
		s.write(w, http.StatusOK, []domain.SearchHistoryEntry{})
		return
	}
	s.serveKept(w, r, searchHistoryKey, policySearchHistory, func(ctx context.Context) (produced, error) {
		entries, err := h.SearchHistory(ctx)
		if err != nil {
			return produced{}, err
		}
		if entries == nil {
			entries = []domain.SearchHistoryEntry{}
		}
		return okBody(entries)
	})
}

// handleForgetSearches removes entries from the account's search history,
// by the tokens the history carried.
func (s *Server) handleForgetSearches(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	h, ok := id.(identity.SearchHistory)
	if !ok {
		s.write(w, http.StatusNotImplemented, apiError{Error: "search history is not available"})
		return
	}
	var body struct {
		Tokens []string `json:"tokens"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Tokens) == 0 {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	err := h.ForgetSearches(r.Context(), body.Tokens)
	// Dropped either way: after a failure, what YouTube now holds is unknown.
	s.forget(r.Context(), searchHistoryKey)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// shapeWarned makes an unrecognised remote queue a single log line, not one
// per click; the parser-health counter carries the rest.
var shapeWarned sync.Once

// handleRemoteQueue reads the queue the account has on its other devices.
// Never kept: it is asked for to carry on from where another device is now.
func (s *Server) handleRemoteQueue(w http.ResponseWriter, r *http.Request) {
	empty := domain.RemoteQueue{Tracks: []domain.Track{}}
	rq, ok := s.account().Identity.(identity.RemoteQueuer)
	if !ok {
		s.write(w, http.StatusOK, empty)
		return
	}
	q, recognised, err := rq.RemoteQueue(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !recognised {
		shapeWarned.Do(func() {
			s.deps.Log.Warn("remote queue: answer not recognised; reported empty (see parser health)")
		})
		s.write(w, http.StatusOK, empty)
		return
	}
	if q.Tracks == nil {
		q.Tracks = []domain.Track{}
	}
	s.write(w, http.StatusOK, q)
}
