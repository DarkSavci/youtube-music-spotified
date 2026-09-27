package identity

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"

	"spotifier/internal/innertube"
	"spotifier/internal/obs"
)

// upstream stands in for YouTube: every InnerTube call is recorded and
// answered from answers, by endpoint.
type upstream struct {
	mu    sync.Mutex
	calls []call
}

type call struct {
	endpoint string
	body     map[string]any
}

func (u *upstream) client(t *testing.T, answers map[string]string) *innertube.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/youtubei/v1/") {
			// The client's version, read once from the page.
			_, _ = io.WriteString(w, `{"INNERTUBE_CLIENT_VERSION":"1.20260901.01.00"}`)
			return
		}
		endpoint := strings.TrimPrefix(r.URL.Path, "/youtubei/v1/")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		u.mu.Lock()
		u.calls = append(u.calls, call{endpoint, body})
		u.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		answer, ok := answers[endpoint]
		if !ok {
			answer = `{}`
		}
		_, _ = io.WriteString(w, answer)
	}))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	h := &http.Client{Transport: redirect{target}}
	return innertube.New(innertube.WithHTTPClient(h),
		innertube.WithCredentials(&innertube.Credentials{Cookie: "SAPISID=abc; LOGIN_INFO=xyz"}))
}

// redirect sends every request to the test server, whatever host it named.
type redirect struct{ to *url.URL }

func (r redirect) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.URL.Scheme, req.URL.Host = r.to.Scheme, r.to.Host
	return http.DefaultTransport.RoundTrip(req)
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("../../testdata/fixtures/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSearchHistoryAsksWhatTheWebsiteAsks(t *testing.T) {
	var u upstream
	id := NewInnerTube(u.client(t, map[string]string{
		"music/get_search_suggestions": fixture(t, "search_history"),
	}), nil)
	got, err := id.SearchHistory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Query != "daft punk" || got[0].Token != "TOKEN_DAFT_PUNK" {
		t.Fatalf("got %+v", got)
	}
	if len(u.calls) != 1 || u.calls[0].endpoint != "music/get_search_suggestions" {
		t.Fatalf("calls %+v", u.calls)
	}
	if in, ok := u.calls[0].body["input"]; !ok || in != "" {
		t.Fatalf("input = %#v, want the empty string", in)
	}
}

func TestForgettingASearchSendsItsFeedbackToken(t *testing.T) {
	var u upstream
	id := NewInnerTube(u.client(t, nil), nil)
	if err := id.ForgetSearches(context.Background(), []string{"TOKEN_A", "", "TOKEN_B"}); err != nil {
		t.Fatal(err)
	}
	if len(u.calls) != 1 || u.calls[0].endpoint != "feedback" {
		t.Fatalf("calls %+v", u.calls)
	}
	tokens, _ := u.calls[0].body["feedbackTokens"].([]any)
	if len(tokens) != 2 || tokens[0] != "TOKEN_A" || tokens[1] != "TOKEN_B" {
		t.Fatalf("feedbackTokens = %#v", u.calls[0].body["feedbackTokens"])
	}
	if err := id.ForgetSearches(context.Background(), []string{""}); err == nil {
		t.Fatal("no token, yet something was sent")
	}
	if len(u.calls) != 1 {
		t.Fatal("an empty removal reached YouTube")
	}
}

func TestRemoteQueueAsksForTheAccountsQueue(t *testing.T) {
	var u upstream
	rec := obs.NewRecorder()
	id := NewInnerTube(u.client(t, map[string]string{"next": fixture(t, "remote_queue")}), rec)
	q, ok, err := id.RemoteQueue(context.Background())
	if err != nil || !ok {
		t.Fatalf("ok=%t err=%v", ok, err)
	}
	if len(q.Tracks) != 3 || q.Index != 1 {
		t.Fatalf("got %d tracks at %d", len(q.Tracks), q.Index)
	}
	if len(u.calls) != 1 || u.calls[0].endpoint != "next" {
		t.Fatalf("calls %+v", u.calls)
	}
	body := u.calls[0].body
	if body["watchNextType"] != "WATCH_NEXT_TYPE_GET_QUEUE" || body["queueContextParams"] != "" {
		t.Fatalf("body %v", body)
	}
	if _, has := body["videoId"]; has {
		t.Fatal("asked about a video rather than for the queue")
	}
}

func TestAccountReadsNeedASignedInSession(t *testing.T) {
	signedOut := NewInnerTube(innertube.New(), nil)
	if _, err := signedOut.SearchHistory(context.Background()); !errors.Is(err, ErrLoggedOut) {
		t.Fatalf("history: %v", err)
	}
	if _, _, err := signedOut.RemoteQueue(context.Background()); !errors.Is(err, ErrLoggedOut) {
		t.Fatalf("queue: %v", err)
	}
}
