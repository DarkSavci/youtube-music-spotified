package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/resolver"
)

/*
Stream proxying.

googlevideo does not serve cross-origin browser requests, so the UI process
cannot fetch a resolved URL directly — which rules out building a Web Audio
graph over it, and with it EQ, normalization and true gapless.

The sidecar fetches the bytes instead and relays them to the UI over
localhost. That is not a workaround for the IP binding described in; it preserves it. The resolving process and the fetching process
are the same process on the same machine, so the signature's ip parameter
still matches. Bandwidth cost is nil because both ends are loopback.

Ranges are forwarded, but never unbounded. Upstream answers 403 to a request
for a whole file — "bytes=0-" or no Range at all — while serving the same URL
happily for a bounded window. A media element opens with exactly "bytes=0-",
so forwarding it verbatim meant every track failed on its first request, was
marked unplayable, and skipped. An open-ended range is therefore capped to a
window here; the browser asks for the next one as it plays, which is how
progressive media loading already works.

A bounded range from the client passes through untouched, so seeking still
works and the browser keeps managing its own buffer.
*/

// streamWindow is the largest read upstream will serve.
//
// Measured, not guessed: `go run ./cmd/rangeprobe <videoId>` answers 206 for a
// request of exactly this size and 403 for anything larger, whether the range
// is asked for in the header or the query string. It is a hard ceiling rather
// than a tuning choice, so every request — including one the client bounded
// itself — is capped to it.
const streamWindow = 1 << 20 // 1 MiB

// resolvedEntry caches a resolution so seeking and replaying do not
// re-resolve. Resolving costs four to five seconds of yt-dlp.
type resolvedEntry struct {
	stream  domain.Stream
	quality resolver.Quality
	at      time.Time
}

// storedEntry is resolvedEntry as it is written to disk.
type storedEntry struct {
	Stream  domain.Stream    `json:"stream"`
	Quality resolver.Quality `json:"quality"`
	At      time.Time        `json:"at"`
}

// URLStore keeps resolutions across restarts. The control store implements
// it; nil keeps them in memory only.
type URLStore interface {
	SaveStreamURL(ctx context.Context, videoID string, entry []byte, expires time.Time) error
	StreamURL(ctx context.Context, videoID string) ([]byte, bool)
	DropStreamURL(ctx context.Context, videoID string)
}

type streamCache struct {
	mu      sync.Mutex
	entries map[string]resolvedEntry
}

func newStreamCache() *streamCache {
	return &streamCache{entries: map[string]resolvedEntry{}}
}

/*
usable reports whether a resolution will last through the track.

The URL carries its own expiry, about six hours out, and that is what is
trusted now; a flat thirty minutes used to be assumed. Reuse needs more than
"not yet expired", though: a URL that dies halfway through the song is a
failure waiting to happen, so it has to outlive the whole track, with a
margin. That is limusic's rule, and it holds up.
*/
func (e resolvedEntry) usable(now time.Time) bool {
	length := time.Duration(e.stream.DurationMs) * time.Millisecond
	if length <= 0 {
		length = 10 * time.Minute
	}
	return !e.stream.Expired(now.Add(length + 2*time.Minute))
}

func (c *streamCache) get(videoID string) (resolvedEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[videoID]
	if !ok {
		return resolvedEntry{}, false
	}
	if !e.usable(time.Now()) {
		delete(c.entries, videoID)
		return resolvedEntry{}, false
	}
	return e, true
}

func (c *streamCache) put(videoID string, e resolvedEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[videoID] = e
}

// resolveCached returns a playable handle, reusing a recent resolution.
func (s *Server) resolveCached(ctx context.Context, videoID string) (resolvedEntry, error) {
	return s.resolve(ctx, videoID, false)
}

// resolveSpeculative is resolveCached for a guess: a prefetch nobody is
// waiting on. It gives way — is cancelled — the moment someone needs a
// different track resolved, because a yt-dlp run already going slows the
// one that was asked for.
func (s *Server) resolveSpeculative(ctx context.Context, videoID string) (resolvedEntry, error) {
	return s.resolve(ctx, videoID, true)
}

