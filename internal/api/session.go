package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/session"
)

/*
Session transport.

Projections stream to clients over Server-Sent Events; commands arrive as
ordinary POSTs. The split matches the traffic: state is one-way server push,
and control is request/response.

SSE rather than a WebSocket because it needs no dependency, survives proxies,
and reconnects on its own — a browser re-establishes a dropped EventSource
without any code from us. Since every projection is a complete snapshot, a
reconnect needs no replay: the first message after reconnecting is current
state.

This is the same transport whether the far end is the local sidecar or, later,
another Device. The single-device case is the degenerate multi-device case.
*/

// handleSessionRegister announces a Device and returns its first projection.
func (s *Server) handleSessionRegister(w http.ResponseWriter, r *http.Request) {
	if s.deps.Session == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "session unavailable"})
		return
	}
	var body struct {
		DeviceID     string               `json:"deviceId"`
		Name         string               `json:"name"`
		Capabilities session.Capabilities `json:"capabilities"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DeviceID == "" {
		s.write(w, http.StatusBadRequest, apiError{Error: "deviceId required"})
		return
	}
	if body.Name == "" {
		body.Name = "This device"
	}
	dev := s.deps.Session.Register(body.DeviceID, body.Name, body.Capabilities)
	s.write(w, http.StatusOK, map[string]any{
		"device":     dev,
		"projection": s.deps.Session.Projection(),
	})
}

// handleSessionCommand applies an intent.
//
// A rejection is a normal outcome, not an error: the command was understood
// and declined, so it returns 200 with a reason rather than a failure status
// the client would have to interpret.
func (s *Server) handleSessionCommand(w http.ResponseWriter, r *http.Request) {
	if s.deps.Session == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "session unavailable"})
		return
	}
	var body struct {
		DeviceID string          `json:"deviceId"`
		Command  session.Command `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	reject, err := s.deps.Session.Command(r.Context(), body.DeviceID, body.Command)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.logCommand(body.Command, reject)
	s.write(w, http.StatusOK, map[string]any{
		"rejected":   string(reject),
		"projection": s.deps.Session.Projection(),
	})
}

