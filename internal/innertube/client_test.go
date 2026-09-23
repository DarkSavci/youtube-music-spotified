package innertube

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTrip func(*http.Request) *http.Response

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r), nil }

/*
A playback ping has to name YouTube Music as the player.

The signed URL does not say which client it was issued to, and a ping without
c=WEB_REMIX is credited to plain YouTube: the play shows up in YouTube's watch
history and never in YouTube Music's.
*/
func TestGetSignedIdentifiesAsYouTubeMusic(t *testing.T) {
	var ping *http.Request
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		body := `{"INNERTUBE_CLIENT_VERSION":"1.20260901.01.00"}`
		if r.URL.Host == "s.youtube.com" {
			ping, body = r, ""
		}
		return &http.Response{StatusCode: 204, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
	})}
	c := New(WithHTTPClient(h), WithCredentials(&Credentials{Cookie: "SAPISID=abc; LOGIN_INFO=xyz"}))

	status, err := c.GetSigned(context.Background(), "https://s.youtube.com/api/stats/playback?docid=abc&ei=E1&cpn=N")
	if err != nil || status != 204 {
		t.Fatalf("status %d, err %v", status, err)
	}
	if ping == nil {
		t.Fatal("no ping sent")
	}
	q := ping.URL.Query()
	if q.Get("c") != "WEB_REMIX" || q.Get("cver") != "1.20260901.01.00" {
		t.Fatalf("client identity c=%q cver=%q, want WEB_REMIX and the scraped version", q.Get("c"), q.Get("cver"))
	}
	if q.Get("docid") != "abc" || q.Get("ei") != "E1" || q.Get("cpn") != "N" {
		t.Fatalf("lost the signed parameters: %v", q)
	}
	if ping.Header.Get("Origin") != Origin || !strings.HasPrefix(ping.Header.Get("Authorization"), "SAPISIDHASH ") {
		t.Fatalf("not sent as the music origin: %v", ping.Header)
	}
}
