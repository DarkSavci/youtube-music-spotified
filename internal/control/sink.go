package control

import (
	"context"
	"log/slog"

	"spotifier/internal/session"
)

// Sink persists play-log entries emitted by the session core.
//
// The core produces entries but performs no I/O; this adapter is where they
// become rows. Failures are logged rather than returned: losing a listening
// record is regrettable, but it must never interrupt playback.
type Sink struct {
	store *Store
	log   *slog.Logger
}

func NewSink(store *Store, log *slog.Logger) *Sink {
	if log == nil {
		log = slog.Default()
	}
	return &Sink{store: store, log: log}
}

var _ session.LogSink = (*Sink)(nil)

func (s *Sink) Record(ctx context.Context, entries []session.LogEntry) {
	if s.store == nil || len(entries) == 0 {
		return
	}
	plays := make([]Play, 0, len(entries))
	for _, e := range entries {
		plays = append(plays, Play{
			// The core does not mint identifiers, so one is derived from the
			// track and instant. Two entries for the same track at the same
			// millisecond would be the same listen anyway, which keeps the
			// write idempotent.
			EventUUID:  e.TrackID + "@" + e.At.UTC().Format("20060102T150405.000"),
			TrackID:    e.TrackID,
			Title:      e.Title,
			ArtistID:   e.ArtistID,
			Artist:     e.Artist,
			AlbumID:    e.AlbumID,
			Album:      e.Album,
			PlayedMs:   e.PlayedMs,
			Completed:  e.Completed,
			Failed:     e.Failed,
			FailReason: e.FailReason,
			Origin:     e.Origin,
			PlayedAt:   e.At,
			Artwork:    e.Artwork,
		})
	}
	if err := s.store.RecordPlays(ctx, DefaultUserID, plays); err != nil {
		s.log.Warn("play log write failed", "entries", len(plays), "err", err)
	}
}