// handleSessionEngineEvent folds a report from a Device's playback engine.
func (s *Server) handleSessionEngineEvent(w http.ResponseWriter, r *http.Request) {
	if s.deps.Session == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "session unavailable"})
		return
	}
	var body struct {
		DeviceID string              `json:"deviceId"`
		Event    session.EngineEvent `json:"event"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if body.Event.Kind == session.EvPosition {
		s.deps.Session.EngineEvent(r.Context(), body.DeviceID, body.Event)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	before := s.deps.Session.Projection().State
	s.deps.Session.EngineEvent(r.Context(), body.DeviceID, body.Event)
	s.logEngineEvent(body.Event, before, s.deps.Session.Projection().State)
	w.WriteHeader(http.StatusNoContent)
}

/*
logCommand records what the listener asked for.

The log a user sends is read backwards from a symptom — "it played the wrong
song", "it stopped" — and the first question is always what was pressed. The
frequent, uninteresting commands (volume, seek) stay at debug.
*/
func (s *Server) logCommand(cmd session.Command, reject session.Reject) {
	attrs := []any{"kind", cmd.Kind}
	if reject != session.RejectNone {
		attrs = append(attrs, "rejected", reject)
	}
	switch cmd.Kind {
	case session.CmdPlay:
		attrs = append(attrs, "tracks", len(cmd.Tracks), "start", cmd.StartIndex, "origin", cmd.Origin)
		if cmd.StartIndex >= 0 && cmd.StartIndex < len(cmd.Tracks) {
			t := cmd.Tracks[cmd.StartIndex]
			attrs = append(attrs, "video", t.ID, "title", t.Title)
		}
	case session.CmdSeek:
		s.deps.Log.Debug("session command", append(attrs, "ms", cmd.PositionMs)...)
		return
	case session.CmdSetVolume:
		s.deps.Log.Debug("session command", append(attrs, "volume", cmd.Volume)...)
		return
	}
	s.deps.Log.Info("session command", attrs...)
}

/*
logEngineEvent records what a device's player reported, and what the core did
about it.

A failure is logged with the track it was about, and the outcome is spelled
out when the core gave up: three failures in a row stop playback, and without
this line a log shows three errors and then silence.
*/
func (s *Server) logEngineEvent(ev session.EngineEvent, before, after domain.Session) {
	attrs := []any{"kind", ev.Kind, "epoch", ev.Epoch}
	if ev.Reason != "" {
		attrs = append(attrs, "reason", ev.Reason)
	}
	if t := before.Queue.Current(); t != nil {
		attrs = append(attrs, "index", before.Queue.Index, "video", t.ID, "title", t.Title)
	}
	if ev.Epoch != before.Epoch {
		// Reported against a track already replaced; the core ignores it.
		attrs = append(attrs, "stale", true)
	}
	switch ev.Kind {
	case session.EvFailed:
		s.deps.Log.Warn("track failed", attrs...)
		if after.State == domain.StatePaused && before.State != domain.StatePaused {
			s.deps.Log.Warn("playback stopped after a failure", "failedInQueue", len(after.Degraded))
		}
	case session.EvBlocked, session.EvStalled:
		s.deps.Log.Warn("playback "+string(ev.Kind), attrs...)
	default:
		s.deps.Log.Info("engine "+string(ev.Kind), attrs...)
	}
}

// handleSessionCapabilities records what a Device's engine can do, which may
// change mid-session when an engine falls back.
func (s *Server) handleSessionCapabilities(w http.ResponseWriter, r *http.Request) {
	if s.deps.Session == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "session unavailable"})
		return
	}
	var body struct {
		DeviceID     string               `json:"deviceId"`
		Capabilities session.Capabilities `json:"capabilities"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if err := s.deps.Session.SetCapabilities(body.DeviceID, body.Capabilities); err != nil {
		s.write(w, http.StatusNotFound, apiError{Error: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSessionEvents streams projections until the client disconnects.
func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	if s.deps.Session == nil {
		http.Error(w, "session unavailable", http.StatusServiceUnavailable)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		// Without flushing, events would buffer until the response closed,
		// which for an endless stream means never arriving.
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Proxies that buffer would defeat the point of a stream.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	projections, cancel := s.deps.Session.Subscribe()
	defer cancel()

	// A Device that disconnects without unregistering — a crash, a closed lid —
	// must not keep ownership forever.
	deviceID := r.URL.Query().Get("deviceId")
	if deviceID != "" {
		defer s.deps.Session.Unregister(deviceID)
	}

	// Keep-alive comments stop idle intermediaries closing the connection.
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return

		case p, open := <-projections:
			if !open {
				return
			}
			payload, err := json.Marshal(p)
			if err != nil {
				s.deps.Log.Warn("session projection encode", "err", err)
				continue
			}
			fmt.Fprintf(w, "event: projection\ndata: %s\n\n", payload)
			flusher.Flush()

		case <-ticker.C:
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

// handleSessionSnapshot returns current state without subscribing, for a
// client that only needs to render once.
func (s *Server) handleSessionSnapshot(w http.ResponseWriter, r *http.Request) {
	if s.deps.Session == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "session unavailable"})
		return
	}
	s.write(w, http.StatusOK, s.deps.Session.Projection())
}

/*
handleSessionSettings applies the user's playback settings.

Crossfade length and gapless belong to the session rather than to a device:
the core decides each transition, and a handoff mid-song should not change how
the next one sounds. Sending them here is what makes the Settings screen do
something — they were previously fixed when the process started.
*/
func (s *Server) handleSessionSettings(w http.ResponseWriter, r *http.Request) {
	if s.deps.Session == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "session unavailable"})
		return
	}
	var body struct {
		CrossfadeMs int  `json:"crossfadeMs"`
		Gapless     bool `json:"gapless"`
		// Pointer so that a client which does not send it leaves the setting
		// alone, rather than turning it off by omission.
		ResumeOnLaunch *bool `json:"resumeOnLaunch"`
		// Likewise a pointer: not sending it must not switch it off.
		ReportToYouTube *bool `json:"reportToYouTube"`
		// The audio cache's cap in megabytes; absent leaves it alone.
		CacheMaxMB *int64 `json:"cacheMaxMB"`
		// Whether the queue carries on with a radio once it runs low.
		Autoplay *bool `json:"autoplay"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	s.deps.Session.SetSettings(body.CrossfadeMs, body.Gapless)

	// Remembering the queue is a session property too: it is the session's
	// own state being written down, and the core is what writes it.
	if body.ResumeOnLaunch != nil && s.deps.Resume != nil {
		s.deps.Resume.SetEnabled(r.Context(), *body.ResumeOnLaunch)
	}
	if body.ReportToYouTube != nil && s.deps.Report != nil {
		s.deps.Report.SetEnabled(*body.ReportToYouTube)
	}
	if body.Autoplay != nil {
		s.SetAutoplay(*body.Autoplay)
	}
	if body.CacheMaxMB != nil && *body.CacheMaxMB > 0 && s.deps.Audio != nil {
		s.deps.Audio.SetMax(*body.CacheMaxMB << 20)
	}
	s.write(w, http.StatusOK, s.deps.Session.Projection())
}
