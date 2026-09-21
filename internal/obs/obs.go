// Package obs carries structured logging and the counters behind the
// parser-health panel.
//
// Renderer-node rot is this project's standing operational risk: YouTube
// changes response shapes without notice, and a parser that silently drops an
// unrecognised node turns that into "the home page looks wrong" weeks later.
// Counting unknown nodes at the point of parsing turns it instead into "three
// unknown node types appeared on FEmusic_home this week".
package obs

import (
	"sort"
	"sync"
	"time"
)

// UnknownNode records one encounter with a renderer node type no parser
// handles.
type UnknownNode struct {
	// Surface is the browse surface or endpoint it appeared on, e.g.
	// "FEmusic_home" or "search".
	Surface string `json:"surface"`

	// Type is the renderer node key, e.g. "musicCardShelfRenderer".
	Type string `json:"type"`

	Count     int       `json:"count"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
}

type key struct{ surface, typ string }

// Recorder accumulates parser-health signal. Safe for concurrent use.
type Recorder struct {
	mu      sync.Mutex
	unknown map[key]*UnknownNode
	now     func() time.Time
}

// NewRecorder builds an empty Recorder.
func NewRecorder() *Recorder {
	return &Recorder{unknown: map[key]*UnknownNode{}, now: time.Now}
}

// UnknownRenderer notes that a parser met a node type it does not handle.
//
// This is deliberately not an error. An unrecognised node means we render less
// than we could, not that anything is broken — so parsing continues and the
// signal accumulates for later inspection.
func (r *Recorder) UnknownRenderer(surface, nodeType string) {
	if r == nil || surface == "" || nodeType == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	k := key{surface, nodeType}
	now := r.now()
	if e, ok := r.unknown[k]; ok {
		e.Count++
		e.LastSeen = now
		return
	}
	r.unknown[k] = &UnknownNode{
		Surface: surface, Type: nodeType, Count: 1,
		FirstSeen: now, LastSeen: now,
	}
}

// UnknownNodes returns the accumulated signal, most frequent first. This is
// what the parser-health panel renders.
func (r *Recorder) UnknownNodes() []UnknownNode {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	out := make([]UnknownNode, 0, len(r.unknown))
	for _, e := range r.unknown {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if out[i].Surface != out[j].Surface {
			return out[i].Surface < out[j].Surface
		}
		return out[i].Type < out[j].Type
	})
	return out
}

// Reset clears accumulated signal. Used by tests and by the diagnostics UI.
func (r *Recorder) Reset() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.unknown = map[key]*UnknownNode{}
}
