// Package audiocache keeps tracks' audio on disk.
//
// Starting a track means resolving it first, and resolving through yt-dlp
// takes four to five seconds. Spotify's answer to the same problem is a local
// cache: most plays start from disk, and one that is not cached starts from a
// short leading chunk while the rest follows. This is that.
//
// A track is stored as a single file that grows from the front. It may hold
// the whole track, or only its opening — a prefetched prefix, enough to start
// playing at once while the rest is resolved. Which bytes are present is
// recorded beside it.
package audiocache

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Meta describes one cached track.
type Meta struct {
	MimeType string `json:"mimeType"`
	// Size is the whole stream's length, 0 until it is known.
	Size int64 `json:"size"`
	// Have is how many leading bytes are on disk.
	Have   int64     `json:"have"`
	UsedAt time.Time `json:"usedAt"`
}

// Complete is whether the whole track is on disk.
func (m Meta) Complete() bool { return m.Size > 0 && m.Have >= m.Size }

// Cache is a size-capped store of track audio. Safe for concurrent use.
type Cache struct {
	dir string

	mu      sync.Mutex
	max     int64
	metas   map[string]*Meta
	writing map[string]bool
	// used is the bytes on disk, kept as it changes so a write can check the
	// cap without adding everything up.
	used int64
	// changed is closed and replaced whenever any track grows or a writer
	// finishes, which is what lets a reader follow a download in progress.
	changed chan struct{}
}

// validID admits YouTube video ids only, which also keeps every path inside
// the cache directory.
var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)

// ErrBadID is returned for an id that cannot be a track.
var ErrBadID = errors.New("audiocache: invalid track id")

// New opens the cache in dir, creating it, and reads what is already there.
func New(dir string, maxBytes int64) (*Cache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	c := &Cache{dir: dir, max: maxBytes, metas: map[string]*Meta{}, writing: map[string]bool{},
		changed: make(chan struct{})}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		// Audio with no record is a write that never finished.
		if id, ok := strings.CutSuffix(e.Name(), ".audio"); ok {
			if _, err := os.Stat(c.metaPath(id)); err != nil {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
			continue
		}
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !validID.MatchString(id) {
			continue
		}
		raw, err := os.ReadFile(c.metaPath(id))
		var m Meta
		if err != nil || json.Unmarshal(raw, &m) != nil {
			c.remove(id)
			continue
		}
		// Trust the file over the record: a write cut short by a crash leaves
		// the record claiming bytes that never landed.
		info, err := os.Stat(c.dataPath(id))
		if err != nil {
			c.remove(id)
			continue
		}
		if info.Size() < m.Have {
			m.Have = info.Size()
		}
		c.metas[id] = &m
		c.used += m.Have
	}
	c.mu.Lock()
	c.evictLocked()
	c.mu.Unlock()
	return c, nil
}

func (c *Cache) dataPath(id string) string { return filepath.Join(c.dir, id+".audio") }
func (c *Cache) metaPath(id string) string { return filepath.Join(c.dir, id+".json") }

func (c *Cache) remove(id string) {
	_ = os.Remove(c.dataPath(id))
	_ = os.Remove(c.metaPath(id))
}

// Get reports what is cached for a track.
func (c *Cache) Get(id string) (Meta, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, ok := c.metas[id]
	if !ok || m.Have == 0 {
		return Meta{}, false
	}
	return *m, true
}

// Open returns the cached file for reading and marks the track used. The
// caller reads only within the Meta's Have.
func (c *Cache) Open(id string) (*os.File, Meta, error) {
	if !validID.MatchString(id) {
		return nil, Meta{}, ErrBadID
	}
	c.mu.Lock()
	m, ok := c.metas[id]
	if !ok {
		c.mu.Unlock()
		return nil, Meta{}, os.ErrNotExist
	}
	m.UsedAt = time.Now()
	snapshot := *m
	if !c.writing[id] {
		// Remembered across restarts, so eviction keeps what is played.
		c.saveLocked(id)
	}
	c.mu.Unlock()

	f, err := os.Open(c.dataPath(id))
	if err != nil {
		return nil, Meta{}, err
	}
	return f, snapshot, nil
}

// SetMax changes the size cap, evicting straight away if it shrank.
func (c *Cache) SetMax(maxBytes int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.max = maxBytes
	c.evictLocked()
}

// Usage is the bytes on disk and the number of tracks holding them.
func (c *Cache) Usage() (bytes int64, tracks int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, m := range c.metas {
		bytes += m.Have
		tracks++
	}
	return bytes, tracks
}

// Drop removes one track, unless it is being written.
func (c *Cache) Drop(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.metas[id]; ok && !c.writing[id] {
		c.forgetLocked(id)
	}
}

// Clear removes every track not being written right now.
func (c *Cache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id := range c.metas {
		if !c.writing[id] {
			c.forgetLocked(id)
		}
	}
}

