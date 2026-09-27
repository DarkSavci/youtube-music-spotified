package innertube

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDecodeJSString(t *testing.T) {
	cases := []struct{ in, want string }{
		{`plain`, `plain`},
		{`\x7b\x22a\x22:1\x7d`, `{"a":1}`},
		{`\/browse`, `/browse`},
		{`back\\slash`, `back\slash`},
		{`it\'s \"q\"`, `it's "q"`},
		{`\x3d\x26\x3c\x3e`, `=&<>`},
		{`\u00e7ok \u011f`, `çok ğ`},
		{`\u{1F3B5}`, "\U0001F3B5"},
		{`\ud83c\udfb5`, "\U0001F3B5"},
		{`a\nb\tc`, "a\nb\tc"},
		// Unescaped UTF-8 passes through untouched.
		{`Şarkı önerileri \x22ğüşıöç\x22`, `Şarkı önerileri "ğüşıöç"`},
		// \xNN is a code point, not a byte: \xe7 is ç, not half of one.
		{`\xe7`, "ç"},
	}
	for _, c := range cases {
		got, err := decodeJSString(c.in)
		if err != nil || got != c.want {
			t.Errorf("decodeJSString(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	for _, bad := range []string{`\x7`, `\u12`, `\xzz`, `tail\`} {
		if _, err := decodeJSString(bad); err == nil {
			t.Errorf("decodeJSString(%q) accepted a broken escape", bad)
		}
	}
}

// The homepage embeds the first page of Home among other initial data; it is
// found by path and browse id, and decodes to what the browse would return.
func TestEmbeddedBrowseReadsHomeFromThePage(t *testing.T) {
	page, err := os.ReadFile("testdata/homepage.html")
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/homepage_home.json")
	if err != nil {
		t.Fatal(err)
	}
	got := embeddedBrowse(string(page), "FEmusic_home")
	if got == nil {
		t.Fatal("no Home found in the page")
	}
	if !bytes.Equal(got, bytes.TrimSpace(want)) {
		t.Fatalf("decoded Home differs from the original:\n got %.200s\nwant %.200s", got, want)
	}
	var doc map[string]any
	if err := json.Unmarshal(got, &doc); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), `Şarkı önerileri: 'ğüşıöç' & \"çok\" <güzel>`) || !strings.Contains(string(got), `C:\\yol`) {
		t.Fatal("escapes or Turkish characters did not survive decoding")
	}

	// The explore entry sits before Home in the page and is not mistaken for it.
	explore := embeddedBrowse(string(page), "FEmusic_explore")
	if explore == nil || strings.Contains(string(explore), "Şarkı") {
		t.Fatalf("explore entry read wrongly: %s", explore)
	}
	if embeddedBrowse(string(page), "FEmusic_library_landing") != nil {
		t.Fatal("found a page that is not there")
	}
}

func TestEmbeddedBrowseGivesUpQuietly(t *testing.T) {
	for name, page := range map[string]string{
		"no data":       `<html>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"1"})</html>`,
		"unterminated":  `initialData.push({path: '\/browse', params: JSON.parse('\x7b\x22browseId\x22:\x22FEmusic_home\x22\x7d'), data: '\x7b`,
		"not json":      `initialData.push({path: '\/browse', params: JSON.parse('\x7b\x22browseId\x22:\x22FEmusic_home\x22\x7d'), data: '\x7bnope'});`,
		"with params":   `initialData.push({path: '\/browse', params: JSON.parse('\x7b\x22browseId\x22:\x22FEmusic_home\x22,\x22params\x22:\x22x\x22\x7d'), data: '\x7b\x7d'});`,
		"broken escape": `initialData.push({path: '\/browse', params: JSON.parse('\x7b\x22browseId\x22:\x22FEmusic_home\x22\x7d'), data: '\x7'});`,
	} {
		if got := embeddedBrowse(page, "FEmusic_home"); got != nil {
			t.Errorf("%s: got %s, want nothing", name, got)
		}
	}
}
