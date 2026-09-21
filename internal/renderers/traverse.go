// Package renderers translates InnerTube renderer nodes into domain types.
//
// It is a shared internal seam: only catalog and identity import it, and it
// appears in neither of their interfaces. Tests live at those interfaces and
// assert on domain output, not on traversal internals (DEEPENING.md: replace,
// don't layer).
//
// # Defensive traversal
//
// YouTube changes response shapes without notice. Every helper here returns a
// usable zero value rather than failing, and nothing indexes an array without
// a bounds check. Two rules follow from that and are enforced by review:
//
//   - Never assert a path. Search for a node type at any depth instead, because
//     nesting changes even when the node itself does not.
//   - Never drop an unrecognised node silently. Report it to obs so it becomes
//     parser-health signal rather than a blank region on screen.
package renderers

import (
	"encoding/json"
	"strconv"
	"strings"

	"spotifier/internal/domain"
)

// Node is a decoded JSON object from an InnerTube response.
//
// A nil Node is valid and every method on it returns a zero value, so chained
// lookups through a missing branch never panic.
type Node map[string]any

// Parse decodes a raw response into a Node.
func Parse(raw json.RawMessage) (Node, error) {
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return Node(v), nil
}

// ---------- scalar access ----------

// Child returns the object at key, or nil.
func (n Node) Child(key string) Node {
	if n == nil {
		return nil
	}
	if m, ok := n[key].(map[string]any); ok {
		return Node(m)
	}
	return nil
}

// Str returns the string at key, or "".
func (n Node) Str(key string) string {
	if n == nil {
		return ""
	}
	s, _ := n[key].(string)
	return s
}

// Int returns the integer at key. JSON numbers decode as float64, and YouTube
// also returns numerics as strings in places, so both are accepted.
func (n Node) Int(key string) int {
	if n == nil {
		return 0
	}
	switch v := n[key].(type) {
	case float64:
		return int(v)
	case string:
		i, _ := strconv.Atoi(v)
		return i
	}
	return 0
}

// Int64 is Int for values that can exceed 32 bits, such as byte counts.
func (n Node) Int64(key string) int64 {
	if n == nil {
		return 0
	}
	switch v := n[key].(type) {
	case float64:
		return int64(v)
	case string:
		i, _ := strconv.ParseInt(v, 10, 64)
		return i
	}
	return 0
}

// Bool returns the boolean at key, or false.
func (n Node) Bool(key string) bool {
	if n == nil {
		return false
	}
	b, _ := n[key].(bool)
	return b
}

// List returns the array at key, or nil.
func (n Node) List(key string) []any {
	if n == nil {
		return nil
	}
	l, _ := n[key].([]any)
	return l
}

// Nodes returns the array at key as Nodes, skipping any element that is not an
// object.
func (n Node) Nodes(key string) []Node {
	raw := n.List(key)
	if len(raw) == 0 {
		return nil
	}
	out := make([]Node, 0, len(raw))
	for _, v := range raw {
		if m, ok := v.(map[string]any); ok {
			out = append(out, Node(m))
		}
	}
	return out
}

// At returns the nth element of the array at key as a Node, bounds-checked.
//
// Positional indexing is the most common cause of breakage when shapes shift,
// so it is only available through this guarded accessor.
func (n Node) At(key string, i int) Node {
	raw := n.List(key)
	if i < 0 || i >= len(raw) {
		return nil
	}
	m, ok := raw[i].(map[string]any)
	if !ok {
		return nil
	}
	return Node(m)
}

// Has reports whether key is present.
func (n Node) Has(key string) bool {
	if n == nil {
		return false
	}
	_, ok := n[key]
	return ok
}

// ---------- text ----------

// Text reads the {"runs":[...]} / {"simpleText":...} idiom at key, joining all
// runs. Returns "" for any unexpected shape.
func (n Node) Text(key string) string {
	return textOf(n.Child(key))
}

func textOf(t Node) string {
	if t == nil {
		return ""
	}
	if s := t.Str("simpleText"); s != "" {
		return s
	}
	runs := t.Nodes("runs")
	if len(runs) == 0 {
		return ""
	}
	var b strings.Builder
	for _, r := range runs {
		b.WriteString(r.Str("text"))
	}
	return b.String()
}