// evictLocked drops the least recently used tracks until the cache fits.
func (c *Cache) evictLocked() {
	if c.used <= c.max {
		return
	}
	var total int64
	ids := make([]string, 0, len(c.metas))
	for id, m := range c.metas {
		total += m.Have
		ids = append(ids, id)
	}
	if total <= c.max {
		return
	}
	sort.Slice(ids, func(i, j int) bool { return c.metas[ids[i]].UsedAt.Before(c.metas[ids[j]].UsedAt) })
	for _, id := range ids {
		if total <= c.max {
			return
		}
		if c.writing[id] {
			continue
		}
		total -= c.metas[id].Have
		c.forgetLocked(id)
	}
}

// Writer appends a track's bytes. One per track at a time.
type Writer struct {
	c  *Cache
	id string
	f  *os.File
}

// Writer starts or resumes filling a track. ok is false when the track is
// already whole or someone else is filling it.
func (c *Cache) Writer(id, mimeType string, size int64) (*Writer, bool, error) {
	if !validID.MatchString(id) {
		return nil, false, ErrBadID
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.writing[id] {
		return nil, false, nil
	}
	m, ok := c.metas[id]
	if ok && m.Complete() {
		return nil, false, nil
	}
	f, err := os.OpenFile(c.dataPath(id), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, false, err
	}
	if !ok {
		m = &Meta{}
		c.metas[id] = m
	}
	if mimeType != "" {
		m.MimeType = mimeType
	}
	if size > 0 {
		m.Size = size
	}
	m.UsedAt = time.Now()
	// Anything past Have is an unrecorded tail from an interrupted write.
	if err := f.Truncate(m.Have); err != nil {
		_ = f.Close()
		return nil, false, err
	}
	if _, err := f.Seek(m.Have, io.SeekStart); err != nil {
		_ = f.Close()
		return nil, false, err
	}
	c.writing[id] = true
	return &Writer{c: c, id: id, f: f}, true, nil
}

// Offset is where the next byte goes: the length already cached.
func (w *Writer) Offset() int64 {
	w.c.mu.Lock()
	defer w.c.mu.Unlock()
	return w.c.metas[w.id].Have
}

// Size is the whole stream's length, 0 if not yet known.
func (w *Writer) Size() int64 {
	w.c.mu.Lock()
	defer w.c.mu.Unlock()
	return w.c.metas[w.id].Size
}

// SetSize records the stream's length once upstream reports it.
func (w *Writer) SetSize(n int64) {
	w.c.mu.Lock()
	defer w.c.mu.Unlock()
	if n > 0 {
		w.c.metas[w.id].Size = n
	}
}

// Write appends to the track. Readers see the bytes as soon as it returns.
func (w *Writer) Write(p []byte) (int, error) {
	n, err := w.f.Write(p)
	w.c.mu.Lock()
	w.c.metas[w.id].Have += int64(n)
	w.c.used += int64(n)
	// Evict as the cache fills, not only once a download ends: a long track
	// would otherwise carry it well past its cap.
	w.c.evictLocked()
	w.c.notifyLocked()
	w.c.mu.Unlock()
	return n, err
}

// Close records what was written and releases the track.
func (w *Writer) Close() error {
	err := w.f.Close()
	w.c.mu.Lock()
	defer w.c.mu.Unlock()
	delete(w.c.writing, w.id)
	w.c.notifyLocked()
	m := w.c.metas[w.id]
	if m.Have == 0 {
		w.c.forgetLocked(w.id)
		return err
	}
	if werr := w.c.saveLocked(w.id); werr != nil && err == nil {
		err = werr
	}
	w.c.evictLocked()
	return err
}

// forgetLocked removes a track from disk and from the books.
func (c *Cache) forgetLocked(id string) {
	if m, ok := c.metas[id]; ok {
		c.used -= m.Have
	}
	c.remove(id)
	delete(c.metas, id)
}

func (c *Cache) notifyLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}

// Writing reports whether a track is being downloaded right now.
func (c *Cache) Writing(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.writing[id]
}

// Wait blocks until a track holds more than have bytes, learns its size, or
// stops being written — or ctx ends. It returns the track's state then, and
// whether a writer is still at work on it.
func (c *Cache) Wait(ctx context.Context, id string, have int64) (Meta, bool) {
	for {
		c.mu.Lock()
		m, ok := c.metas[id]
		var snapshot Meta
		if ok {
			snapshot = *m
		}
		writing := c.writing[id]
		changed := c.changed
		c.mu.Unlock()
		if !writing || snapshot.Have > have {
			return snapshot, writing
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return snapshot, writing
		}
	}
}

func (c *Cache) saveLocked(id string) error {
	raw, err := json.Marshal(c.metas[id])
	if err != nil {
		return err
	}
	return os.WriteFile(c.metaPath(id), raw, 0o600)
}
