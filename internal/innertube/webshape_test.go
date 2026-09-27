package innertube

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// shapeServer answers the homepage scrape with page and every call with {},
// and keeps each call it was sent.
type shapeServer struct {
	mu     sync.Mutex
	page   string
	status int
	calls  []*http.Request
	bodies []map[string]any
	scrape *http.Request
}

func (s *shapeServer) client(opts ...Option) *Client {
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		s.mu.Lock()
		defer s.mu.Unlock()
		if r.Method == http.MethodGet {
			s.scrape = r
			return respond(200, s.page, nil)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.calls = append(s.calls, r)
		s.bodies = append(s.bodies, body)
		if s.status != 0 {
			return respond(s.status, `{"error":{"message":"nope"}}`, nil)
		}
		return respond(200, `{}`, nil)
	})}
	return New(append([]Option{WithHTTPClient(h)}, opts...)...)
}

func (s *shapeServer) last(t *testing.T) (*http.Request, map[string]any) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.calls) == 0 {
		t.Fatal("no call was sent")
	}
	return s.calls[len(s.calls)-1], s.bodies[len(s.bodies)-1]
}

const shapePage = `{"INNERTUBE_API_KEY":"AIzaSecret","INNERTUBE_CLIENT_VERSION":"1.20260922.09.00","VISITOR_DATA":"Cgtvisitor"}`

var signedIn = &Credentials{Cookie: "SAPISID=abc; __Secure-3PAPISID=abc; LOGIN_INFO=xyz"}

// A call is sent as YouTube Music's web client sends it: no key, compact JSON,
// and the client named in headers as well as in the body.
func TestWebCallHasTheWebClientsShape(t *testing.T) {
	s := &shapeServer{page: shapePage}
	c := s.client(WithCredentials(signedIn))
	if _, err := c.Call(context.Background(), "browse", map[string]any{"browseId": "UCabc"}); err != nil {
		t.Fatal(err)
	}
	r, body := s.last(t)
	if r.URL.String() != "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false" {
		t.Fatalf("sent to %s", r.URL)
	}
	want := map[string]string{
		"X-Youtube-Client-Name":         "67",
		"X-Youtube-Client-Version":      "1.20260922.09.00",
		"X-Youtube-Bootstrap-Logged-In": "true",
		"X-Goog-Visitor-Id":             "Cgtvisitor",
		"X-Origin":                      Origin,
		"Origin":                        Origin,
		"Referer":                       Origin + "/",
		"Content-Type":                  "application/json",
	}
	for k, v := range want {
		if got := r.Header.Get(k); got != v {
			t.Errorf("%s: %q, want %q", k, got, v)
		}
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "SAPISIDHASH ") {
		t.Errorf("Authorization %q", r.Header.Get("Authorization"))
	}
	if body["browseId"] != "UCabc" {
		t.Errorf("body lost the browse id: %v", body)
	}
	client, _ := body["context"].(map[string]any)["client"].(map[string]any)
	if client["clientName"] != ClientName || client["clientVersion"] != "1.20260922.09.00" {
		t.Errorf("context client %v", client)
	}
}

// Signed out, nothing claims a signed-in page, and nothing signs the call.
func TestSignedOutWebCallClaimsNoSession(t *testing.T) {
	s := &shapeServer{page: shapePage}
	c := s.client()
	if _, err := c.Call(context.Background(), "search", map[string]any{"query": "q"}); err != nil {
		t.Fatal(err)
	}
	r, _ := s.last(t)
	if r.URL.RawQuery != "prettyPrint=false" {
		t.Fatalf("query %q", r.URL.RawQuery)
	}
	for _, k := range []string{"X-Youtube-Bootstrap-Logged-In", "Authorization", "X-Origin"} {
		if v := r.Header.Get(k); v != "" {
			t.Errorf("%s: %q sent signed out", k, v)
		}
	}
	if r.Header.Get("X-Youtube-Client-Name") != "67" {
		t.Error("client not named")
	}
}

// A mobile context is left exactly as it was: none of the web client's
// headers, which would contradict it.
func TestMobileCallKeepsItsOwnShape(t *testing.T) {
	s := &shapeServer{page: shapePage}
	c := s.client(WithCredentials(signedIn))
	if _, err := c.CallAs(context.Background(), "browse", map[string]any{"continuation": "tok"}, &MobileMusic); err != nil {
		t.Fatal(err)
	}
	r, body := s.last(t)
	if r.URL.RawQuery != "alt=json" {
		t.Fatalf("query %q, want alt=json", r.URL.RawQuery)
	}
	for _, k := range []string{"X-Youtube-Client-Name", "X-Youtube-Client-Version", "X-Youtube-Bootstrap-Logged-In", "X-Goog-Visitor-Id", "Authorization"} {
		if v := r.Header.Get(k); v != "" {
			t.Errorf("%s: %q sent with a mobile context", k, v)
		}
	}
	if body["continuation"] != "tok" {
		t.Errorf("mobile continuation moved out of the body: %v", body)
	}
}

