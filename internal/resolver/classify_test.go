package resolver

import (
	"errors"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		msg                  string
		rateLimited, unavail bool
	}{
		{"ERROR: [youtube] x: Sign in to confirm you're not a bot", true, false},
		{"HTTP Error 429: Too Many Requests", true, false},
		{"ERROR: [youtube] x: This content isn't available, try again later.", true, false},
		{"ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.", false, true},
		{"ERROR: [youtube] x: Requested format is not available", false, false},
		{"ERROR: [youtube] x: Video unavailable", false, true},
		{"ERROR: [youtube] x: Private video", false, true},
	}
	for _, c := range cases {
		err := classify(errors.New(c.msg))
		if got := errors.Is(err, ErrRateLimited); got != c.rateLimited {
			t.Errorf("%q: rate limited = %v", c.msg, got)
		}
		if got := errors.Is(err, ErrUnavailable); got != c.unavail {
			t.Errorf("%q: unavailable = %v", c.msg, got)
		}
	}
}
