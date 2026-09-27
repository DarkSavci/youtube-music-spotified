package catalog_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"spotifier/internal/catalog"
	"spotifier/internal/innertube"
)

// homeServer serves the synthetic homepage for the config scrape and the
// recorded Home for a browse, counting the browses.
func homeServer(t *testing.T, locale ...string) (*catalog.InnerTube, *[]map[string]any) {
	t.Helper()
	page, err := os.ReadFile("../innertube/testdata/homepage.html")
	if err != nil {
		t.Fatal(err)
	}
	browsed, err := os.ReadFile("../../testdata/fixtures/home.json")
	if err != nil {
		t.Fatal(err)
	}
	var sent []map[string]any
	h := &http.Client{Transport: pagingTransport(func(r *http.Request) (*http.Response, error) {
		body := page
		if r.Method == http.MethodPost {
			var req map[string]any
			_ = json.NewDecoder(r.Body).Decode(&req)
			sent = append(sent, req)
			body = browsed
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}
	opts := []innertube.Option{innertube.WithHTTPClient(h)}
	if len(locale) == 2 {
		opts = append(opts, innertube.WithLocale(locale[0], locale[1]))
	}
	return catalog.NewInnerTube(innertube.New(opts...), nil), &sent
}

// A cold start reads Home off the homepage fetched for the config, and asks
// YouTube for it only the next time.
func TestHomeOnColdStartComesFromTheHomepage(t *testing.T) {
	c, sent := homeServer(t, "tr", "TR")
	page, err := c.Home(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 0 {
		t.Fatalf("%d browses sent; the homepage had Home on it", len(*sent))
	}
	if len(page.Shelves) != 2 || !strings.HasPrefix(page.Shelves[0].Title, "Şarkı önerileri") {
		t.Fatalf("shelves %+v", page.Shelves)
	}
	if len(page.Shelves[0].Items) == 0 {
		t.Fatal("shelf items did not parse")
	}

	if _, err := c.Home(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 1 || (*sent)[0]["browseId"] != "FEmusic_home" {
		t.Fatalf("second visit sent %v, want one browse of Home", *sent)
	}
}

// A homepage in another locale than the calls use is not read for Home.
func TestHomeInAnotherLocaleIsBrowsed(t *testing.T) {
	c, sent := homeServer(t) // en/US; the page is tr/TR
	if _, err := c.Home(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 1 || (*sent)[0]["browseId"] != "FEmusic_home" {
		t.Fatalf("sent %v, want one browse of Home", *sent)
	}
}

// Browsing Home with params is never answered from the homepage.
func TestHomeChipIsBrowsed(t *testing.T) {
	c, sent := homeServer(t, "tr", "TR")
	if _, err := c.Browse(context.Background(), catalog.SurfaceHome, "chip"); err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 1 || (*sent)[0]["params"] != "chip" {
		t.Fatalf("sent %v", *sent)
	}
}