// Runs returns the individual runs at key. Useful where each run carries its
// own navigation target, such as an artist credit list.
func (n Node) Runs(key string) []Node {
	return n.Child(key).Nodes("runs")
}

// ---------- navigation ----------

// BrowseID returns the browse target reachable from this node, at any depth.
func (n Node) BrowseID() string {
	if hit := Find(n, "browseEndpoint"); hit != nil {
		return hit.Str("browseId")
	}
	return ""
}

/*
OwnTarget returns the node's own navigation target: where clicking it goes.

BrowseID and PageType search the whole subtree, which is right for a node that
keeps its endpoint somewhere unpredictable and wrong for one that links to
something else as well. An album row in search does exactly that — it links its
artist in the subtitle — and the subtree search walks a Go map, whose iteration
order is randomised, so it returned the album or the artist depending on the
run. Reading only the node's own endpoint is both correct and deterministic.

Returns empty strings when the node has no browse endpoint of its own, which is
the case for track rows, whose target is a watch endpoint.
*/
func (n Node) OwnTarget() (browseID, pageType string) {
	be := n.Child("navigationEndpoint").Child("browseEndpoint")
	if be == nil {
		return "", ""
	}
	return be.Str("browseId"), be.PageType()
}

// VideoID returns the playback target reachable from this node, at any depth.
func (n Node) VideoID() string {
	if hit := Find(n, "watchEndpoint"); hit != nil {
		if id := hit.Str("videoId"); id != "" {
			return id
		}
	}
	return ""
}

// PageType returns the MUSIC_PAGE_TYPE_* hint on a browse endpoint, which
// distinguishes an album from an artist from a playlist when the ID alone is
// ambiguous.
func (n Node) PageType() string {
	if hit := Find(n, "browseEndpointContextMusicConfig"); hit != nil {
		return hit.Str("pageType")
	}
	return ""
}

// ---------- artwork ----------

// Artwork reads a thumbnail container at key into an ArtworkSet, ascending by
// width.
func (n Node) Artwork(key string) domain.ArtworkSet {
	return artworkOf(n.Child(key))
}

// FindArtwork locates the first thumbnail container anywhere under this node.
// Thumbnails nest inconsistently, so searching beats asserting a path.
func (n Node) FindArtwork() domain.ArtworkSet {
	if hit := Find(n, "thumbnails"); hit != nil {
		return artworkOf(hit)
	}
	// "thumbnails" is usually an array under a wrapper, not an object; search
	// the known wrappers too.
	for _, wrapper := range []string{"thumbnail", "musicThumbnailRenderer", "croppedSquareThumbnail"} {
		if hit := Find(n, wrapper); hit != nil {
			if set := artworkOf(hit); len(set) > 0 {
				return set
			}
		}
	}
	return nil
}

