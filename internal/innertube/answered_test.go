package innertube

import (
	"testing"
	"time"
)

// Any status from YouTube is an answer, and tells the hook; a call that
// received nothing does not.
func TestAnsweredHookHearsAnyStatus(t *testing.T) {
	n := 0
	OnAnswered(func(time.Time) { n++ })
	defer OnAnswered(nil)
	observe(CallRecord{Status: 200})
	observe(CallRecord{Status: 429})
	observe(CallRecord{Status: 0})
	if n != 2 {
		t.Fatalf("hook heard %d answers, want 2", n)
	}
}