// A browse continuation goes in the URL, as the web client sends it, and the
// body is the context alone.
func TestBrowseContinuationTravelsInTheURL(t *testing.T) {
	var got []CallRecord
	SetObserver(func(r CallRecord) { got = append(got, r) })
	defer SetObserver(nil)

	s := &shapeServer{page: shapePage}
	c := s.client(WithCredentials(signedIn))
	token := "4qmFsgK/AhIM+RkVt=="
	if _, err := c.Continue(context.Background(), "browse", token); err != nil {
		t.Fatal(err)
	}
	r, body := s.last(t)
	if !strings.HasPrefix(r.URL.RawQuery, "ctoken=") || !strings.HasSuffix(r.URL.RawQuery, "&type=next&prettyPrint=false") {
		t.Fatalf("query %q", r.URL.RawQuery)
	}
	q := r.URL.Query()
	if q.Get("ctoken") != token || q.Get("continuation") != token || q.Get("type") != "next" || q.Get("prettyPrint") != "false" || q.Has("key") {
		t.Fatalf("query %v", q)
	}
	if len(body) != 1 || body["context"] == nil {
		t.Fatalf("body %v, want the context alone", body)
	}
	if last := got[len(got)-1]; last.Kind != "browse" || last.Detail != "continuation" {
		t.Fatalf("logged as %+v", last)
	}

	// Other endpoints keep theirs in the body.
	if _, err := c.Call(context.Background(), "next", map[string]any{"continuation": token}); err != nil {
		t.Fatal(err)
	}
	r, body = s.last(t)
	if r.URL.RawQuery != "prettyPrint=false" || body["continuation"] != token {
		t.Fatalf("next continuation: query %q body %v", r.URL.RawQuery, body)
	}
}

// An upstream refusal names the endpoint and nothing of the request: no key,
// no token.
func TestCallErrorsCarryNoQuery(t *testing.T) {
	s := &shapeServer{page: shapePage, status: 400}
	c := s.client()
	_, err := c.Continue(context.Background(), "browse", "secret-token")
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != 400 {
		t.Fatalf("err %v", err)
	}
	if msg := err.Error(); strings.Contains(msg, "secret-token") || strings.Contains(msg, "AIza") || strings.Contains(msg, "?") {
		t.Fatalf("error leaks the request: %s", msg)
	}
}

// The homepage is asked for in the calls' locale, with the session's cookies,
// so the Home on it is the one a browse would have returned.
func TestScrapeAsksForTheCallsLocale(t *testing.T) {
	s := &shapeServer{page: shapePage}
	c := s.client(WithCredentials(signedIn), WithLocale("tr", "TR"))
	if _, err := c.Call(context.Background(), "browse", map[string]any{"browseId": "x"}); err != nil {
		t.Fatal(err)
	}
	r := s.scrape
	if r == nil || r.URL.Path != "/" || r.URL.Query().Get("hl") != "tr" || r.URL.Query().Get("gl") != "TR" {
		t.Fatalf("scraped %v", r.URL)
	}
	if !strings.Contains(r.Header.Get("Cookie"), "LOGIN_INFO=xyz") {
		t.Fatalf("scraped without the session: %q", r.Header.Get("Cookie"))
	}
}

func homepageFixture(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("testdata/homepage.html")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The Home on the homepage is handed out once, while fresh, and only when the
// page was served in the locale asked for.
func TestInitialHomeIsHandedOutOnceWhileFresh(t *testing.T) {
	s := &shapeServer{page: homepageFixture(t)}
	c := s.client(WithLocale("tr", "TR"))
	raw, ok := c.InitialHome(context.Background())
	if !ok || !strings.Contains(string(raw), "Şarkı önerileri") {
		t.Fatalf("no Home from the page: ok=%v %.100s", ok, raw)
	}
	if _, ok := c.InitialHome(context.Background()); ok {
		t.Fatal("Home handed out twice")
	}
	if len(s.calls) != 0 {
		t.Fatalf("%d calls sent; the page alone should do", len(s.calls))
	}

	// Stale: the page is more than a minute old.
	s2 := &shapeServer{page: homepageFixture(t)}
	c2 := s2.client(WithLocale("tr", "TR"))
	cfg, err := c2.config(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg.scrapedAt = time.Now().Add(-homeFresh - time.Second)
	if _, ok := c2.InitialHome(context.Background()); ok {
		t.Fatal("stale Home handed out")
	}

	// Another locale: the page's Home is not the one the calls would get.
	s3 := &shapeServer{page: homepageFixture(t)}
	c3 := s3.client(WithLocale("en", "US"))
	if _, ok := c3.InitialHome(context.Background()); ok {
		t.Fatal("Home in another locale handed out")
	}
}

func TestInitialHomeAbsentWhenScrapeFails(t *testing.T) {
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		return &http.Response{StatusCode: 429, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}
	})}
	c := New(WithHTTPClient(h))
	if _, ok := c.InitialHome(context.Background()); ok {
		t.Fatal("Home without a page")
	}
}
