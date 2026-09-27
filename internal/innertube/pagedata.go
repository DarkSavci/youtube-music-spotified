package innertube

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

/*
The web client's first page comes with its first answer.

music.youtube.com/ is served with the Home page the client would otherwise ask
for, embedded as JavaScript:

	initialData.push({path: '\/browse', params: JSON.parse('\x7b...\x7d'), data: '\x7b...\x7d'});

The same page is already fetched for the config, so reading Home out of it
saves the browse a cold start would otherwise send straight after.
*/

const initialDataPush = "initialData.push({path: '"

// embeddedBrowse returns the response embedded in the page for a browse of
// browseID with no params, or nil when there is none or it does not decode.
func embeddedBrowse(html, browseID string) json.RawMessage {
	rest := html
	for {
		i := strings.Index(rest, initialDataPush)
		if i < 0 {
			return nil
		}
		rest = rest[i+len(initialDataPush):]
		path, params, data, next, ok := readPush(rest)
		if !ok {
			// A malformed entry says nothing about where the next one starts.
			continue
		}
		rest = next
		if path != "/browse" {
			continue
		}
		var p map[string]any
		if json.Unmarshal([]byte(params), &p) != nil || len(p) != 1 || p["browseId"] != browseID {
			continue
		}
		if !json.Valid([]byte(data)) {
			return nil
		}
		return json.RawMessage(data)
	}
}

// readPush reads one entry's fields, s starting just inside the path literal.
func readPush(s string) (path, params, data, rest string, ok bool) {
	lit := func(prefix string) (string, bool) {
		if !strings.HasPrefix(s, prefix) {
			return "", false
		}
		raw, n, ok := scanJSString(s[len(prefix):])
		if !ok {
			return "", false
		}
		s = s[len(prefix)+n:]
		out, err := decodeJSString(raw)
		return out, err == nil
	}
	if path, ok = lit(""); !ok {
		return
	}
	if params, ok = lit(", params: JSON.parse('"); !ok {
		return
	}
	if data, ok = lit("), data: '"); !ok {
		return
	}
	return path, params, data, s, true
}

// scanJSString finds the end of a single-quoted literal whose opening quote
// has been consumed: it returns the literal's body and the length consumed,
// closing quote included.
func scanJSString(s string) (string, int, bool) {
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '\'':
			return s[:i], i + 1, true
		case '\n':
			return "", 0, false
		}
	}
	return "", 0, false
}

// decodeJSString undoes the escapes of a JavaScript string literal's body.
// Characters that are not escaped pass through as they are, UTF-8 included.
func decodeJSString(s string) (string, error) {
	if !strings.Contains(s, `\`) {
		return s, nil
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		c := s[i]
		if c != '\\' {
			b.WriteByte(c)
			i++
			continue
		}
		if i+1 >= len(s) {
			return "", fmt.Errorf("dangling escape")
		}
		e := s[i+1]
		i += 2
		switch e {
		case 'x':
			r, err := hexRune(s, i, 2)
			if err != nil {
				return "", err
			}
			b.WriteRune(r)
			i += 2
		case 'u':
			var r rune
			var err error
			if i < len(s) && s[i] == '{' {
				end := strings.IndexByte(s[i:], '}')
				if end < 2 {
					return "", fmt.Errorf("bad \\u{} escape")
				}
				r, err = hexRune(s, i+1, end-1)
				i += end + 1
			} else {
				r, err = hexRune(s, i, 4)
				i += 4
			}
			if err != nil {
				return "", err
			}
			// A pair of escaped surrogates is one character.
			if utf16.IsSurrogate(r) && i+6 <= len(s) && s[i] == '\\' && s[i+1] == 'u' {
				if lo, err := hexRune(s, i+2, 4); err == nil {
					if pair := utf16.DecodeRune(r, lo); pair != utf8.RuneError {
						r = pair
						i += 6
					}
				}
			}
			b.WriteRune(r)
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'v':
			b.WriteByte('\v')
		case '0':
			b.WriteByte(0)
		case '\n':
			// A line continuation stands for nothing.
		default:
			// \\, \', \", \/ and any other character stand for themselves.
			b.WriteByte(e)
		}
	}
	return b.String(), nil
}

func hexRune(s string, at, n int) (rune, error) {
	if at+n > len(s) {
		return 0, fmt.Errorf("short escape")
	}
	v, err := strconv.ParseUint(s[at:at+n], 16, 32)
	if err != nil {
		return 0, fmt.Errorf("bad escape %q", s[at:at+n])
	}
	return rune(v), nil
}
