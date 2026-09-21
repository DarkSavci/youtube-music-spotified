package loudness

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// stub answers one endpoint with a canned body and counts the calls.
type stub struct {
	body  json.RawMessage
	err   error
	calls int
}

func (s *stub) Call(context.Context, string, map[string]any) (json.RawMessage, error) {
	s.calls++
	return s.body, s.err
}

func fixture(t *testing.T) json.RawMessage {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "fixtures", "player.json"))
	if err != nil {
		t.Skipf("player fixture not recorded: %v", err)
	}
	return b
}

// The figure is in a real player response, which is the claim this whole
// package rests on.
func TestLoudnessComesFromTheRealResponse(t *testing.T) {
	c := &stub{body: fixture(t)}
	got, err := (&Service{Client: c}).For(context.Background(), "zKSsP2084nU")
	if err != nil {
		t.Fatalf("loudness: %v", err)
	}
	if math.Abs(got-(-12.35)) > 0.001 {
		t.Fatalf("got %v LKFS, want -12.35 from the fixture", got)
	}
}

// A response without the absolute figure still normalises, so the gain and
// target it does carry have to reconstruct it.
func TestLoudnessDerivedFromGainAndTarget(t *testing.T) {
	c := &stub{body: json.RawMessage(
		`{"playerConfig":{"audioConfig":{"loudnessDb":-5.35,"loudnessTargetLkfs":-7}}}`)}
	got, err := (&Service{Client: c}).For(context.Background(), "x")
	if err != nil {
		t.Fatalf("loudness: %v", err)
	}
	if math.Abs(got-(-12.35)) > 0.001 {
		t.Fatalf("got %v LKFS, want -12.35 derived from the gain and target", got)
	}
}

// Silence about loudness is not a failure to play.
func TestLoudnessAbsentIsNotAnError(t *testing.T) {
	c := &stub{body: json.RawMessage(`{"playerConfig":{"audioConfig":{}}}`)}
	_, err := (&Service{Client: c}).For(context.Background(), "x")
	if !errors.Is(err, ErrUnknown) {
		t.Fatalf("got %v, want ErrUnknown", err)
	}
}

// Loudness is a property of the recording, so asking twice must not cost two
// round trips — this runs once per track at resolve time.
func TestLoudnessIsRemembered(t *testing.T) {
	c := &stub{body: fixture(t)}
	s := &Service{Client: c}
	for i := 0; i < 5; i++ {
		if _, err := s.For(context.Background(), "same"); err != nil {
			t.Fatalf("loudness: %v", err)
		}
	}
	if c.calls != 1 {
		t.Fatalf("made %d calls for one track, want 1", c.calls)
	}
}

/*
The gain is the difference from the target, and it is bounded.

A quiet track is lifted and a loud one cut, but only so far: the clamp is what
stops a bad reading from arriving as a jolt.
*/
func TestGainIsTheDifferenceAndIsBounded(t *testing.T) {
	cases := []struct {
		name         string
		track, want  float64
		targetIsLoud bool
	}{
		{name: "loud track is cut", track: -5, want: -9},
		{name: "quiet track is lifted", track: -20, want: 6},
		{name: "already at target", track: -14, want: 0},
		{name: "absurdly quiet is clamped", track: -80, want: 12},
		{name: "absurdly loud is clamped", track: 40, want: -12},
	}
	const target = -14.0
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := GainDb(c.track, target); math.Abs(got-c.want) > 0.001 {
				t.Fatalf("track %v LKFS toward %v: got %v dB, want %v", c.track, target, got, c.want)
			}
		})
	}
}
