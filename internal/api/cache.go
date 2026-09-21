package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"spotifier/internal/audiocache"
	"spotifier/internal/resolver"
)

/*
Serving from the audio cache, and filling it.

What Spotify does, adapted: a track that is cached plays from disk and never
touches yt-dlp; one whose opening was prefetched starts from that opening
while the rest is resolved behind it; and anything played, or queued to play
next, is downloaded whole so the next time is instant too.

A track is downloaded in one request. The URLs yt-dlp resolves are served
whole at tens of megabytes a second — measured, open-ended and from the
middle of a three-hour file alike — so the 1 MiB windows this began with
are only the fallback now, for a URL that refuses a whole-file request.
Playback reads the file as it grows, so a track being downloaded for the
first time is fetched once, not once for the player and again for the cache.
*/

// prefixBytes is how much of a track a speculative prefetch stores: about
// thirty seconds at the best tier. Spotify starts from about fifteen; the
// extra covers a slow resolution behind it.
const prefixBytes = 1 << 20

// followAhead is how far past a download's progress a request may start and
// still wait for it, rather than going to upstream for its own copy. At the
// rates measured this is well under a second of downloading.
const followAhead = 16 << 20

// stallTimeout ends a transfer that has stopped making progress. A total
// deadline would have to allow for a three-hour mix on a slow line; what
// matters is that bytes keep arriving. A variable so tests can shorten it.
var stallTimeout = 20 * time.Second

// prefetcher bounds speculative work, which is all upstream requests against
// an address YouTube rate-limits.
type prefetcher struct {
	// Resolutions are yt-dlp processes, each a Python interpreter and a JS
	// runtime. One speculative one at a time: more made a track someone
	// actually clicked wait behind guesses, which took a cold start from
	// five seconds to thirteen.
	resolve chan struct{}
	// Downloads are cheap by comparison, but not free.
	fill chan struct{}

	mu sync.Mutex
	// recent stops the same track being asked for on every projection.
	recent map[string]time.Time
	// pausedUntil is set when upstream says to back off.
	pausedUntil time.Time
	// queued holds the cancel for each whole-track download started for the
	// queue, so one that leaves the queue stops taking a download slot.
	queued map[string]context.CancelFunc
	// wanted is the queue's current set, so a download that gave way to a
	// listener can tell whether it is still worth resuming.
	wanted map[string]bool

	// waiting counts streams someone is listening for that still need
	// resolving. Speculative work holds off while any are.
	waiting atomic.Int32
}

