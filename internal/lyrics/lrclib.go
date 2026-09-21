package lyrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"spotifier/internal/domain"
)

/*
LRCLIB: community-contributed lyrics, frequently timed.

This is the only source that can return timings, which is the entire reason it
is here — a lyrics view that follows the music is a different thing from a
block of text.

It is also a third party that YouTube is not, so it is contacted only when the
user has asked for timed lyrics. What it receives is the track title, artist
and duration; that is the minimum a lyrics lookup can work with, and it is sent
without any identifier for the listener.
*/
type LRCLib struct {
	// BaseURL allows a test to point elsewhere. Empty means the public API.
	BaseURL string
	Client  *http.Client
}

func NewLRCLib() *LRCLib {
	return &LRCLib{Client: &http.Client{Timeout: 10 * time.Second}}
}

var _ Provider = (*LRCLib)(nil)

func (l *LRCLib) Name() string { return "LRCLIB" }

func (l *LRCLib) base() string {
	if l.BaseURL != "" {
		return l.BaseURL
	}
	return "https://lrclib.net"
}

type lrclibResponse struct {
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
	Duration     float64 `json:"duration"`
	PlainLyrics  string  `json:"plainLyrics"`
	SyncedLyrics string  `json:"syncedLyrics"`
	Instrumental bool    `json:"instrumental"`
}

func (l *LRCLib) Lyrics(ctx context.Context, track domain.Track) (domain.Lyrics, error) {
	title := strings.TrimSpace(track.Title)
	var artist string
	if len(track.Artists) > 0 {
		artist = strings.TrimSpace(track.Artists[0].Name)
	}
	if title == "" || artist == "" {
		// Without both, the lookup cannot be specific enough to trust.
		return domain.Lyrics{}, ErrNotFound
	}

	q := url.Values{}
	q.Set("track_name", title)
	q.Set("artist_name", artist)
	if track.Album != nil && track.Album.Name != "" {
		q.Set("album_name", track.Album.Name)
	}
	if track.DurationMs > 0 {
		q.Set("duration", strconv.FormatInt(track.DurationMs/1000, 10))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, l.base()+"/api/get?"+q.Encode(), nil)
	if err != nil {
		return domain.Lyrics{}, err
	}
	// The service asks clients to identify themselves.
	req.Header.Set("User-Agent", "spotifier (https://github.com/spotifier)")

	resp, err := l.Client.Do(req)
	if err != nil {
		return domain.Lyrics{}, fmt.Errorf("lyrics: lrclib: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return domain.Lyrics{}, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return domain.Lyrics{}, fmt.Errorf("lyrics: lrclib: status %d", resp.StatusCode)
	}

	var body lrclibResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return domain.Lyrics{}, fmt.Errorf("lyrics: lrclib: decode: %w", err)
	}
	if body.Instrumental {
		return domain.Lyrics{}, ErrNotFound
	}

	out := domain.Lyrics{Source: "LRCLIB", Plain: body.PlainLyrics}
	if lines := ParseLRC(body.SyncedLyrics); len(lines) > 0 {
		out.Lines = lines
	}
	if out.Plain == "" && len(out.Lines) == 0 {
		return domain.Lyrics{}, ErrNotFound
	}
	return out, nil
}

var errBadTimestamp = errors.New("bad timestamp")

/*
ParseLRC reads the LRC format into timed lines.

The format is one "[mm:ss.xx] text" per line, and real files are untidy: blank
lines, metadata tags like "[ar:...]", repeated timestamps on one line, and
two- or three-digit fractions. Anything that does not parse is skipped rather
than failing the whole set, because one malformed line should not cost the
listener the other sixty.
*/
func ParseLRC(s string) []domain.LyricLine {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []domain.LyricLine

	for _, raw := range strings.Split(s, "\n") {
		line := strings.TrimRight(raw, "\r")
		var stamps []int64

		for strings.HasPrefix(line, "[") {
			end := strings.IndexByte(line, ']')
			if end < 0 {
				break
			}
			ms, err := parseLRCTimestamp(line[1:end])
			if err != nil {
				// A metadata tag such as [ar:Artist]; not a timestamp.
				break
			}
			stamps = append(stamps, ms)
			line = line[end+1:]
		}
		if len(stamps) == 0 {
			continue
		}

		text := strings.TrimSpace(line)
		for _, at := range stamps {
			// An empty line is kept: it is a real pause in the song, and
			// dropping it makes the view jump ahead of the music.
			out = append(out, domain.LyricLine{AtMs: at, Text: text})
		}
	}

	sortLines(out)
	return out
}

func parseLRCTimestamp(s string) (int64, error) {
	min, rest, ok := strings.Cut(s, ":")
	if !ok {
		return 0, errBadTimestamp
	}
	m, err := strconv.ParseInt(strings.TrimSpace(min), 10, 64)
	if err != nil || m < 0 {
		return 0, errBadTimestamp
	}

	sec, frac, hasFrac := strings.Cut(rest, ".")
	if !hasFrac {
		sec, frac, hasFrac = strings.Cut(rest, ":")
	}
	sv, err := strconv.ParseInt(strings.TrimSpace(sec), 10, 64)
	if err != nil || sv < 0 || sv > 59 {
		return 0, errBadTimestamp
	}

	ms := (m*60 + sv) * 1000
	if hasFrac {
		frac = strings.TrimSpace(frac)
		f, err := strconv.ParseInt(frac, 10, 64)
		if err != nil || f < 0 {
			return 0, errBadTimestamp
		}
		// Fractions appear as hundredths or thousandths.
		switch len(frac) {
		case 1:
			ms += f * 100
		case 2:
			ms += f * 10
		default:
			ms += f
		}
	}
	return ms, nil
}

// sortLines orders by time. Multi-timestamp lines and out-of-order files are
// both common enough that relying on file order would show lines early.
func sortLines(lines []domain.LyricLine) {
	for i := 1; i < len(lines); i++ {
		for j := i; j > 0 && lines[j].AtMs < lines[j-1].AtMs; j-- {
			lines[j], lines[j-1] = lines[j-1], lines[j]
		}
	}
}
