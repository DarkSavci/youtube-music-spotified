package resolver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"spotifier/internal/domain"
)

/*
The yt-dlp adapter.

ADR 0007 settled that decipher is delegated rather than implemented, and named
this the default for Premium tiers: the pure-Go library drives its own client
identity and cannot simply be handed account cookies — doing so turns a working
stream into a 403 — so it serves standard tiers only.

Two things this adapter must get right that the library one does not:

Cookies are passed as a file, not folded into a client context. yt-dlp applies
them to the player request the way a browser would, which is what makes the
subscriber-only tiers resolve at all.

The chosen format is audio-only and progressive. A DASH manifest would need a
segment fetcher the relay does not have, and the relay speaks plain ranges.
*/

// Ytdlp resolves by invoking the yt-dlp binary.
type Ytdlp struct {
	// Bin is the executable to run. Empty means "yt-dlp" on PATH.
	Bin string
	// CookiePath is a Netscape-format cookie file, or empty for anonymous
	// resolution. Without it only standard tiers are available.
	CookiePath string
	// Timeout bounds a single resolution. yt-dlp occasionally retries
	// internally, and an unbounded call would hang the player rather than
	// letting the failure ladder run.
	Timeout time.Duration
	// Deno is the JavaScript runtime yt-dlp solves YouTube's player
	// challenges with. Without one, signed-in requests fail outright ("The
	// page needs to be reloaded") and anonymous ones lose every audio format.
	// Empty leaves yt-dlp to find a runtime on PATH, which on most machines
	// does not exist.
	Deno string

	once    sync.Once
	present bool
}

// NewYtdlp builds the adapter. It does not probe for the binary; Available
// does that, once, on first use.
func NewYtdlp(bin, cookiePath string) *Ytdlp {
	return &Ytdlp{Bin: bin, CookiePath: cookiePath, Timeout: 45 * time.Second}
}

var _ Resolver = (*Ytdlp)(nil)

func (y *Ytdlp) Name() string { return "ytdlp" }

func (y *Ytdlp) binary() string {
	if y.Bin != "" {
		return y.Bin
	}
	return "yt-dlp"
}

// Available reports whether the binary can be run at all.
//
// Probed once and cached: this is consulted when choosing a resolver at
// startup, and a missing binary must degrade to the pure-Go adapter rather
// than fail the process.
func (y *Ytdlp) Available() bool {
	y.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		y.present = exec.CommandContext(ctx, y.binary(), "--version").Run() == nil
	})
	return y.present
}

// ytdlpFormat is the subset of yt-dlp's JSON this adapter reads.
type ytdlpFormat struct {
	URL       string  `json:"url"`
	Ext       string  `json:"ext"`
	ACodec    string  `json:"acodec"`
	VCodec    string  `json:"vcodec"`
	ABR       float64 `json:"abr"`
	TBR       float64 `json:"tbr"`
	FormatID  string  `json:"format_id"`
	Filesize  int64   `json:"filesize"`
	Protocol  string  `json:"protocol"`
	AudioOnly bool    `json:"-"`
}

type ytdlpInfo struct {
	Duration float64       `json:"duration"`
	Formats  []ytdlpFormat `json:"formats"`
}

/*
Asking as YouTube Music, then as anything.

By default yt-dlp tries several of YouTube's clients and starts by fetching
the watch page. Measured on one account: the default took 5.7 s and came
back with the standard format (251); restricted to the YouTube Music client
and skipping the page, it took 4.2-4.5 s and returned the subscriber format
(774). A track that client cannot serve — some videos, podcasts — is tried
again the default way before the resolver gives up.
*/
var musicClientArgs = []string{"--extractor-args", "youtube:player_client=web_music;player_skip=webpage,configs"}

