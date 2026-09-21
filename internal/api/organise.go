package api

import (
	"encoding/json"
	"net/http"

	"spotifier/internal/control"
)

/*
Organising the library: pinning and folders.

Both are Control-plane concepts — nothing upstream has them — and both were
readable and sortable long before anything could set them. The schema, the
reads and the merged sort all existed; only the writes were missing, so the
columns that shape the sidebar could hold nothing but their defaults.
*/

// handleFolders lists the user's folders.
func (s *Server) handleFolders(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	folders, err := s.deps.Control.Folders(r.Context(), control.DefaultUserID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, folders)
}

// handleCreateFolder makes a folder.
func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	id, err := s.deps.Control.CreateFolder(r.Context(), control.DefaultUserID, body.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, map[string]string{"id": id})
}

// handleDeleteFolder removes a folder, returning its items to the top level.
func (s *Server) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	if err := s.deps.Control.DeleteFolder(r.Context(), control.DefaultUserID, r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleOrganise pins an item or moves it into a folder.
func (s *Server) handleOrganise(w http.ResponseWriter, r *http.Request) {
	if !s.requireControl(w) {
		return
	}
	var body struct {
		Kind     string  `json:"kind"`
		ItemID   string  `json:"itemId"`
		Pinned   *bool   `json:"pinned,omitempty"`
		FolderID *string `json:"folderId,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if body.Kind == "" || body.ItemID == "" {
		s.write(w, http.StatusBadRequest, apiError{Error: "kind and itemId are required"})
		return
	}

	// Both fields are optional and independent: pinning an item and filing it
	// are separate decisions that happen to share a row.
	if body.Pinned != nil {
		if err := s.deps.Control.SetPinned(r.Context(), control.DefaultUserID,
			body.Kind, body.ItemID, *body.Pinned); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	if body.FolderID != nil {
		if err := s.deps.Control.SetFolder(r.Context(), control.DefaultUserID,
			body.Kind, body.ItemID, *body.FolderID); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