func (s *Server) resolve(ctx context.Context, videoID string, speculative bool) (resolvedEntry, error) {
	if e, ok := s.streams.get(videoID); ok {
		return e, nil
	}
	if e, ok := s.storedResolution(ctx, videoID); ok {
		s.streams.put(videoID, e)
		return e, nil
	}
	key := videoID
	if !speculative {
		s.preemptSpeculative(videoID)
	}

	/*
	 * One resolution per track, however many ask at once.
	 *
	 * Resolving means starting yt-dlp, which costs about three seconds — half
	 * of it just booting Python. Playing a track asks twice at the same
	 * instant: the media element fetches the stream while the client asks
	 * what the track's loudness is. Without this both missed the cache and
	 * both ran yt-dlp, so two subprocesses raced for the machine and the
	 * track took longer to start than if nothing had been asked at all.
	 *
	 * Preloading the next track while the current one is still resolving does
	 * the same, so this would be worth having even if nothing else did.
	 */
	s.pendingMu.Lock()
	if f, ok := s.pending[key]; ok {
		if !speculative {
			// Someone needs this one now: it is no longer a guess to drop.
			f.speculative = false
		}
		s.pendingMu.Unlock()
		select {
		case <-f.done:
			return f.entry, f.err
		case <-ctx.Done():
			return resolvedEntry{}, ctx.Err()
		}
	}
	f := &pendingResolve{done: make(chan struct{}), speculative: speculative}
	if s.pending == nil {
		s.pending = make(map[string]*pendingResolve)
	}
	s.pending[key] = f
	s.pendingMu.Unlock()

	/*
	 * Detached from the caller that happened to arrive first.
	 *
	 * Everyone waiting shares this one resolution, so letting the first
	 * request's cancellation kill it would fail the others for a reason that
	 * has nothing to do with them — and the first request is often the
	 * loudness lookup, which the client abandons freely.
	 */
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), resolveTimeout)
	s.pendingMu.Lock()
	f.cancel = cancel
	s.pendingMu.Unlock()
	stream, quality, err := s.deps.Resolver.Resolve(rctx, videoID)
	cancel()

	if err == nil {
		f.entry = resolvedEntry{stream: stream, quality: quality, at: time.Now()}
		s.streams.put(videoID, f.entry)
		s.storeResolution(videoID, f.entry)
		s.lastFailure.Delete(videoID)
	} else if !errors.Is(err, context.Canceled) {
		// Remembered so a failed track can be diagnosed without resolving it
		// again — see handleHealth.
		s.lastFailure.Store(videoID, err)
	}
	f.err = err

	s.pendingMu.Lock()
	delete(s.pending, key)
	s.pendingMu.Unlock()
	close(f.done)

	return f.entry, f.err
}

// storedResolution reads a resolution saved by an earlier run.
func (s *Server) storedResolution(ctx context.Context, videoID string) (resolvedEntry, bool) {
	if s.deps.URLs == nil {
		return resolvedEntry{}, false
	}
	raw, ok := s.deps.URLs.StreamURL(ctx, videoID)
	if !ok {
		return resolvedEntry{}, false
	}
	var st storedEntry
	if json.Unmarshal(raw, &st) != nil {
		return resolvedEntry{}, false
	}
	e := resolvedEntry{stream: st.Stream, quality: st.Quality, at: st.At}
	return e, e.usable(time.Now())
}

func (s *Server) storeResolution(videoID string, e resolvedEntry) {
	if s.deps.URLs == nil || e.stream.ExpiresAt.IsZero() {
		return
	}
	raw, err := json.Marshal(storedEntry{Stream: e.stream, Quality: e.quality, At: e.at})
	if err != nil {
		return
	}
	_ = s.deps.URLs.SaveStreamURL(context.Background(), videoID, raw, e.stream.ExpiresAt)
}

