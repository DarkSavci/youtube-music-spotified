package loudness

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type slowCaller struct{ calls atomic.Int32 }

func (c *slowCaller) Call(context.Context, string, map[string]any) (json.RawMessage, error) {
	c.calls.Add(1)
	time.Sleep(100 * time.Millisecond)
	return json.RawMessage(`{"playerConfig":{"audioConfig":{"trackAbsoluteLoudnessLkfs":-9.5}}}`), nil
}

// Both decks and the relay can ask about the same track at once; that is
// one lookup, not three.
func TestConcurrentLookupsShareOneCall(t *testing.T) {
	c := &slowCaller{}
	s := &Service{Client: c}
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if v, err := s.For(context.Background(), "abc"); err != nil || v != -9.5 {
				t.Errorf("got %v %v", v, err)
			}
		}()
	}
	wg.Wait()
	if n := c.calls.Load(); n != 1 {
		t.Fatalf("%d upstream calls for one track", n)
	}
}
