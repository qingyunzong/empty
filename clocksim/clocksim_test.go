package clocksim

import (
	"strings"
	"testing"
)

// A read must not be visible while the reader's earliest possible "now" is
// still at or before the write's commit upper bound.
func TestReadNotVisibleBeforeCommitBound(t *testing.T) {
	writer := NewNode("writer", NewManualClock(100, 10, 5))
	vv := writer.Write("k", "v") // commit interval [100,105]

	reader := NewNode("reader", NewManualClock(105, 10, 5)) // earliest 105 <= 105
	if _, ok := reader.storeReadFrom(vv); ok {
		t.Fatalf("read served too early: reader earliest %d, commit latest %d",
			reader.Clock.Now().Earliest, vv.Commit.Latest)
	}
}

// helper: evaluate visibility of an arbitrary committed value on this node.
func (n *Node) storeReadFrom(vv VersionedValue) (VersionedValue, bool) {
	if !VisibleAt(n.Clock.Now(), vv.Commit) {
		return VersionedValue{}, false
	}
	return vv, true
}

// Waiting with virtual ticks eventually makes the read visible, and the
// evidence records every tick.
func TestWaitForVisibleSucceeds(t *testing.T) {
	writer := NewNode("w", NewManualClock(0, 10, 20))
	writer.Write("k", "v") // commit [0,20]

	reader := NewNode("r", NewManualClock(0, 10, 20))
	reader.store["k"] = mustLookup(t, writer, "k")

	vv, ok, ev := reader.WaitForVisible("k", 10)
	t.Logf("evidence: %s", ev)
	if !ok {
		t.Fatalf("expected visible, got outcome %s", ev.Outcome)
	}
	if ev.Outcome != Visible {
		t.Fatalf("outcome = %s, want visible", ev.Outcome)
	}
	if vv.Value != "v" {
		t.Fatalf("value = %q, want %q", vv.Value, "v")
	}
	// Need earliest > 20 from start 0 with step 10: ticks to 10, 20, 30.
	if len(ev.AfterTicks) != 3 {
		t.Fatalf("ticks = %d, want 3 (%v)", len(ev.AfterTicks), ev.AfterTicks)
	}
	if ev.End.Earliest <= ev.CommitLatest {
		t.Fatalf("evidence end earliest %d not past commit latest %d",
			ev.End.Earliest, ev.CommitLatest)
	}
}

// A stalled clock makes no progress, so the wait returns pending immediately
// after the first tick, with evidence.
func TestWaitPendingNoProgress(t *testing.T) {
	writer := NewNode("w", NewManualClock(0, 10, 20))
	writer.Write("k", "v")

	reader := NewNode("r", NewManualClock(0, 10, 20))
	reader.store["k"] = mustLookup(t, writer, "k")
	reader.Clock.Stall()

	_, ok, ev := reader.WaitForVisible("k", 100)
	t.Logf("evidence: %s", ev)
	if ok {
		t.Fatal("stalled clock must not serve the read")
	}
	if ev.Outcome != PendingNoProgress {
		t.Fatalf("outcome = %s, want pending-no-progress", ev.Outcome)
	}
	if len(ev.AfterTicks) != 1 {
		t.Fatalf("ticks = %d, want 1 (stop at first non-progress tick)", len(ev.AfterTicks))
	}
	if ev.AfterTicks[0] != ev.Start {
		t.Fatalf("non-progress tick changed interval: start=%v after=%v", ev.Start, ev.AfterTicks[0])
	}
}

// If the tick budget runs out before visibility, the wait is pending.
func TestWaitPendingTickLimit(t *testing.T) {
	writer := NewNode("w", NewManualClock(0, 10, 20))
	writer.Write("k", "v")

	reader := NewNode("r", NewManualClock(0, 10, 20))
	reader.store["k"] = mustLookup(t, writer, "k")

	_, ok, ev := reader.WaitForVisible("k", 2) // needs 3 ticks
	t.Logf("evidence: %s", ev)
	if ok || ev.Outcome != PendingTickLimit {
		t.Fatalf("ok=%v outcome=%s, want pending-tick-limit", ok, ev.Outcome)
	}
}

// End-to-end: several nodes with skewed, overlapping clocks. Reads are only
// served after waiting. Enumerate every overlapping reader/commit interval
// pair and verify none of them was served.
func TestEnumerateOverlapsVerifyNoEarlyReads(t *testing.T) {
	// Three nodes, same uncertainty, skewed starts so intervals overlap.
	w1 := NewNode("w1", NewManualClock(0, 7, 30))
	w2 := NewNode("w2", NewManualClock(15, 7, 30))
	r := NewNode("r", NewManualClock(5, 7, 30))

	v1 := w1.Write("a", "1")
	v2 := w2.Write("b", "2")
	r.store["a"] = v1
	r.store["b"] = v2

	var events []ReadEvent

	// Attempt 1: immediate read of "a" — intervals overlap, must not serve.
	if _, ok := r.Read("a"); ok {
		t.Fatal("immediate read of 'a' served while intervals overlap")
	}
	events = append(events, ReadEvent{
		ReaderID: r.ID, WriterID: w1.ID, Key: "a",
		ReaderInterval: r.Clock.Now(), Commit: v1.Commit, Served: false,
	})

	// Attempt 2: wait for "a" and "b" until visible, then serve.
	for _, key := range []string{"a", "b"} {
		vv, ok, ev := r.WaitForVisible(key, 100)
		t.Logf("evidence: %s", ev)
		if !ok {
			t.Fatalf("read of %q never became visible: %s", key, ev.Outcome)
		}
		writerID := w1.ID
		if key == "b" {
			writerID = w2.ID
		}
		events = append(events, ReadEvent{
			ReaderID: r.ID, WriterID: writerID, Key: key,
			ReaderInterval: ev.End, Commit: vv.Commit, Served: true,
		})
	}

	overlaps := EnumerateOverlaps(events)
	if len(overlaps) == 0 {
		t.Fatal("expected at least one overlapping reader/commit interval pair")
	}
	for _, p := range overlaps {
		t.Logf("overlap: reader=%s[%d,%d] commit=%s[%d,%d] served=%v",
			p.ReaderID, p.Reader.Earliest, p.Reader.Latest,
			p.WriterID, p.Commit.Earliest, p.Commit.Latest, p.Served)
		if p.Served {
			t.Errorf("overlapping pair was served: %+v", p)
		}
	}

	if violations := Verify(events); len(violations) != 0 {
		for _, v := range violations {
			t.Errorf("violation: %s", v)
		}
	}
}

// Verify must catch a read that was served while the reader interval still
// overlapped the commit upper bound.
func TestVerifyCatchesEarlyRead(t *testing.T) {
	events := []ReadEvent{{
		ReaderID: "r", WriterID: "w", Key: "k",
		ReaderInterval: Interval{Earliest: 10, Latest: 40},
		Commit:         Interval{Earliest: 0, Latest: 20},
		Served:         true, // earliest 10 <= commit latest 20: too early
	}}
	violations := Verify(events)
	if len(violations) != 1 {
		t.Fatalf("violations = %d, want 1", len(violations))
	}
	if !strings.Contains(violations[0].Reason, "commit upper bound") {
		t.Fatalf("unexpected reason: %s", violations[0].Reason)
	}
}

func mustLookup(t *testing.T, n *Node, key string) VersionedValue {
	t.Helper()
	vv, ok := n.Lookup(key)
	if !ok {
		t.Fatalf("key %q not found on node %s", key, n.ID)
	}
	return vv
}
