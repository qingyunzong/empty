package clocksim

import (
	"fmt"
	"strings"
	"testing"
)

func TestIntervalOps(t *testing.T) {
	iv := Interval{Earliest: 3, Latest: 7}
	if !iv.Valid() || !iv.Contains(3) || !iv.Contains(7) || iv.Contains(8) {
		t.Fatalf("unexpected interval behavior for %s", iv)
	}
	if (Interval{Earliest: 8, Latest: 5}).Valid() {
		t.Fatal("inverted interval reported valid")
	}
	if !iv.Overlaps(Interval{Earliest: 7, Latest: 9}) {
		t.Fatal("touching intervals should overlap")
	}
	if iv.Overlaps(Interval{Earliest: 8, Latest: 9}) {
		t.Fatal("disjoint intervals reported overlapping")
	}
	if got := iv.Shift(2); got != (Interval{Earliest: 5, Latest: 9}) {
		t.Fatalf("Shift(2) = %s", got)
	}
}

func TestReadVisibleOnlyAfterCommitUpper(t *testing.T) {
	s := NewStore()
	w, err := s.Commit("k", "v", Interval{Earliest: 10, Latest: 14})
	if err != nil {
		t.Fatal(err)
	}
	// Earliest equal to the commit upper bound is still too early.
	if res := s.Read("k", Interval{Earliest: 14, Latest: 20}); res.Outcome != Pending {
		t.Fatalf("read at earliest=%d should be pending: %+v", w.CommitUpper(), res)
	}
	res := s.Read("k", Interval{Earliest: 15, Latest: 20})
	if res.Outcome != Visible || res.Write.Value != "v" {
		t.Fatalf("read after commit upper should be visible: %+v", res)
	}
	if res := s.Read("missing", Interval{Earliest: 99, Latest: 100}); res.Outcome != Pending {
		t.Fatalf("missing key should be pending: %+v", res)
	}
	if _, err := s.Commit("bad", "v", Interval{Earliest: 5, Latest: 2}); err == nil {
		t.Fatal("invalid commit interval accepted")
	}
}

func TestWaitVisibleProducesEvidence(t *testing.T) {
	s := NewStore()
	if _, err := s.Commit("k", "v", Interval{Earliest: 10, Latest: 14}); err != nil {
		t.Fatal(err)
	}
	c := NewClock("reader", Interval{Earliest: 9, Latest: 15}, 2)
	res, ev := s.WaitVisible(c, "k", 10)
	if res.Outcome != Visible {
		t.Fatalf("wait should resolve visible: %+v\nevidence:\n%s", res, ev)
	}
	if ev.Outcome != Visible || ev.CommitUpper != 14 {
		t.Fatalf("bad evidence: %+v", ev)
	}
	// Checks at earliest 9, 11, 13, 15 -> visible on the 4th check, 3 ticks.
	if ev.Ticks != 3 || len(ev.Observed) != 4 {
		t.Fatalf("evidence ticks=%d observed=%d, want 3 ticks and 4 checks", ev.Ticks, len(ev.Observed))
	}
	for i, iv := range ev.Observed {
		if want := int64(9 + 2*i); iv.Earliest != want {
			t.Fatalf("observed[%d].Earliest = %d, want %d", i, iv.Earliest, want)
		}
	}
	if !strings.Contains(ev.String(), "outcome=visible") {
		t.Fatalf("evidence string missing outcome:\n%s", ev)
	}
}

func TestWaitStalledClockReturnsPending(t *testing.T) {
	s := NewStore()
	if _, err := s.Commit("k", "v", Interval{Earliest: 10, Latest: 14}); err != nil {
		t.Fatal(err)
	}
	c := NewClock("stalled", Interval{Earliest: 9, Latest: 15}, 0)
	res, ev := s.WaitVisible(c, "k", 10)
	if res.Outcome != Pending || ev.Outcome != Pending {
		t.Fatalf("stalled clock should stay pending: %+v", res)
	}
	if !strings.Contains(ev.Reason, "no progress") {
		t.Fatalf("evidence should cite no progress, got %q", ev.Reason)
	}
	if len(ev.Observed) != 1 {
		t.Fatalf("stalled clock should be checked once, got %d", len(ev.Observed))
	}
}

func TestWaitTickBudgetExhausted(t *testing.T) {
	s := NewStore()
	if _, err := s.Commit("k", "v", Interval{Earliest: 10, Latest: 100}); err != nil {
		t.Fatal(err)
	}
	c := NewClock("slow", Interval{Earliest: 0, Latest: 5}, 1)
	res, ev := s.WaitVisible(c, "k", 3)
	if res.Outcome != Pending {
		t.Fatalf("should be pending: %+v", res)
	}
	if !strings.Contains(ev.Reason, "tick budget exhausted") {
		t.Fatalf("evidence should cite budget, got %q", ev.Reason)
	}
	if ev.Ticks != 3 || len(ev.Observed) != 4 {
		t.Fatalf("evidence ticks=%d observed=%d", ev.Ticks, len(ev.Observed))
	}
}

func TestVerifyNoEarlyReadSweep(t *testing.T) {
	s := NewStore()
	w, err := s.Commit("k", "v", Interval{Earliest: 10, Latest: 14})
	if err != nil {
		t.Fatal(err)
	}
	ivs := SweepIntervals(0, 30, 3, 1)
	if len(ivs) != 31 {
		t.Fatalf("sweep produced %d intervals, want 31", len(ivs))
	}
	overlap := OverlappingCommit(w, ivs)
	// Commit window [10,14]; width-3 intervals overlap it for earliest in [7,14].
	if len(overlap) != 8 {
		t.Fatalf("overlapping intervals = %d, want 8", len(overlap))
	}
	for _, iv := range overlap {
		if iv.Earliest > w.CommitUpper() {
			t.Fatalf("interval %s overlaps commit window but starts after commit upper", iv)
		}
	}
	if violations := VerifyNoEarlyRead(s, w, ivs); violations != nil {
		t.Fatalf("unexpected violations: %v", violations)
	}
}

func TestVerifyNoEarlyReadDetectsViolation(t *testing.T) {
	s := NewStore()
	w, err := s.Commit("k", "v", Interval{Earliest: 10, Latest: 14})
	if err != nil {
		t.Fatal(err)
	}
	// Corrupt the store by recommitting with a later upper bound, then
	// verify against the original write: reads in (14, 20] become early.
	if _, err := s.Commit("k", "v2", Interval{Earliest: 10, Latest: 20}); err != nil {
		t.Fatal(err)
	}
	ivs := SweepIntervals(15, 20, 2, 1)
	violations := VerifyNoEarlyRead(s, w, ivs)
	if len(violations) == 0 {
		t.Fatal("expected violations for reads before the original commit upper")
	}
	for _, v := range violations {
		if v.At.Earliest <= w.CommitUpper() {
			t.Fatalf("violation reported for non-early interval %s", v.At)
		}
	}
}

func ExampleStore_WaitVisible() {
	s := NewStore()
	_, _ = s.Commit("k", "v", Interval{Earliest: 10, Latest: 14})
	c := NewClock("reader", Interval{Earliest: 11, Latest: 13}, 2)
	res, ev := s.WaitVisible(c, "k", 5)
	fmt.Println(ev)
	fmt.Println("read:", res.Outcome, res.Write.Value)
	// Output:
	// wait key="k" commitUpper=14 outcome=visible ticks=2 reason="earliest 15 > commit upper 14"
	//   check 0: now=[11,13]
	//   check 1: now=[13,15]
	//   check 2: now=[15,17]
	// read: visible v
}