func (y *Ytdlp) Resolve(ctx context.Context, videoID string) (domain.Stream, Quality, error) {
	if y.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, y.Timeout)
		defer cancel()
	}
	st, q, err := y.resolveWith(ctx, videoID, musicClientArgs, "https://music.youtube.com/watch?v=")
	if err == nil || ctx.Err() != nil || errors.Is(err, ErrRateLimited) {
		return st, q, err
	}
	return y.resolveWith(ctx, videoID, nil, "https://www.youtube.com/watch?v=")
}

func (y *Ytdlp) resolveWith(ctx context.Context, videoID string, extra []string, base string) (domain.Stream, Quality, error) {
	args := []string{
		"--dump-single-json",
		"--no-warnings",
		"--no-playlist",
		// Progressive audio only: the relay forwards byte ranges and has no
		// segment fetcher, so a DASH manifest would be unplayable here.
		"-f", "bestaudio[protocol^=http][acodec!=none][vcodec=none]/bestaudio",
	}
	if y.CookiePath != "" {
		if _, err := os.Stat(y.CookiePath); err == nil {
			args = append(args, "--cookies", y.CookiePath)
		}
	}
	if y.Deno != "" {
		args = append(args, "--js-runtimes", "deno:"+y.Deno)
	}
	args = append(args, extra...)
	args = append(args, base+videoID)

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, y.binary(), args...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return domain.Stream{}, Quality{}, classify(
			fmt.Errorf("yt-dlp: %v: %s", err, strings.TrimSpace(stderr.String())))
	}

	var info ytdlpInfo
	if err := json.Unmarshal(stdout.Bytes(), &info); err != nil {
		return domain.Stream{}, Quality{}, fmt.Errorf("yt-dlp: parse output: %w", err)
	}

	best := bestYtdlpAudio(info.Formats)
	if best == nil {
		return domain.Stream{}, Quality{}, ErrNoAudio
	}

	bitrate := int(best.ABR * 1000)
	if bitrate == 0 {
		bitrate = int(best.TBR * 1000)
	}
	codec := codecName(best.ACodec)

	return domain.Stream{
			Kind:       domain.StreamURL,
			VideoID:    videoID,
			URL:        best.URL,
			MimeType:   fmt.Sprintf("audio/%s; codecs=%q", best.Ext, best.ACodec),
			Bitrate:    bitrate,
			SizeBytes:  best.Filesize,
			DurationMs: int64(info.Duration * 1000),
			// yt-dlp does not report the expiry; the URL carries it.
			ExpiresAt: expiryOfURL(best.URL, time.Now()),
		}, Quality{
			Label:   fmt.Sprintf("%s %d kbps", codec, bitrate/1000),
			Bitrate: bitrate,
			Codec:   codec,
			// The subscriber-only tiers. Reaching one is the whole reason this
			// adapter exists rather than the pure-Go one.
			Premium: best.FormatID == "774" || best.FormatID == "141",
		}, nil
}

// bestYtdlpAudio picks the highest-bitrate progressive audio-only format.
func bestYtdlpAudio(formats []ytdlpFormat) *ytdlpFormat {
	var best *ytdlpFormat
	for i := range formats {
		f := &formats[i]
		if f.URL == "" || f.ACodec == "" || f.ACodec == "none" {
			continue
		}
		if f.VCodec != "" && f.VCodec != "none" {
			continue // muxed: needless video bytes over the relay
		}
		if !strings.HasPrefix(f.Protocol, "http") {
			continue // a manifest the relay cannot serve
		}
		if best == nil || rate(f) > rate(best) {
			best = f
		}
	}
	return best
}

func rate(f *ytdlpFormat) float64 {
	if f.ABR > 0 {
		return f.ABR
	}
	return f.TBR
}

func codecName(acodec string) string {
	switch {
	case strings.HasPrefix(acodec, "opus"):
		return "Opus"
	case strings.HasPrefix(acodec, "mp4a"), strings.HasPrefix(acodec, "aac"):
		return "AAC"
	case acodec == "":
		return "Audio"
	default:
		return acodec
	}
}