// forgetResolution drops a resolution upstream has refused, everywhere.
func (s *Server) forgetResolution(videoID string) {
	s.streams.drop(videoID)
	if s.deps.URLs != nil {
		s.deps.URLs.DropStreamURL(context.Background(), videoID)
	}
}

// preemptSpeculative cancels guesses in flight for any track but this one.
func (s *Server) preemptSpeculative(videoID string) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	for key, f := range s.pending {
		if key != videoID && f.speculative && f.cancel != nil {
			f.cancel()
		}
	}
}

// resolveTimeout bounds a shared resolution. Generous, because it covers a
// subprocess that fetches from upstream, and a caller that gave up is no
// longer the reason to stop.
const resolveTimeout = 60 * time.Second

// pendingResolve is a resolution in progress, and the result everyone waiting
// on it receives.
type pendingResolve struct {
	done chan struct{}
	// speculative is set while nobody but a prefetch is waiting on it.
	speculative bool
	cancel      context.CancelFunc
	entry       resolvedEntry
	err         error
}

// handleResolve reports what a Track would play as, without transferring it.
// The UI uses this to show the quality badge and to decide which engine to use.
func (s *Server) handleResolve(w http.ResponseWriter, r *http.Request) {
	if s.deps.Resolver == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "no resolver configured"})
		return
	}
	e, err := s.resolveCached(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := map[string]any{
		"videoId":    e.stream.VideoID,
		"kind":       e.stream.Kind,
		"mimeType":   e.stream.MimeType,
		"durationMs": e.stream.DurationMs,
		"sizeBytes":  e.stream.SizeBytes,
		"quality":    e.quality,
		// The upstream URL is deliberately not returned. It is bound to this
		// machine's address and would 403 anywhere else, so handing it out
		// invites a confusing failure. Play through /v1/stream instead.
		"streamUrl": "/v1/stream/" + e.stream.VideoID,
	}

	/*
	 * Loudness rides along with the handle, so the correction is set before
	 * the first sample plays.
	 *
	 * Fetched here rather than inside the resolver because it is not part of
	 * making a track playable: the preferred resolver is yt-dlp, which does
	 * not report it at all, and a track still plays perfectly well without it.
	 * A failure is therefore left out of the response rather than failing the
	 * request — the client measures instead, as it always did.
	 */
	if s.deps.Loudness != nil {
		if lkfs, err := s.deps.Loudness.For(r.Context(), e.stream.VideoID); err == nil {
			out["loudnessLkfs"] = lkfs
		}
	}

	s.write(w, http.StatusOK, out)
}

/*
handleLoudness reports how loud a Track is, without resolving it.

Its own route because loudness and playability are separate questions with
very different costs. Asking /v1/resolve for it meant starting yt-dlp — three
seconds, most of it Python booting — to read a number that comes from a JSON
call taking a tenth of that. Worse, the client asks at the moment playback
starts, so that work landed squarely on top of the work of starting the track.
*/
func (s *Server) handleLoudness(w http.ResponseWriter, r *http.Request) {
	if s.deps.Loudness == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "loudness unavailable"})
		return
	}
	lkfs, err := s.deps.Loudness.For(r.Context(), r.PathValue("id"))
	if err != nil {
		// A track that publishes no loudness is an ordinary outcome, not a
		// failure: the client levels by ear instead.
		s.write(w, http.StatusOK, map[string]any{})
		return
	}
	s.write(w, http.StatusOK, map[string]any{"loudnessLkfs": lkfs})
}

/*
handleTrackHealth says why a track last failed to resolve, without resolving it.

The engine asks this when a track will not play, to tell a rate limit — wait,
keep the queue — from a dead track — skip it. It used to ask /v1/resolve,
which started yt-dlp to answer a question the failed resolution had already
answered.
*/
func (s *Server) handleTrackHealth(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"rateLimited": false}
	if v, ok := s.lastFailure.Load(r.PathValue("id")); ok {
		err, _ := v.(error)
		out["rateLimited"] = errors.Is(err, resolver.ErrRateLimited)
		if err != nil {
			out["error"] = err.Error()
		}
	}
	s.write(w, http.StatusOK, out)
}

