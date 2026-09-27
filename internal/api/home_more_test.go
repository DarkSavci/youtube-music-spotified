package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"spotifier/internal/api"
	"spotifier/internal/catalog"
	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

// homeCatalog records which Home reads went upstream.
type homeCatalog struct {
	emptyCatalog
	mu    sync.Mutex
	calls []string
}

func (c *homeCatalog) note(s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, s)
}

func (c *homeCatalog) Home(context.Context) (domain.BrowsePage, error) {
	c.note("home")
	return domain.BrowsePage{
		Chips:        []domain.HomeChip{{Title: "Relax", Params: "P_RELAX"}},
		Continuation: "T2",
	}, nil
}

func (c *homeCatalog) Browse(_ context.Context, surface, params string) (domain.BrowsePage, error) {
	c.note("browse:" + surface + ":" + params)
	return domain.BrowsePage{
		Chips:        []domain.HomeChip{{Title: "Relax", Params: params, Selected: true}},
		Continuation: "M2",
	}, nil
}

func (c *homeCatalog) BrowseMore(_ context.Context, surface, token string) (domain.BrowsePage, error) {
	c.note("more:" + surface + ":" + token)
	return domain.BrowsePage{Shelves: []domain.Shelf{{Title: "More " + token}}}, nil
}

func TestHomeMoodAndContinuationRoutes(t *testing.T) {
	cat := &homeCatalog{}
	s := serverWith(api.Deps{Catalog: cat, Responses: kept(clock.NewManual())})

	for _, path := range []string{
		"/v1/home",
		"/v1/home?mood=P_RELAX",
		"/v1/home?continuation=a%2Bb",
		// Every one again: all three are kept, so none goes upstream twice.
		"/v1/home",
		"/v1/home?mood=P_RELAX",
		"/v1/home?continuation=a%2Bb",
	} {
		if w := do(t, s, http.MethodGet, path); w.Code != 200 {
			t.Fatalf("%s: status %d: %s", path, w.Code, w.Body)
		}
	}
	want := []string{
		"home",
		"browse:" + catalog.SurfaceHome + ":P_RELAX",
		"more:" + catalog.SurfaceHome + ":a+b",
	}
	if len(cat.calls) != len(want) {
		t.Fatalf("upstream calls = %v, want %v", cat.calls, want)
	}
	for i := range want {
		if cat.calls[i] != want[i] {
			t.Fatalf("upstream calls = %v, want %v", cat.calls, want)
		}
	}

	var page domain.BrowsePage
	w := do(t, s, http.MethodGet, "/v1/home?mood=P_RELAX")
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Chips) != 1 || !page.Chips[0].Selected || page.Continuation != "M2" {
		t.Fatalf("mood page = %+v", page)
	}
	page = domain.BrowsePage{}
	w = do(t, s, http.MethodGet, "/v1/home?continuation=a%2Bb")
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Shelves) != 1 || page.Shelves[0].Title != "More a+b" || page.Continuation != "" {
		t.Fatalf("continuation page = %+v", page)
	}
}

// Signing out drops Home in every form: plain, per mood and every later page.
func TestSignOutDropsEveryHomeVariant(t *testing.T) {
	cat := &homeCatalog{}
	s := serverWith(api.Deps{Catalog: cat, Responses: kept(clock.NewManual())})
	paths := []string{"/v1/home", "/v1/home?mood=P_RELAX", "/v1/home?continuation=T2"}
	for _, p := range paths {
		do(t, s, http.MethodGet, p)
	}
	if w := do(t, s, http.MethodPost, "/v1/auth/sign-out"); w.Code != 200 {
		t.Fatalf("signout status %d", w.Code)
	}
	for _, p := range paths {
		do(t, s, http.MethodGet, p)
	}
	if len(cat.calls) != 6 {
		t.Fatalf("after sign-out, upstream calls = %v, want every variant read again", cat.calls)
	}
}
