package innertube

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Channel describes a selectable identity under the current Google session.
// ID is empty for the personal channel, otherwise YouTube's page ID.
// Sign-in and delegation tokens never leave this parser.
type Channel struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Handle string `json:"handle,omitempty"`
}

func (c *Client) Channels(ctx context.Context) ([]Channel, error) {
	// Channel switching is served by the WEB client, not WEB_REMIX.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.youtube.com/", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Cookie", c.creds.cookie())
	response, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	page, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	version := reClientVer.FindSubmatch(page)
	if len(version) < 2 {
		return nil, fmt.Errorf("could not load YouTube channel switcher configuration")
	}
	raw, err := c.CallAs(ctx, "account/accounts_list", map[string]any{
		"requestType":      "ACCOUNTS_LIST_REQUEST_TYPE_CHANNEL_SWITCHER",
		"callCircumstance": "SWITCHING_USERS_FULL",
	}, &ClientContext{Name: "WEB", Version: string(version[1])})
	if err != nil {
		return nil, err
	}
	return parseChannels(raw)
}

func parseChannels(raw json.RawMessage) ([]Channel, error) {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	channels := []Channel{}
	seen := map[string]bool{}
	var walk func(any)
	walk = func(v any) {
		switch node := v.(type) {
		case map[string]any:
			if item, ok := node["accountItemRenderer"].(map[string]any); ok {
				// Delegated manager roles that need a confirmation flow are not a
				// direct channel selection and must not become the personal channel.
				endpoint, _ := item["serviceEndpoint"].(map[string]any)
				selectIdentity, ok := endpoint["selectActiveIdentityEndpoint"].(map[string]any)
				if !ok || item["isDisabled"] == true || item["hasChannel"] != true {
					return
				}
				tokens, _ := selectIdentity["supportedTokens"].([]any)
				id := ""
				personal := false
				for _, t := range tokens {
					token, _ := t.(map[string]any)
					if page, ok := token["pageIdToken"].(map[string]any); ok {
						id, _ = page["pageId"].(string)
					}
					if _, ok := token["accountStateToken"].(map[string]any); ok {
						personal = true
					}
				}
				name := runsText(item["accountName"])
				if name != "" && (id != "" || personal) && !seen[id] {
					channels = append(channels, Channel{ID: id, Name: name, Handle: runsText(item["channelHandle"])})
					seen[id] = true
				}
				return
			}
			for _, sub := range node {
				walk(sub)
			}
		case []any:
			for _, sub := range node {
				walk(sub)
			}
		}
	}
	walk(doc)
	if len(channels) == 0 {
		return nil, fmt.Errorf("no selectable YouTube channels returned; the session may need signing in again")
	}
	return channels, nil
}
