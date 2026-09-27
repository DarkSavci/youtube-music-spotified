package renderers

import (
	"testing"

	"spotifier/internal/domain"
)

// The fixtures here are synthetic, modelled on Home as YouTube Music serves
// it: a chip row and a few shelves first, then a few shelves per scroll.

func TestHomeChipsAreParsedFromTheChipRow(t *testing.T) {
	pc, _ := ctxFor("home")
	page := ParseBrowsePage(loadFixture(t, "home_chip"), pc)

	want := []domain.HomeChip{
		{Title: "Energize", Params: "PARAMS_ENERGIZE", Selected: true},
		{Title: "Relax", Params: "PARAMS_RELAX"},
		{Title: "Workout", Params: "PARAMS_WORKOUT"},
	}
	if len(page.Chips) != len(want) {
		t.Fatalf("chips = %+v, want %+v", page.Chips, want)
	}
	for i, c := range want {
		if page.Chips[i] != c {
			t.Errorf("chip %d = %+v, want %+v", i, page.Chips[i], c)
		}
	}
	if len(page.Shelves) != 2 {
		t.Fatalf("shelves = %d, want 2", len(page.Shelves))
	}
	if len(page.Moods) != 0 {
		t.Errorf("chips were also read as mood tiles: %+v", page.Moods)
	}
}

func TestHomeFirstPageContinuationIsTheListsNotAShelfs(t *testing.T) {
	pc, _ := ctxFor("home")
	// Go visits map keys in random order; one lucky run proves nothing.
	for i := 0; i < 20; i++ {
		page := ParseBrowsePage(loadFixture(t, "home_chip"), pc)
		if page.Continuation != "PAGE_TOKEN_2" {
			t.Fatalf("continuation = %q, want PAGE_TOKEN_2", page.Continuation)
		}
	}
}

func TestHomeContinuationPageParses(t *testing.T) {
	pc, _ := ctxFor("home")
	for i := 0; i < 20; i++ {
		page := ParseBrowsePage(loadFixture(t, "home_continuation"), pc)
		if page.Continuation != "PAGE_TOKEN_3" {
			t.Fatalf("continuation = %q, want PAGE_TOKEN_3", page.Continuation)
		}
		if len(page.Shelves) != 2 || page.Shelves[0].Title != "Fresh finds" || page.Shelves[1].Title != "Throwbacks" {
			t.Fatalf("shelves = %+v", page.Shelves)
		}
		if len(page.Shelves[1].Items) != 2 {
			t.Fatalf("Throwbacks items = %d, want 2", len(page.Shelves[1].Items))
		}
		if len(page.Chips) != 0 {
			t.Fatalf("continuation carried chips: %+v", page.Chips)
		}
	}
}

func TestHomeLastPageHasNoContinuation(t *testing.T) {
	pc, _ := ctxFor("home")
	for i := 0; i < 20; i++ {
		page := ParseBrowsePage(loadFixture(t, "home_continuation_end"), pc)
		if page.Continuation != "" {
			t.Fatalf("last page continues to %q", page.Continuation)
		}
		if len(page.Shelves) != 1 {
			t.Fatalf("shelves = %d, want 1", len(page.Shelves))
		}
	}
}

func TestHomeContinuationFromAppendedItems(t *testing.T) {
	doc := Node{"onResponseReceivedActions": []any{map[string]any{
		"appendContinuationItemsAction": map[string]any{"continuationItems": []any{
			map[string]any{"continuationItemRenderer": map[string]any{"continuationEndpoint": map[string]any{
				"continuationCommand": map[string]any{"token": "APPENDED_TOKEN"},
			}}},
		}},
	}}}
	if got := SectionListContinuation(doc); got != "APPENDED_TOKEN" {
		t.Fatalf("continuation = %q", got)
	}
}

// The recorded signed-out Home carries the chip row, none selected.
func TestRecordedHomeHasChips(t *testing.T) {
	pc, _ := ctxFor("home")
	page := ParseBrowsePage(loadFixture(t, "home"), pc)
	if len(page.Chips) < 5 {
		t.Fatalf("chips = %+v", page.Chips)
	}
	for _, c := range page.Chips {
		if c.Title == "" || c.Params == "" || c.Selected {
			t.Errorf("bad chip %+v", c)
		}
	}
	if page.Continuation == "" {
		t.Error("recorded home has no continuation")
	}
}
