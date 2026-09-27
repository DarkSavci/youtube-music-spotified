package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"spotifier/internal/account"
	"spotifier/internal/api"
	"spotifier/internal/clock"
	"spotifier/internal/domain"
	"spotifier/internal/innertube"
	"spotifier/internal/library"
)

// historyIdentity is a signed-in account with search history and a queue on
// another device.
type historyIdentity struct {
	likedIdentity
	hmu        sync.Mutex
	history    []domain.SearchHistoryEntry
	reads      int
	forgotten  [][]string
	forgetErr  error
	queue      domain.RemoteQueue
	recognised bool
	queueReads int
}

func (f *historyIdentity) SearchHistory(context.Context) ([]domain.SearchHistoryEntry, error) {
	f.hmu.Lock()
	defer f.hmu.Unlock()
	f.reads++
	return append([]domain.SearchHistoryEntry(nil), f.history...), nil
}

func (f *historyIdentity) ForgetSearches(_ context.Context, tokens []string) error {
	f.hmu.Lock()
	defer f.hmu.Unlock()
	f.forgotten = append(f.forgotten, tokens)
	if f.forgetErr != nil {
		return f.forgetErr
	}
	gone := map[string]bool{}
	for _, t := range tokens {
		gone[t] = true
	}
	out := f.history[:0]
	for _, e := range f.history {
		if !gone[e.Token] {
			out = append(out, e)
		}
	}
	f.history = out
	return nil
}

func (f *historyIdentity) RemoteQueue(context.Context) (domain.RemoteQueue, bool, error) {
	f.hmu.Lock()
	defer f.hmu.Unlock()
	f.queueReads++
	return f.queue, f.recognised, nil
}

func withHistory(f *historyIdentity) *api.Server {
	st := account.State{Identity: f, Library: library.New(f, nil)}
	return serverWith(api.Deps{Account: account.Static(st), Responses: kept(clock.NewManual())})
}

func searchHistoryOf(t *testing.T, s *api.Server) []domain.SearchHistoryEntry {
	t.Helper()
	rec := do(t, s, http.MethodGet, "/v1/me/search-history")
	if rec.Code != http.StatusOK {
		t.Fatalf("search history: %d %s", rec.Code, rec.Body)
	}
	var out []domain.SearchHistoryEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", rec.Body, err)
	}
	return out
}

func TestSearchHistoryIsKeptBrieflyAndDroppedOnRemoval(t *testing.T) {
	f := &historyIdentity{history: []domain.SearchHistoryEntry{
		{Query: "daft punk", Token: "T1"}, {Query: "nils frahm", Token: "T2"},
	}}
	s := withHistory(f)
	if got := searchHistoryOf(t, s); len(got) != 2 || got[0].Token != "T1" {
		t.Fatalf("got %+v", got)
	}
	searchHistoryOf(t, s)
	if f.reads != 1 {
		t.Fatalf("read upstream %d times, want once", f.reads)
	}

	if rec := post(t, s, "/v1/me/search-history/forget", `{"tokens":["T1"]}`); rec.Code != http.StatusNoContent {
		t.Fatalf("forget: %d %s", rec.Code, rec.Body)
	}
	if len(f.forgotten) != 1 || len(f.forgotten[0]) != 1 || f.forgotten[0][0] != "T1" {
		t.Fatalf("forgotten %+v", f.forgotten)
	}
	got := searchHistoryOf(t, s)
	if len(got) != 1 || got[0].Query != "nils frahm" {
		t.Fatalf("after removal: %+v", got)
	}
	if f.reads != 2 {
		t.Fatalf("after removal read %d times, want a fresh read", f.reads)
	}
}

func TestAFailedRemovalIsReportedAndStillDropsTheKeptHistory(t *testing.T) {
	f := &historyIdentity{history: []domain.SearchHistoryEntry{{Query: "a", Token: "T1"}}, forgetErr: errors.New("upstream said no")}
	s := withHistory(f)
	searchHistoryOf(t, s)
	if rec := post(t, s, "/v1/me/search-history/forget", `{"tokens":["T1"]}`); rec.Code == http.StatusNoContent {
		t.Fatal("a failed removal reported as done")
	}
	searchHistoryOf(t, s)
	if f.reads != 2 {
		t.Fatalf("read %d times, want the kept copy dropped", f.reads)
	}
}

func TestRemovingNothingIsRefused(t *testing.T) {
	f := &historyIdentity{}
	s := withHistory(f)
	for _, body := range []string{`{}`, `{"tokens":[]}`, `nonsense`} {
		if rec := post(t, s, "/v1/me/search-history/forget", body); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d", body, rec.Code)
		}
	}
	if len(f.forgotten) != 0 {
		t.Fatal("reached the account")
	}
}

// Signed out, the history and the queue are empty and YouTube is not asked.
func TestSignedOutAccountReadsAskNothing(t *testing.T) {
	var asked atomic.Int32
	h := &http.Client{Transport: countingTransport{&asked}}
	st := account.State{Client: innertube.New(innertube.WithHTTPClient(h))}
	s := serverWith(api.Deps{Account: account.Static(st), Responses: kept(clock.NewManual())})

	if got := searchHistoryOf(t, s); len(got) != 0 {
		t.Fatalf("history %+v", got)
	}
	rec := do(t, s, http.MethodGet, "/v1/me/remote-queue")
	var q domain.RemoteQueue
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &q) != nil || len(q.Tracks) != 0 || q.Tracks == nil {
		t.Fatalf("remote queue: %d %s", rec.Code, rec.Body)
	}
	if rec := post(t, s, "/v1/me/search-history/forget", `{"tokens":["T1"]}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("forget signed out: %d", rec.Code)
	}
	if n := asked.Load(); n != 0 {
		t.Fatalf("YouTube asked %d times while signed out", n)
	}
}

type countingTransport struct{ n *atomic.Int32 }

func (c countingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	c.n.Add(1)
	return nil, errors.New("no network in this test")
}

func TestTheRemoteQueueIsReadEveryTimeItIsAskedFor(t *testing.T) {
	f := &historyIdentity{recognised: true, queue: domain.RemoteQueue{
		Tracks: []domain.Track{{ID: "a", Title: "A", Playable: true}, {ID: "b", Title: "B", Playable: true}},
		Index:  1, Title: "Liked Music",
	}}
	s := withHistory(f)
	for i := 0; i < 2; i++ {
		rec := do(t, s, http.MethodGet, "/v1/me/remote-queue")
		var q domain.RemoteQueue
		if err := json.Unmarshal(rec.Body.Bytes(), &q); err != nil || len(q.Tracks) != 2 || q.Index != 1 || q.Title != "Liked Music" {
			t.Fatalf("read %d: %d %s", i, rec.Code, rec.Body)
		}
	}
	if f.queueReads != 2 {
		t.Fatalf("read %d times: another device's queue moves on, so it is never kept", f.queueReads)
	}
}

func TestAnUnrecognisedRemoteQueueIsEmpty(t *testing.T) {
	f := &historyIdentity{recognised: false, queue: domain.RemoteQueue{Tracks: []domain.Track{{ID: "x"}}}}
	s := withHistory(f)
	rec := do(t, s, http.MethodGet, "/v1/me/remote-queue")
	var q domain.RemoteQueue
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &q) != nil || len(q.Tracks) != 0 {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}
