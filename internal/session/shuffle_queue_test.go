package session

import "testing"

// The queue panel lists Items after Index as "next". While shuffled that has
// to be the truth, or the listener edits a list that playback ignores.
func TestShuffledQueueIsThePlayOrder(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 8)
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})

	for range 7 {
		q := c.State().Queue
		want := q.Items[q.Index+1].ID
		c.Apply(Command{Kind: CmdNext})
		if got := currentID(c); got != want {
			t.Fatalf("queue listed %q next but %q played", want, got)
		}
	}
}

func TestMovingWhileShuffledChangesWhatPlaysNext(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 8)
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})

	q := c.State().Queue
	last := len(q.Items) - 1
	picked := q.Items[last].ID
	c.Apply(Command{Kind: CmdMove, From: last, To: q.Index + 1})
	c.Apply(Command{Kind: CmdNext})
	if got := currentID(c); got != picked {
		t.Fatalf("moved %q to next, but %q played", picked, got)
	}
}

func TestRemovingWhileShuffledSkipsThatTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 8)
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})

	q := c.State().Queue
	gone := q.Items[q.Index+1].ID
	c.Apply(Command{Kind: CmdRemove, At: q.Index + 1})
	for range 6 {
		c.Apply(Command{Kind: CmdNext})
		if currentID(c) == gone {
			t.Fatalf("removed track %q still played", gone)
		}
	}
}