// yield waits while a listener is waiting on a resolution of their own.
func (p *prefetcher) yield(ctx context.Context) error {
	for p.waiting.Load() > 0 {
		select {
		case <-time.After(150 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func newPrefetcher() *prefetcher {
	return &prefetcher{
		resolve: make(chan struct{}, 1),
		fill:    make(chan struct{}, 3),
		recent:  map[string]time.Time{},
		queued:  map[string]context.CancelFunc{},
		wanted:  map[string]bool{},
	}
}

// claim reports whether a track should be prefetched now, and records it.
func (p *prefetcher) claim(key string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if now.Before(p.pausedUntil) {
		return false
	}
	if at, ok := p.recent[key]; ok && now.Sub(at) < 10*time.Minute {
		return false
	}
	if len(p.recent) > 2000 {
		p.recent = map[string]time.Time{}
	}
	p.recent[key] = now
	return true
}

// claimNow is claim for the playing track: a back-off for guesses does not
// apply to it, and it may be asked again sooner.
func (p *prefetcher) claimNow(key string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if at, ok := p.recent[key]; ok && now.Sub(at) < time.Minute {
		return false
	}
	p.recent[key] = now
	return true
}

func (p *prefetcher) unclaim(key string) {
	p.mu.Lock()
	delete(p.recent, key)
	p.mu.Unlock()
}

func (p *prefetcher) backOff() {
	p.mu.Lock()
	p.pausedUntil = time.Now().Add(10 * time.Minute)
	p.mu.Unlock()
}

// Prefetch readies a track in the background: its opening, or all of it.
// Safe to call freely; repeats and a busy or rate-limited upstream are
// absorbed here.
func (s *Server) Prefetch(videoID string, whole bool) {
	s.prefetchTrack(videoID, whole, false)
}

/*
PrefetchQueue keeps the playing track and the ones after it downloading,
and stops what is no longer coming up.

A track that left the queue — skipped past, removed, a different album
started — used to go on downloading for up to five minutes, holding one of
the few download slots the tracks that are coming up needed.
*/
func (s *Server) PrefetchQueue(ids []string) {
	wanted := make(map[string]bool, len(ids))
	for _, id := range ids {
		wanted[id] = true
	}
	s.prefetch.mu.Lock()
	s.prefetch.wanted = wanted
	for id, cancel := range s.prefetch.queued {
		if !wanted[id] {
			cancel()
			delete(s.prefetch.queued, id)
			// Worth fetching again if it comes back.
			delete(s.prefetch.recent, id+":whole")
		}
	}
	s.prefetch.mu.Unlock()
	for _, id := range ids {
		s.prefetchTrack(id, true, true)
	}
}

func (s *Server) prefetchTrack(videoID string, whole, forQueue bool) {
	if s.deps.Audio == nil || s.deps.Resolver == nil || videoID == "" {
		return
	}
	limit := int64(prefixBytes)
	if whole {
		limit = 0
	}
	if m, ok := s.deps.Audio.Get(videoID); ok && (m.Complete() || (!whole && m.Have >= limit)) {
		return
	}
	key := videoID
	if whole {
		key += ":whole"
	}
	if !s.prefetch.claim(key) {
		return
	}

	// A whole track is a long transfer; the stall guard, not this, is what
	// catches a dead one.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	if forQueue {
		s.prefetch.mu.Lock()
		s.prefetch.queued[videoID] = cancel
		s.prefetch.mu.Unlock()
	}
	done := s.startFill(videoID)
	go func() {
		defer done()
		defer cancel()
		if forQueue {
			defer func() {
				s.prefetch.mu.Lock()
				delete(s.prefetch.queued, videoID)
				s.prefetch.mu.Unlock()
			}()
		}

		// Resolution is the expensive part, so it queues for a slot; a track
		// already resolved skips the queue.
		if !s.haveResolution(ctx, videoID) {
			if s.prefetch.yield(ctx) != nil {
				s.prefetch.unclaim(key)
				return
			}
			select {
			case s.prefetch.resolve <- struct{}{}:
			case <-ctx.Done():
				s.prefetch.unclaim(key)
				return
			}
			_, err := s.resolveSpeculative(ctx, videoID)
			<-s.prefetch.resolve
			if err != nil {
				if errors.Is(err, resolver.ErrRateLimited) {
					s.prefetch.backOff()
				}
				if errors.Is(err, context.Canceled) {
					// Gave way to a listener; still worth doing later.
					s.prefetch.unclaim(key)
					s.retryIfStillQueued(videoID, whole, forQueue)
				}
				return
			}
		}
		if err := s.fill(ctx, videoID, limit, true); err != nil {
			if errors.Is(err, context.Canceled) {
				s.prefetch.unclaim(key)
			}
			s.deps.Log.Debug("prefetch fill stopped", "video", videoID, "err", err)
		}
	}()
}

// startFill records that a download for a track is under way, from before
// it has resolved and taken the track until it ends — so a response that has
// caught up with the cache knows more is coming.
func (s *Server) startFill(videoID string) func() {
	v, _ := s.fills.LoadOrStore(videoID, new(atomic.Int32))
	n := v.(*atomic.Int32)
	n.Add(1)
	return func() { n.Add(-1) }
}

func (s *Server) fillActive(videoID string) bool {
	v, ok := s.fills.Load(videoID)
	return ok && v.(*atomic.Int32).Load() > 0
}

// awaitBytes waits until the cache holds more than have bytes of a track.
// False once no download is going to deliver them, or none has arrived for
// stallTimeout.
func (s *Server) awaitBytes(ctx context.Context, videoID string, have int64) bool {
	deadline := time.Now().Add(stallTimeout)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		wctx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		m, writing := s.deps.Audio.Wait(wctx, videoID, have)
		cancel()
		if m.Have > have {
			return true
		}
		if !writing && !s.fillActive(videoID) {
			return false
		}
	}
	return false
}

/*
retryIfStillQueued starts a queue download again after it gave way.

A click cancels the guesses in progress so the clicked track resolves alone,
and the next track in the queue is usually one of them. Nothing asked for it
again afterwards — the queue had not changed — so the track after the one
playing was never ready, and skipping to it waited on a cold resolve.
*/
func (s *Server) retryIfStillQueued(videoID string, whole, forQueue bool) {
	if !forQueue {
		return
	}
	time.AfterFunc(time.Second, func() {
		s.prefetch.mu.Lock()
		still := s.prefetch.wanted[videoID]
		s.prefetch.mu.Unlock()
		if still {
			s.prefetchTrack(videoID, whole, true)
		}
	})
}

// haveResolution is whether a track can be fetched without running yt-dlp.
func (s *Server) haveResolution(ctx context.Context, videoID string) bool {
	if _, ok := s.streams.get(videoID); ok {
		return true
	}
	_, ok := s.storedResolution(ctx, videoID)
	return ok
}

// fillPlaying brings the rest of the playing track onto disk, ahead of all
// speculative work: playback reads it as it arrives.
func (s *Server) fillPlaying(videoID string) {
	if s.deps.Audio == nil || s.deps.Resolver == nil {
		return
	}
	if m, ok := s.deps.Audio.Get(videoID); ok && m.Complete() {
		return
	}
	if !s.prefetch.claimNow(videoID + ":playing") {
		return
	}
	done := s.startFill(videoID)
	go func() {
		defer done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if err := s.fill(ctx, videoID, 0, false); err != nil {
			s.deps.Log.Debug("filling the playing track stopped", "video", videoID, "err", err)
			// Let the next request try again rather than wait out the minute.
			s.prefetch.unclaim(videoID + ":playing")
		}
	}()
}

// fill downloads a track into the cache, up to limit bytes (0 for all of
// it), continuing from whatever is already there. A speculative fill waits
// its turn and resolves as a guess; the playing track's does neither.
func (s *Server) fill(ctx context.Context, videoID string, limit int64, speculative bool) error {
	if speculative {
		select {
		case s.prefetch.fill <- struct{}{}:
			defer func() { <-s.prefetch.fill }()
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	e, err := s.resolve(ctx, videoID, speculative)
	if err != nil {
		return err
	}
	s.dropIfOtherFormat(videoID, e.stream.SizeBytes)

	w, err := s.acquireWriter(ctx, videoID, e, limit)
	if err != nil || w == nil {
		return err
	}
	defer func() { _ = w.Close() }()

	refusals, failures := 0, 0
	windowed := false
	for {
		off, size := w.Offset(), w.Size()
		if (size > 0 && off >= size) || (limit > 0 && off >= limit) {
			return nil
		}
		var status int
		if windowed {
			status, err = s.fillWindows(ctx, e.stream.URL, w, limit)
		} else {
			rng := fmt.Sprintf("bytes=%d-", off)
			if limit > 0 {
				rng = fmt.Sprintf("bytes=%d-%d", off, limit-1)
			}
			status, err = s.fillOnce(ctx, e.stream.URL, rng, w)
		}

		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case status == http.StatusForbidden:
			/*
			 * A refusal is either a URL that will not serve a whole file —
			 * the bounded windows every URL serves are the cheap answer — or
			 * a stale URL, which needs resolving again. Windows first, so a
			 * working URL never costs another yt-dlp run; a refusal there
			 * means stale.
			 */
			refusals++
			switch {
			case refusals > 3:
				return errors.New("upstream refused the track")
			case !windowed:
				windowed = true
			default:
				s.forgetResolution(videoID)
				if e, err = s.resolve(ctx, videoID, speculative); err != nil {
					return err
				}
				windowed = false
			}
			continue
		case status == http.StatusRequestedRangeNotSatisfiable:
			// Past the end: the stream is shorter than we were told.
			w.SetSize(off)
			return nil
		case err != nil:
			// A dropped or stalled connection: carry on from where it got to.
			failures++
			if failures > 5 {
				return err
			}
			select {
			case <-time.After(time.Duration(failures) * 400 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
			continue
		case status != http.StatusOK && status != http.StatusPartialContent:
			return fmt.Errorf("upstream answered %d", status)
		}
		if w.Offset() == off {
			failures++
			if failures > 5 {
				return errors.New("upstream sent nothing")
			}
		}
	}
}

// acquireWriter takes the track for writing. If another download holds it —
// a prefetched opening still arriving, say — it waits for that to finish
// and carries on from where it stopped, rather than leaving the rest of the
// track undownloaded. nil means there is nothing left to do.
func (s *Server) acquireWriter(ctx context.Context, videoID string, e resolvedEntry, limit int64) (*audiocache.Writer, error) {
	for {
		w, ok, err := s.deps.Audio.Writer(videoID, e.stream.MimeType, e.stream.SizeBytes)
		if err != nil || ok {
			return w, err
		}
		m, _ := s.deps.Audio.Get(videoID)
		if m.Complete() || (limit > 0 && m.Have >= limit) {
			return nil, nil
		}
		for s.deps.Audio.Writing(videoID) {
			m, _ = s.deps.Audio.Wait(ctx, videoID, m.Have)
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
		}
	}
}

// fillOnce makes one request for rng and writes what comes back. It reports
// the status, and an error when the transfer broke off.
func (s *Server) fillOnce(ctx context.Context, url, rng string, w *audiocache.Writer) (int, error) {
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	resp, err := s.fetchUpstream(rctx, url, rng)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()

	off := w.Offset()
	switch resp.StatusCode {
	case http.StatusPartialContent:
		start, total := parseContentRange(resp.Header.Get("Content-Range"))
		if start != off {
			return 0, fmt.Errorf("upstream answered from byte %d, not %d", start, off)
		}
		w.SetSize(total)
	case http.StatusOK:
		// The range was ignored: this is the whole file from the start.
		w.SetSize(resp.ContentLength)
		if off > 0 {
			if _, err := io.CopyN(io.Discard, resp.Body, off); err != nil {
				return 0, err
			}
		}
	default:
		return resp.StatusCode, nil
	}
	_, err = io.Copy(w, stallGuard(resp.Body, cancel))
	return resp.StatusCode, err
}

// fillWindows is the fallback for a URL that refuses whole-file requests:
// several 1 MiB windows at once, each written the moment it and everything
// before it has arrived. A window that fails loses only itself and what
// follows; what came before is already on disk.
func (s *Server) fillWindows(ctx context.Context, url string, w *audiocache.Writer, limit int64) (int, error) {
	off, size := w.Offset(), w.Size()
	if size <= 0 {
		// The length comes from the first answer.
		return s.fillOnce(ctx, url, fmt.Sprintf("bytes=%d-%d", off, off+streamWindow-1), w)
	}
	stop := size
	if limit > 0 && limit < stop {
		stop = limit
	}

	type result struct {
		body   []byte
		status int
		err    error
	}
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var results []chan result
	for from := off; from < stop && len(results) < fillParallel; from += streamWindow {
		to := min(from+streamWindow-1, stop-1)
		ch := make(chan result, 1)
		results = append(results, ch)
		go func() {
			resp, err := s.fetchUpstream(wctx, url, fmt.Sprintf("bytes=%d-%d", from, to))
			if err != nil {
				ch <- result{err: err}
				return
			}
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != http.StatusPartialContent {
				ch <- result{status: resp.StatusCode}
				return
			}
			body, err := io.ReadAll(stallGuard(resp.Body, cancel))
			if err == nil && int64(len(body)) != to-from+1 {
				err = fmt.Errorf("short window: %d of %d bytes", len(body), to-from+1)
			}
			ch <- result{body: body, status: resp.StatusCode, err: err}
		}()
	}
	for _, ch := range results {
		r := <-ch
		if r.err != nil {
			return 0, r.err
		}
		if r.status != http.StatusPartialContent {
			return r.status, nil
		}
		if _, err := w.Write(r.body); err != nil {
			return 0, err
		}
	}
	return http.StatusPartialContent, nil
}

// fillParallel is how many fallback windows are fetched at once.
const fillParallel = 4

// stallReader cancels its transfer once no byte has arrived for
// stallTimeout.
type stallReader struct {
	r     io.Reader
	timer *time.Timer
}

func stallGuard(r io.Reader, cancel context.CancelFunc) io.Reader {
	return &stallReader{r: r, timer: time.AfterFunc(stallTimeout, cancel)}
}

func (s *stallReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if n > 0 {
		s.timer.Reset(stallTimeout)
	}
	if err != nil {
		s.timer.Stop()
	}
	return n, err
}

// dropIfOtherFormat discards a cached opening that belongs to a different
// file from the one now resolved — another format, if the account's tier
// changed. Continuing it with the new file's bytes would splice two
// encodings into one broken track. The length tells them apart.
func (s *Server) dropIfOtherFormat(videoID string, size int64) {
	if m, ok := s.deps.Audio.Get(videoID); ok && size > 0 && m.Size > 0 && m.Size != size {
		s.deps.Audio.Drop(videoID)
	}
}

// parseContentRange reads "bytes 100-199/4096" into its start and total.
// A missing or unknown total is 0.
func parseContentRange(h string) (start, total int64) {
	spec, _ := strings.CutPrefix(strings.TrimSpace(h), "bytes ")
	span, tot, _ := strings.Cut(spec, "/")
	from, _, _ := strings.Cut(span, "-")
	start, _ = strconv.ParseInt(strings.TrimSpace(from), 10, 64)
	total, _ = strconv.ParseInt(strings.TrimSpace(tot), 10, 64)
	return start, total
}

/*
serveCached answers a stream request from disk when it can, and reports
whether it did.

A whole track is served outright. A track still downloading is served as it
arrives: the response follows the file as it grows, so a first play is one
transfer from upstream, not one for the player and another for the cache.
patience is how long a request may wait for a download to reach it — zero
serves only what is already here.
*/
func (s *Server) serveCached(w http.ResponseWriter, r *http.Request, videoID string, patience time.Duration) bool {
	c := s.deps.Audio
	if c == nil {
		return false
	}
	ctx := r.Context()
	m, ok := c.Get(videoID)
	writing := c.Writing(videoID)

	if patience > 0 && !writing && !m.Complete() {
		// A download just asked for starts on its own goroutine; give it a
		// moment to take the track.
		deadline := time.Now().Add(2 * time.Second)
		for !writing && s.fillActive(videoID) && time.Now().Before(deadline) && ctx.Err() == nil {
			time.Sleep(20 * time.Millisecond)
			m, ok = c.Get(videoID)
			writing = c.Writing(videoID)
		}
	}
	if !ok && !writing {
		return false
	}
	if m.Size <= 0 && writing && patience > 0 {
		// The length comes with the download's first answer.
		wctx, cancel := context.WithTimeout(ctx, patience)
		m, writing = c.Wait(wctx, videoID, m.Have)
		cancel()
	}
	if m.Size <= 0 {
		return false
	}

	start, end, ok := requestedRange(r.Header.Get("Range"), m.Size)
	if !ok {
		return false
	}
	if start >= m.Have {
		// Past what is here. Wait for the download if it will get there
		// soon; otherwise the caller fetches this part from upstream.
		if !writing || patience == 0 || start-m.Have > followAhead {
			if !m.Complete() && !writing {
				s.fillPlaying(videoID)
			}
			return false
		}
		wctx, cancel := context.WithTimeout(ctx, patience)
		for m.Have <= start && writing && wctx.Err() == nil {
			m, writing = c.Wait(wctx, videoID, m.Have)
		}
		cancel()
		if m.Have <= start {
			return false
		}
	}
	if !m.Complete() && !writing {
		// An opening from a prefetch: bring in the rest while it plays.
		s.fillPlaying(videoID)
	}

	f, _, err := c.Open(videoID)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()

	w.Header().Set("Content-Type", mimeOnly(m.MimeType))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, m.Size))
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusPartialContent)
	flusher, _ := w.(http.Flusher)

	pos := start
	for pos <= end {
		cur, _ := c.Get(videoID)
		if avail := min(cur.Have, end+1); avail > pos {
			n, err := io.Copy(w, io.NewSectionReader(f, pos, avail-pos))
			pos += n
			if err != nil {
				return true // the player went away: a seek, a skip
			}
			if flusher != nil {
				flusher.Flush()
			}
			continue
		}
		// Caught up with the download: wait for more of it.
		if s.awaitBytes(ctx, videoID, pos) {
			continue
		}
		if ctx.Err() != nil {
			return true
		}
		// The download stopped short of what was promised: finish the
		// response from upstream directly.
		s.relayRest(ctx, w, videoID, pos, end)
		return true
	}
	return true
}

// relayRest completes a response the cache could not, straight from
// upstream, in the bounded windows every URL serves.
func (s *Server) relayRest(ctx context.Context, w io.Writer, videoID string, pos, end int64) {
	retried := false
	for pos <= end {
		e, err := s.resolveCached(ctx, videoID)
		if err != nil {
			return
		}
		to := min(pos+streamWindow-1, end)
		rctx, cancel := context.WithCancel(ctx)
		resp, err := s.fetchUpstream(rctx, e.stream.URL, fmt.Sprintf("bytes=%d-%d", pos, to))
		if err != nil {
			cancel()
			return
		}
		if resp.StatusCode == http.StatusForbidden && !retried {
			_ = resp.Body.Close()
			cancel()
			s.forgetResolution(videoID)
			retried = true
			continue
		}
		if resp.StatusCode != http.StatusPartialContent {
			_ = resp.Body.Close()
			cancel()
			return
		}
		n, err := io.Copy(w, stallGuard(resp.Body, cancel))
		_ = resp.Body.Close()
		cancel()
		pos += n
		if err != nil || n == 0 {
			return
		}
	}
}

// requestedRange reads a client's Range against a known size. No Range, or
// an open end, runs to the end of the file.
func requestedRange(h string, size int64) (start, end int64, ok bool) {
	end = size - 1
	if h == "" {
		return 0, end, true
	}
	spec, found := strings.CutPrefix(strings.TrimSpace(h), "bytes=")
	if !found || strings.Contains(spec, ",") {
		return 0, 0, false
	}
	from, to, _ := strings.Cut(spec, "-")
	from, to = strings.TrimSpace(from), strings.TrimSpace(to)
	if from == "" {
		// A suffix range: the last N bytes.
		n, err := strconv.ParseInt(to, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		if n > size {
			n = size
		}
		return size - n, size - 1, true
	}
	start, err := strconv.ParseInt(from, 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	if to != "" {
		if e, err := strconv.ParseInt(to, 10, 64); err == nil && e >= start && e < end {
			end = e
		}
	}
	return start, end, true
}

// mimeOnly drops the codecs parameter, which a Content-Type does not need
// and yt-dlp's quoting can garble.
func mimeOnly(m string) string {
	if m == "" {
		return "audio/webm"
	}
	base, _, _ := strings.Cut(m, ";")
	return strings.TrimSpace(base)
}

// handlePrefetch readies tracks the listener is likely to play next.
// Answers at once; the work happens in the background.
func (s *Server) handlePrefetch(w http.ResponseWriter, r *http.Request) {
	s.Prefetch(r.PathValue("id"), r.URL.Query().Get("whole") == "1")
	w.WriteHeader(http.StatusAccepted)
}

// handleCache reports the cache's size, and clears it on DELETE.
func (s *Server) handleCache(w http.ResponseWriter, r *http.Request) {
	if s.deps.Audio == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "cache unavailable"})
		return
	}
	if r.Method == http.MethodDelete {
		s.deps.Audio.Clear()
	}
	if id := r.URL.Query().Get("id"); id != "" {
		m, _ := s.deps.Audio.Get(id)
		s.write(w, http.StatusOK, map[string]any{"have": m.Have, "size": m.Size, "complete": m.Complete()})
		return
	}
	bytes, tracks := s.deps.Audio.Usage()
	s.write(w, http.StatusOK, map[string]any{"bytes": bytes, "tracks": tracks})
}
