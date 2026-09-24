package innertube

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestParseChannels(t *testing.T) {
	raw := `{"contents":[
 {"accountItemRenderer":{"accountName":{"simpleText":"Personal"},"hasChannel":true,"serviceEndpoint":{"selectActiveIdentityEndpoint":{"supportedTokens":[{"accountStateToken":{"hasChannel":true}}]}}}},
 {"accountItemRenderer":{"accountName":{"runs":[{"text":"Music profile"}]},"channelHandle":{"simpleText":"@music"},"hasChannel":true,"serviceEndpoint":{"selectActiveIdentityEndpoint":{"supportedTokens":[{"pageIdToken":{"pageId":"123"}},{"accountStateToken":{"hasChannel":true}}]}}}},
 {"accountItemRenderer":{"accountName":{"simpleText":"Disabled"},"isDisabled":true,"hasChannel":true,"serviceEndpoint":{"selectActiveIdentityEndpoint":{"supportedTokens":[]}}}},
 {"accountItemRenderer":{"accountName":{"simpleText":"Delegated role"},"serviceEndpoint":{"openPopupAction":{"selectActiveIdentityEndpoint":{"supportedTokens":[]}}}}}
 ]}`
	got, err := parseChannels(json.RawMessage(raw))
	if err != nil || len(got) != 2 {
		t.Fatalf("channels=%v err=%v", got, err)
	}
	if got[0].ID != "" || got[1].ID != "123" || got[1].Handle != "@music" {
		t.Fatalf("wrong channel identities: %v", got)
	}
	if _, err := parseChannels(json.RawMessage(`{"responseContext":{}}`)); err == nil {
		t.Fatal("missing channel list must not clear saved identities")
	}
}

func TestDelegatedIdentityAndWebAccountRequests(t *testing.T) {
	var calls int
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		body := `{"INNERTUBE_CLIENT_VERSION":"2.test"}`
		if r.Method == http.MethodPost {
			calls++
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			user := payload["context"].(map[string]any)["user"].(map[string]any)
			if user["onBehalfOfUser"] != "123" {
				t.Fatal("missing selected channel")
			}
			origin := "https://music.youtube.com"
			if calls == 2 {
				origin = "https://www.youtube.com"
			}
			if r.Header.Get("Origin") != origin || !strings.HasPrefix(r.Header.Get("Authorization"), "SAPISIDHASH ") || r.URL.Scheme+"://"+r.URL.Host != origin {
				t.Fatal("wrong authenticated origin")
			}
			body = `{}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
	})}
	c := New(WithHTTPClient(h), WithCredentials(&Credentials{Cookie: "SAPISID=test; LOGIN_INFO=test", OnBehalfOfUser: "123"}))
	if _, err := c.Call(context.Background(), "browse", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CallAs(context.Background(), "account/accounts_list", map[string]any{}, &ClientContext{Name: "WEB", Version: "2.test"}); err != nil {
		t.Fatal(err)
	}
}