// drop removes a cached resolution, so the next request resolves afresh.
func (c *streamCache) drop(videoID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, videoID)
}

// boundedRange turns a client Range into one upstream will actually serve.
//
// A request with no Range, or an open-ended "bytes=N-", is capped to a window.
// An already-bounded range is returned unchanged, so seeking is unaffected.
func boundedRange(clientRange string, size int64) string {
	start := int64(0)

	if clientRange != "" {
		spec, ok := strings.CutPrefix(strings.TrimSpace(clientRange), "bytes=")
		if !ok {
			// Some other unit, or something malformed. Ask for a window from
			// the beginning rather than forwarding what upstream will refuse.
			return fmt.Sprintf("bytes=0-%d", streamWindow-1)
		}
		// Multi-range requests are rare and a media element does not send
		// them; treating one as its first range is better than a 403.
		if comma := strings.IndexByte(spec, ','); comma >= 0 {
			spec = spec[:comma]
		}
		rawFrom, rawTo, _ := strings.Cut(spec, "-")
		from := strings.TrimSpace(rawFrom)
		to := strings.TrimSpace(rawTo)
		if from == "" {
			// A suffix range ("bytes=-500") asks for the tail, which players
			// use to probe a container. They are small; pass them through.
			return clientRange
		}
		parsed, err := strconv.ParseInt(from, 10, 64)
		if err != nil || parsed < 0 {
			return fmt.Sprintf("bytes=0-%d", streamWindow-1)
		}
		start = parsed

		// A client-bounded range is still capped. Chromium asks for multi-
		// megabyte spans once it is buffering ahead, and upstream refuses
		// those exactly as it refuses an open-ended one.
		if end := strings.TrimSpace(to); end != "" {
			if want, err := strconv.ParseInt(end, 10, 64); err == nil && want >= start {
				if want-start+1 <= streamWindow {
					return clientRange
				}
			}
		}
	}

	end := start + streamWindow - 1
	// Do not ask past the end of a file whose size we know; upstream treats an
	// out-of-range end as another reason to refuse.
	if size > 0 && end > size-1 {
		end = size - 1
	}
	if end < start {
		end = start
	}
	return fmt.Sprintf("bytes=%d-%d", start, end)
}

// fetchUpstream performs the request to googlevideo with the given Range.
//
// The headers matter: upstream serves this only when it looks like the client
// that resolved it.
func (s *Server) fetchUpstream(ctx context.Context, url, rng string) (*http.Response, error) {
	upstream, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if rng != "" {
		upstream.Header.Set("Range", rng)
	}
	upstream.Header.Set("User-Agent", browserUserAgent)
	upstream.Header.Set("Origin", "https://music.youtube.com")
	upstream.Header.Set("Referer", "https://music.youtube.com/")
	return s.streamClient.Do(upstream)
}

