package api

import (
	"encoding/json"
	"net/http"

	"spotifier/internal/identity"
)

/*
Playlist editing.

The four operations behind these routes were implemented against InnerTube and
then left unreachable: no route exposed them and no control called them, so the
product could not do something it already knew how to do. They are the largest
gap in the feature audit for that reason.

Every one of them needs the Identity plane, which runs only on the device — editing someone's library is exactly the kind of thing that
must not be possible from a hosted deployment.
*/

// handleCreatePlaylist makes a playlist and returns its identifier.
func (s *Server) handleCreatePlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	var body struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		Public      bool   `json:"public"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if body.Title == "" {
		s.write(w, http.StatusBadRequest, apiError{Error: "a playlist needs a name"})
		return
	}

	newID, err := id.CreatePlaylist(r.Context(), body.Title, body.Description, body.Public)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, map[string]string{"id": newID})
}

// handleDeletePlaylist removes a playlist the user owns.
func (s *Server) handleDeletePlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	if err := id.DeletePlaylist(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAddToPlaylist appends tracks.
func (s *Server) handleAddToPlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	var body struct {
		TrackIDs []string `json:"trackIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if len(body.TrackIDs) == 0 {
		s.write(w, http.StatusBadRequest, apiError{Error: "no tracks given"})
		return
	}
	if err := id.AddToPlaylist(r.Context(), r.PathValue("id"), body.TrackIDs); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

/*
handleRemoveFromPlaylist removes tracks by their membership handle.

A track identifier is not enough: the same track can appear in a playlist more
than once, and removing "the one with this id" would be ambiguous. The handle
travels with the track when the playlist is read.
*/
func (s *Server) handleRemoveFromPlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	var body struct {
		Items []struct {
			TrackID string `json:"trackId"`
			ItemID  string `json:"itemId"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if len(body.Items) == 0 {
		s.write(w, http.StatusBadRequest, apiError{Error: "no items given"})
		return
	}

	refs := make([]identity.PlaylistItemRef, 0, len(body.Items))
	for _, it := range body.Items {
		if it.TrackID == "" || it.ItemID == "" {
			s.write(w, http.StatusBadRequest,
				apiError{Error: "each item needs both a trackId and an itemId"})
			return
		}
		refs = append(refs, identity.PlaylistItemRef{TrackID: it.TrackID, ItemID: it.ItemID})
	}

	if err := id.RemoveFromPlaylist(r.Context(), r.PathValue("id"), refs); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

/*
handleFollow subscribes to or unsubscribes from an artist.

Upstream models this as a channel subscription rather than a library addition,
so it is keyed by the artist's channel identifier — the same value the artist
page is read by.
*/
func (s *Server) handleFollow(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	var body struct {
		Follow bool `json:"follow"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if err := id.Follow(r.Context(), r.PathValue("id"), body.Follow); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
