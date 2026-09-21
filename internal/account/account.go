// Package account holds the signed-in state.
//
// Credentials are mutable state, not a startup input. Signing in happens while
// the process is already running, so anything derived from credentials — the
// InnerTube client, the Identity plane, the merged Library — has to be
// replaceable in place. Wiring them once at boot is what made signing in
// appear to do nothing: the file was written and never read again.
//
// Everything derived from a set of credentials is swapped as a unit, so a
// request never sees a client from one session and a library from another.
package account

import (
	"fmt"
	"sync"

	"spotifier/internal/control"
	"spotifier/internal/identity"
	"spotifier/internal/innertube"
	"spotifier/internal/library"
	"spotifier/internal/obs"
)

// State is everything a set of credentials yields. The zero value is the
// signed-out state, in which every field is nil.
type State struct {
	Client   *innertube.Client
	Identity identity.Identity
	Library  library.Library
}

// SignedIn reports whether these credentials authenticate.
func (s State) SignedIn() bool { return s.Identity != nil }

// Store owns the current State and swaps it atomically.
//
// Reads are far more frequent than reloads — every request takes one — so the
// lock is a read-write lock and Current returns a value rather than a pointer
// into shared memory.
type Store struct {
	path string
	rec  *obs.Recorder
	meta library.Metadata

	// static marks a Store built from a fixed State — fixtures and tests —
	// which has no file behind it and must not be reloaded out from under the
	// caller.
	static bool

	mu      sync.RWMutex
	current State
}

// New builds an empty Store. Nothing is read until Reload is called, so a
// missing credentials file is not a startup failure.
//
// meta may be nil: the Control plane supplies the history-backed sorts, and
// the library still lists without them.
func New(path string, rec *obs.Recorder, ctrl *control.Store) *Store {
	s := &Store{path: path, rec: rec}
	// A nil *control.Store in an interface field is not a nil interface, and
	// the library would then call methods on it. Keep the distinction here so
	// callers can pass the pointer they have.
	if ctrl != nil {
		s.meta = ctrl
	}
	return s
}

// Current returns the live state. Safe to call from any goroutine.
func (s *Store) Current() State {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current
}

// SignedIn reports whether the Identity plane is available.
func (s *Store) SignedIn() bool { return s.Current().SignedIn() }

// Reload re-reads the credentials file and rebuilds everything derived from
// it.
//
// The new state is built fully before it is installed, so a failed reload
// leaves the previous session intact rather than signing the user out. That
// matters because the most common reason to reload is a session that already
// looks broken.
func (s *Store) Reload() error {
	if s.static {
		return nil
	}
	creds, err := innertube.LoadCredentials(s.path)
	if err != nil {
		return fmt.Errorf("load credentials: %w", err)
	}

	client := innertube.New(
		innertube.WithCredentials(creds),
		innertube.WithLocale("en", "US"),
	)

	next := State{Client: client}
	if client.Authenticated() {
		id := identity.NewInnerTube(client, s.rec)
		next.Identity = id
		next.Library = library.New(id, s.meta)
	}

	s.mu.Lock()
	s.current = next
	s.mu.Unlock()
	return nil
}

// Clear drops the signed-in state. Used on sign-out, so the routes stop
// serving one account's data before the next sign-in.
func (s *Store) Clear() {
	s.mu.Lock()
	s.current = State{}
	s.mu.Unlock()
}

// Set installs a State directly.
//
// This is the seam the tests and the fixture adapter use: they have an
// Identity to hand and no credentials file to read.
func (s *Store) Set(st State) {
	s.mu.Lock()
	s.current = st
	s.mu.Unlock()
}

// Static returns a Store fixed at the given State. Reload is a no-op on it,
// because there is no credentials file behind it — the fixture adapter and the
// tests supply an Identity directly.
func Static(st State) *Store {
	s := &Store{static: true}
	s.current = st
	return s
}
