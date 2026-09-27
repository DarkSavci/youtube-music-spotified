package renderers

import (
	"strings"

	"spotifier/internal/domain"
)

// ---------- search history ----------

// NodeHistorySuggestion is one of the account's past searches in the answer
// to an empty get_search_suggestions.
const NodeHistorySuggestion = "historySuggestionRenderer"

/*
ParseSearchHistory reads the account's past searches out of the answer
YouTube Music gets for an empty search box: a searchSuggestionsSectionRenderer
of historySuggestionRenderer items, each with the query (in its search
endpoint, and as display runs) and a feedback token that removes it from the
account's history.

A signed-out answer, or an account with no history, has none: an empty list.
Entries are kept in YouTube's order, most recent first, once each.
*/
func ParseSearchHistory(doc Node) []domain.SearchHistoryEntry {
	var out []domain.SearchHistoryEntry
	seen := map[string]bool{}
	for _, n := range FindAll(doc, NodeHistorySuggestion) {
		q := strings.TrimSpace(n.Child("navigationEndpoint").Child("searchEndpoint").Str("query"))
		if q == "" {
			q = strings.TrimSpace(n.Text("suggestion"))
		}
		key := strings.ToLower(q)
		if q == "" || seen[key] {
			continue
		}
		seen[key] = true
		token := n.Child("serviceEndpoint").Child("feedbackEndpoint").Str("feedbackToken")
		if token == "" {
			// Where else a removal token has been seen on such rows.
			token = Find(n, "feedbackEndpoint").Str("feedbackToken")
		}
		out = append(out, domain.SearchHistoryEntry{Query: q, Token: token})
	}
	return out
}

// ---------- the account's queue on other devices ----------

// SurfaceRemoteQueue names the queue read in the parser-health signal.
const SurfaceRemoteQueue = "next:get_queue"

// queueEntry is one entry of a watch queue, and whether it is the one the
// queue is on.
type queueEntry struct {
	node     Node
	selected bool
}

/*
selectedQueueEntries finds a queue's entries in order, as queueEntries does,
noting which is selected.

A wrapper entry holds the song (primaryRenderer) and its music-video version
(counterpart); the counterpart is the same entry and is not listed, but when it
is the one selected — the other device was playing the video — the entry is
still the one the queue is on.
*/
func selectedQueueEntries(v any) []queueEntry {
	var out []queueEntry
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case Node:
			walk(map[string]any(x))
		case map[string]any:
			if w, ok := x["playlistPanelVideoWrapperRenderer"].(map[string]any); ok {
				wrapper := Node(w)
				primary := FindAll(wrapper.Child("primaryRenderer"), NodeQueueItem)
				if len(primary) == 0 {
					// No song side: the wrapper holds only the video.
					primary = FindAll(wrapper, NodeQueueItem)
				}
				if len(primary) > 0 {
					selected := primary[0].Bool("selected")
					for _, c := range FindAll(w["counterpart"], NodeQueueItem) {
						selected = selected || c.Bool("selected")
					}
					out = append(out, queueEntry{node: primary[0], selected: selected})
				}
				return
			}
			for k, c := range x {
				switch k {
				case "counterpart":
					continue
				case NodeQueueItem:
					if n, ok := c.(map[string]any); ok {
						out = append(out, queueEntry{node: Node(n), selected: Node(n).Bool("selected")})
					}
					continue
				}
				walk(c)
			}
		case []any:
			for _, c := range x {
				walk(c)
			}
		}
	}
	walk(v)
	return out
}

/*
ParseRemoteQueue reads the answer to next with WATCH_NEXT_TYPE_GET_QUEUE: the
queue the account has on its other devices, which YouTube Music's website
reads at start-up to carry on from the phone.

The body was not captured when this was written, so the shape is the one the
watch-next queue has everywhere else — playlistPanelRenderer contents of
playlistPanelVideoRenderer entries, possibly wrapped with a video
counterpart, the current one marked selected — and it is read defensively:
entries are found at any depth, the current one falls back to the response's
currentVideoEndpoint and then to the first.

recognised is false when the answer has no queue in any shape this knows,
which is also what an account with no queue on another device may look like;
it is noted in the parser-health signal either way, so a change of shape
shows there instead of as a button that never finds anything.
*/
func ParseRemoteQueue(doc Node, pc ParseContext) (q domain.RemoteQueue, recognised bool) {
	entries := selectedQueueEntries(doc)
	selected := -1
	for _, e := range entries {
		tr, ok := ParseQueueTrack(e.node)
		if !ok {
			continue
		}
		if e.selected && selected < 0 {
			selected = len(q.Tracks)
		}
		q.Tracks = append(q.Tracks, tr)
	}
	panel := Find(doc, "playlistPanelRenderer")
	q.Title = strings.TrimSpace(panel.Text("title"))
	if q.Title == "" {
		q.Title = strings.TrimSpace(panel.Str("title"))
	}

	switch {
	case len(q.Tracks) > 0:
		recognised = true
	case len(entries) > 0:
		// Entries that no longer read as tracks: the entry's own shape moved.
		pc.unknown("unreadable " + NodeQueueItem)
	case panel != nil:
		// A queue panel with nothing in it: a queue that is empty.
		recognised = true
	default:
		pc.unknown("no playlistPanelRenderer")
	}
	if len(q.Tracks) == 0 {
		q.Tracks = nil
		q.Index = 0
		return q, recognised
	}

	if selected < 0 {
		if cur := Find(doc, "currentVideoEndpoint").Child("watchEndpoint").Str("videoId"); cur != "" {
			for i, t := range q.Tracks {
				if t.ID == cur {
					selected = i
					break
				}
			}
		}
	}
	q.Index = max(selected, 0)
	return q, recognised
}