func artworkOf(t Node) domain.ArtworkSet {
	if t == nil {
		return nil
	}
	// Unwrap the common nestings before reading the array.
	for _, wrapper := range []string{"thumbnail", "musicThumbnailRenderer"} {
		if inner := t.Child(wrapper); inner != nil && !t.Has("thumbnails") {
			t = inner
		}
	}
	items := t.Nodes("thumbnails")
	if len(items) == 0 {
		return nil
	}
	out := make(domain.ArtworkSet, 0, len(items))
	for _, it := range items {
		url := it.Str("url")
		if url == "" {
			continue
		}
		out = append(out, domain.Artwork{
			URL:    url,
			Width:  it.Int("width"),
			Height: it.Int("height"),
		})
	}
	// Ascending by width, as ArtworkSet requires.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Width < out[j-1].Width; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// ---------- search ----------

// Find returns the first object stored under key anywhere in the tree,
// breadth-preferring the shallowest match.
func Find(v any, key string) Node {
	if hit := findDirect(v, key); hit != nil {
		return hit
	}
	return nil
}

func findDirect(v any, key string) Node {
	switch t := v.(type) {
	case Node:
		return findDirect(map[string]any(t), key)
	case map[string]any:
		if hit, ok := t[key].(map[string]any); ok {
			return Node(hit)
		}
		if arr, ok := t[key].([]any); ok && len(arr) > 0 {
			// Some containers hold their payload as an array; wrap it so the
			// caller can still read it uniformly.
			return Node{key: arr}
		}
		for _, sub := range t {
			if hit := findDirect(sub, key); hit != nil {
				return hit
			}
		}
	case []any:
		for _, sub := range t {
			if hit := findDirect(sub, key); hit != nil {
				return hit
			}
		}
	}
	return nil
}

// FindAll returns every object stored under key anywhere in the tree, in
// document order.
func FindAll(v any, key string) []Node {
	var out []Node
	collect(v, key, &out)
	return out
}

func collect(v any, key string, out *[]Node) {
	switch t := v.(type) {
	case Node:
		collect(map[string]any(t), key, out)
	case map[string]any:
		if hit, ok := t[key].(map[string]any); ok {
			*out = append(*out, Node(hit))
		}
		for _, sub := range t {
			collect(sub, key, out)
		}
	case []any:
		for _, sub := range t {
			collect(sub, key, out)
		}
	}
}

// RendererTypes counts every *Renderer key in a tree.
//
// Parsers use this to find node types they do not handle, which becomes
// parser-health signal rather than silent data loss.
func RendererTypes(v any) map[string]int {
	counts := map[string]int{}
	countTypes(v, counts)
	return counts
}

func countTypes(v any, counts map[string]int) {
	switch t := v.(type) {
	case Node:
		countTypes(map[string]any(t), counts)
	case map[string]any:
		for k, sub := range t {
			if strings.HasSuffix(k, "Renderer") {
				counts[k]++
			}
			countTypes(sub, counts)
		}
	case []any:
		for _, sub := range t {
			countTypes(sub, counts)
		}
	}
}

// Continuation extracts the paging token from a container, if one is present.
func Continuation(v any) string {
	for _, key := range []string{"nextContinuationData", "continuationCommand", "reloadContinuationData"} {
		if hit := Find(v, key); hit != nil {
			if tok := hit.Str("continuation"); tok != "" {
				return tok
			}
			if tok := hit.Str("token"); tok != "" {
				return tok
			}
		}
	}
	return ""
}

// ---------- value parsing ----------

// DurationMs parses a "m:ss" or "h:mm:ss" duration into milliseconds.
// Returns 0 for anything unparseable.
func DurationMs(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0
	}
	var total int64
	for _, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || n < 0 {
			return 0
		}
		total = total*60 + int64(n)
	}
	return total * 1000
}

// IsExplicit reports whether a node carries the explicit-content badge.
func IsExplicit(n Node) bool {
	for _, b := range FindAll(n, "musicInlineBadgeRenderer") {
		if strings.Contains(b.Child("icon").Str("iconType"), "EXPLICIT") {
			return true
		}
	}
	return false
}

/*
FindArray returns the elements of the first array stored under key.

FindAll only collects objects, so a payload that arrives as a bare array —
timed lyrics being the one that matters — is invisible to it.
*/
func FindArray(v any, key string) []Node {
	var out []Node
	collectArray(v, key, &out)
	return out
}

func collectArray(v any, key string, out *[]Node) {
	if len(*out) > 0 {
		return
	}
	switch t := v.(type) {
	case Node:
		collectArray(map[string]any(t), key, out)
	case map[string]any:
		if arr, ok := t[key].([]any); ok {
			for _, e := range arr {
				if m, ok := e.(map[string]any); ok {
					*out = append(*out, Node(m))
				}
			}
			if len(*out) > 0 {
				return
			}
		}
		for _, sub := range t {
			collectArray(sub, key, out)
		}
	case []any:
		for _, sub := range t {
			collectArray(sub, key, out)
		}
	}
}

// headerArtwork is a page header's own picture.
//
// Headers carry more than one: an album or playlist header also has the
// owner's avatar beside the byline (straplineThumbnail). A blind search
// walks maps, whose order Go randomises, so it returned the avatar about
// half the time. The header's own "thumbnail" is always the cover.
func headerArtwork(h Node) domain.ArtworkSet {
	if art := artworkOf(Find(h.Child("thumbnail"), "thumbnails")); len(art) > 0 {
		return art
	}
	return h.FindArtwork()
}
