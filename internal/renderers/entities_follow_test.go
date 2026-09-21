package renderers

import "testing"

/*
The artist header states whether the account follows the artist.

The Follow button was optimistic — it assumed "not following" and flipped on
click — because this was assumed not to exist. It does: the same subscribe
button the subscriber count comes from carries a `subscribed` flag.
*/
func TestArtistCarriesFollowState(t *testing.T) {
	doc := loadFixture(t, "artist")
	ar, ok := ParseArtist(doc, "UC_kRDKYrUlrbtrSiyu5Tflg", ParseContext{Surface: "artist"})
	if !ok {
		t.Fatal("artist did not parse")
	}

	// The fixture was recorded against an account that does not follow this
	// artist, so the parsed value must be false rather than merely absent.
	if ar.Following {
		t.Fatalf("%s: parsed as followed, but the fixture says subscribed=false", ar.Name)
	}

	// A subscriber count proves the button was found at all — without it a
	// false above would pass for the wrong reason.
	if ar.Subscribers == "" {
		t.Fatal("no subscriber count, so the subscribe button was never read")
	}
}

/*
And it reads true when the account does follow.

False is Go's zero value, so the fixture above would pass even if nothing read
the flag at all. Flipping it in the document is what proves the wiring.
*/
func TestArtistFollowStateIsRead(t *testing.T) {
	doc := loadFixture(t, "artist")

	btn := Find(doc, "subscribeButtonRenderer")
	if btn == nil {
		t.Fatal("fixture has no subscribe button")
	}
	if btn["subscribed"] != false {
		t.Fatalf("fixture already reads subscribed=%v, so flipping it proves nothing", btn["subscribed"])
	}
	btn["subscribed"] = true

	ar, ok := ParseArtist(doc, "UC_kRDKYrUlrbtrSiyu5Tflg", ParseContext{Surface: "artist"})
	if !ok {
		t.Fatal("artist did not parse")
	}
	if !ar.Following {
		t.Fatal("the header says subscribed, but the artist came back unfollowed")
	}
}
