package session

import "testing"

// Going back to a song already played is a jump within the queue: the queue
// and its order stay as they are, shuffled or not.
func TestJumpPlaysAnEarlierTrackWithoutRebuildingTheQueue(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 5)
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})
	c.Apply(Command{Kind: CmdNext})
	c.Apply(Command{Kind: CmdNext})
	before := append([]string(nil), ids(c)...)
	earlier := before[0]

	if r, _ := c.Apply(Command{Kind: CmdJump, At: 0}); r != RejectNone {
		t.Fatalf("rejected: %s", r)
	}
	if currentID(c) != earlier {
		t.Fatalf("playing %q, want %q", currentID(c), earlier)
	}
	for i, id := range ids(c) {
		if id != before[i] {
			t.Fatalf("the queue changed: %v -> %v", before, ids(c))
		}
	}
	if !c.Target().UserChange {
		t.Error("a jump is the listener's choice and should cut")
	}
	if r, _ := c.Apply(Command{Kind: CmdJump, At: 99}); r != RejectOutOfRange {
		t.Errorf("out of range jump: %s", r)
	}
}

func ids(c *Core) []string {
	var out []string
	for _, t := range c.State().Queue.Items {
		out = append(out, t.ID)
	}
	return out
}
