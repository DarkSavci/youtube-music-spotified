package account_test

import (
	"os"
	"path/filepath"
	"testing"

	"spotifier/internal/account"
	"spotifier/internal/obs"
)

// A cookie shaped like a real signed-in one: a SAPISID to sign requests with
// and a LOGIN_INFO to mark the account. Either alone does not authenticate.
const signedInCookie = `{"cookie":"SAPISID=abc123; LOGIN_INFO=xyz; HSID=q"}`

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The bug this module exists for: credentials written after startup were never
// read, so signing in appeared to do nothing until the core restarted.
func TestReloadPicksUpCredentialsWrittenAfterStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	s := account.New(path, obs.NewRecorder(), nil)

	if err := s.Reload(); err == nil {
		t.Fatal("expected a reload with no file to fail")
	}
	if s.SignedIn() {
		t.Fatal("signed in with no credentials file")
	}

	write(t, path, signedInCookie)

	if err := s.Reload(); err != nil {
		t.Fatalf("reload after sign-in: %v", err)
	}
	if !s.SignedIn() {
		t.Fatal("still signed out after credentials appeared")
	}
	st := s.Current()
	if st.Identity == nil || st.Library == nil || st.Client == nil {
		t.Fatalf("incomplete state: %+v", st)
	}
}

// A reload is most often triggered by a session that already looks broken, so
// failing it must not sign the user out of a session that still works.
func TestFailedReloadKeepsPreviousSession(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	write(t, path, signedInCookie)

	s := account.New(path, obs.NewRecorder(), nil)
	if err := s.Reload(); err != nil {
		t.Fatal(err)
	}
	before := s.Current()

	write(t, path, "{ not json")
	if err := s.Reload(); err == nil {
		t.Fatal("expected a malformed file to fail the reload")
	}

	if !s.SignedIn() {
		t.Fatal("a failed reload signed the user out")
	}
	if s.Current().Identity != before.Identity {
		t.Fatal("a failed reload replaced the live session")
	}
}

// Signing out must stop serving the previous account's data immediately,
// without waiting for a restart.
func TestClearSignsOut(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	write(t, path, signedInCookie)

	s := account.New(path, obs.NewRecorder(), nil)
	if err := s.Reload(); err != nil {
		t.Fatal(err)
	}
	s.Clear()

	if s.SignedIn() {
		t.Fatal("still signed in after Clear")
	}
	if s.Current().Identity != nil {
		t.Fatal("Identity survived Clear")
	}
}

// Credentials that parse but do not authenticate are a real state: a cookie
// with no LOGIN_INFO. The catalog client is still built, so browsing works.
func TestPartialCredentialsBrowseButDoNotAuthenticate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	write(t, path, `{"cookie":"VISITOR_INFO1_LIVE=abc"}`)

	s := account.New(path, obs.NewRecorder(), nil)
	if err := s.Reload(); err != nil {
		t.Fatalf("a cookie without an account is not a load failure: %v", err)
	}
	st := s.Current()
	if st.Client == nil {
		t.Fatal("no client built; browsing would be unavailable")
	}
	if st.Identity != nil {
		t.Fatal("authenticated on a cookie with no account")
	}
}

// A fixture-backed store has no file behind it and must not be reloaded out
// from under the caller.
func TestStaticStoreIgnoresReload(t *testing.T) {
	s := account.Static(account.State{})
	if err := s.Reload(); err != nil {
		t.Fatalf("reload on a static store should be a no-op: %v", err)
	}
}