// handleStream relays audio bytes to the UI process.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	if s.deps.Resolver == nil {
		http.Error(w, "no resolver configured", http.StatusServiceUnavailable)
		return
	}
	videoID := r.PathValue("id")
	/*
	 * A preload is the engine readying the next track on its idle deck.
	 *
	 * Nobody is listening to it yet, so it resolves as a guess: it neither
	 * pauses the background work nor cancels a guess in progress, the way a
	 * track someone is waiting for does.
	 */
	preload := r.URL.Query().Get("preload") == "1"

	// Cached audio needs no resolution at all, which is the whole point.
	if s.serveCached(w, r, videoID, 0) {
		return
	}

	var (
		e   resolvedEntry
		err error
	)
	if preload {
		e, err = s.resolveSpeculative(r.Context(), videoID)
	} else {
		// Someone is listening for this one: speculative resolutions wait.
		resolved := s.haveResolution(r.Context(), videoID)
		if !resolved {
			s.prefetch.waiting.Add(1)
		}
		e, err = s.resolveCached(r.Context(), videoID)
		if !resolved {
			s.prefetch.waiting.Add(-1)
		}
	}
	if err != nil {
		// A rate limit must be distinguishable from a broken track, or the
		// client marks every track unplayable on the way down the queue.
		if errors.Is(err, resolver.ErrRateLimited) {
			s.deps.Log.Warn("stream rate limited", "video", videoID)
			http.Error(w, "rate limited by YouTube", http.StatusTooManyRequests)
			return
		}
		s.deps.Log.Warn("stream resolve failed", "video", videoID, "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if e.stream.Kind != domain.StreamURL {
		http.Error(w, "this track is played by the embedded engine", http.StatusConflict)
		return
	}

	/*
	 * Download the track once, and play it as it arrives.
	 *
	 * The whole track comes down in one request into the cache, and this
	 * response reads the file as it grows. Relaying upstream directly as
	 * well, as this used to, fetched every new track twice.
	 */
	size := e.stream.SizeBytes
	if s.deps.Audio != nil {
		s.dropIfOtherFormat(videoID, e.stream.SizeBytes)
		if preload {
			s.Prefetch(videoID, true)
		} else {
			s.fillPlaying(videoID)
		}
		if s.serveCached(w, r, videoID, 15*time.Second) {
			return
		}
		if m, ok := s.deps.Audio.Get(videoID); ok && size == 0 {
			size = m.Size
		}
	}

	// The fallback: relay upstream directly, in the bounded windows every
	// URL serves.
	upstreamRange := boundedRange(r.Header.Get("Range"), size)

	rctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	resp, err := s.fetchUpstream(rctx, e.stream.URL, upstreamRange)
	if err != nil {
		s.deps.Log.Warn("stream fetch failed", "video", videoID, "err", err)
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	/*
	 * A 403 means the URL went stale, not that the track is gone.
	 *
	 * These URLs are signed, address-bound and short-lived, and upstream will
	 * refuse one that has been superseded. Dropping the cache entry is not
	 * enough on its own: a media element treats a 403 as fatal and reports
	 * MEDIA_ERR_SRC_NOT_SUPPORTED, so the session faults the track, marks it
	 * unplayable and skips — and the "next attempt" this cache drop was
	 * written for never comes. Four tracks in a row died that way before the
	 * engine gave up and fell back.
	 *
	 * So re-resolve and retry here, once, where the client cannot see it.
	 */
	if resp.StatusCode == http.StatusForbidden {
		_ = resp.Body.Close()
		s.forgetResolution(videoID)
		s.deps.Log.Info("stream 403; re-resolving", "video", videoID)

		fresh, rerr := s.resolveCached(r.Context(), videoID)
		if rerr != nil {
			s.deps.Log.Warn("stream re-resolve failed", "video", videoID, "err", rerr)
			http.Error(w, rerr.Error(), http.StatusBadGateway)
			return
		}
		resp, err = s.fetchUpstream(rctx, fresh.stream.URL, upstreamRange)
		if err != nil {
			s.deps.Log.Warn("stream refetch failed", "video", videoID, "err", err)
			http.Error(w, "upstream unreachable", http.StatusBadGateway)
			return
		}
		defer func() { _ = resp.Body.Close() }()

		// One retry only. A second 403 is a real refusal — the account, the
		// track or the address — and retrying further would hang the player
		// instead of letting the failure ladder do its job.
		if resp.StatusCode == http.StatusForbidden {
			s.forgetResolution(videoID)
			s.deps.Log.Warn("stream still refused after re-resolve", "video", videoID)
		}
	}

	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	// The UI may fetch this into a Web Audio graph, which requires the read to
	// be same-origin or explicitly permitted.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)

	if _, err := io.Copy(w, stallGuard(resp.Body, cancel)); err != nil {
		// A client seeking away mid-transfer aborts the copy. That is normal
		// and not worth reporting as an error.
		s.deps.Log.Debug("stream copy ended", "video", videoID, "err", err)
	}
}

const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
