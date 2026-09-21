package innertube

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWriteCookieFileProducesNetscapeFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cookies.txt")
	creds := &Credentials{Cookie: "SAPISID=abc; LOGIN_INFO=xyz; HSID=q"}

	n, err := WriteCookieFile(creds, path)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("wrote %d cookies, want 3", n)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if !strings.HasPrefix(body, "# Netscape HTTP Cookie File") {
		t.Fatal("missing the header readers key off")
	}
	for _, line := range strings.Split(strings.TrimSpace(body), "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		// Seven tab-separated fields, or the reader silently skips the line.
		if got := len(strings.Split(line, "\t")); got != 7 {
			t.Fatalf("line has %d fields, want 7: %q", got, line)
		}
	}
	if !strings.Contains(body, "\tSAPISID\tabc") {
		t.Fatalf("cookie value not written: %s", body)
	}
}

// The file is a live session in plain text.
//
// On Windows the permission bits Go writes are not the access control that
// applies, so this asserts nothing there and says so rather than passing
// vacuously. What protects the file on Windows is where it is written: a
// per-user temporary directory, which is the caller's responsibility.
func TestCookieFileIsNotWorldReadable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not the access control on Windows")
	}
	path := filepath.Join(t.TempDir(), "cookies.txt")
	if _, err := WriteCookieFile(&Credentials{Cookie: "SAPISID=a"}, path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		t.Fatalf("mode = %v; a session file must not be readable by others", mode)
	}
}

func TestWriteCookieFileRejectsEmptyCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.txt")
	if _, err := WriteCookieFile(nil, path); err == nil {
		t.Fatal("expected an error for nil credentials")
	}
	if _, err := WriteCookieFile(&Credentials{}, path); err == nil {
		t.Fatal("expected an error for a credential with no cookie")
	}
}
