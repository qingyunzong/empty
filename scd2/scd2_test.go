package scd2

import (
	"fmt"
	"testing"
	"time"
)

func ts(day int) time.Time {
	return time.Date(2026, 1, day, 0, 0, 0, 0, time.UTC)
}

func mustValidate(t *testing.T, s *Store[string]) {
	t.Helper()
	if err := s.Validate(); err != nil {
		t.Fatalf("invariant violated: %v", err)
	}
}

func wantIntervals(t *testing.T, s *Store[string], key string, want []Interval[string]) {
	t.Helper()
	got := s.Intervals(key)
	if len(got) != len(want) {
		t.Fatalf("intervals = %v, want %v", got, want)
	}
	for i := range want {
		g, w := got[i], want[i]
		if !g.From.Equal(w.From) || !g.To.Equal(w.To) || g.Attrs != w.Attrs {
			t.Fatalf("intervals = %v, want %v", got, want)
		}
	}
	mustValidate(t, s)
}

func wantAsOf(t *testing.T, s *Store[string], key string, at time.Time, want string, wantOK bool) {
	t.Helper()
	iv, ok := s.AsOf(key, at)
	if ok != wantOK || (ok && iv.Attrs != want) {
		t.Fatalf("AsOf(%s, %s) = (%v, %v), want (%q, %v)", key, at, iv, ok, want, wantOK)
	}
}

func iv(from, to int, attrs string) Interval[string] {
	iv := Interval[string]{From: ts(from), Attrs: attrs}
	if to > 0 {
		iv.To = ts(to)
	}
	return iv
}

func TestInsertThenChange(t *testing.T) {
	s := New[string]()

	cs := s.UpsertAt("k", ts(10), "A")
	if a, u, r := cs.Counts(); a != 1 || u != 0 || r != 0 {
		t.Fatalf("insert changeset = %v", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 0, "A")})

	cs = s.UpsertAt("k", ts(20), "B")
	if a, u, r := cs.Counts(); a != 1 || u != 1 || r != 0 {
		t.Fatalf("change changeset = %v, want 1 add + 1 update", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 20, "A"), iv(20, 0, "B")})

	cur, ok := s.Current("k")
	if !ok || cur.Attrs != "B" {
		t.Fatalf("Current = %v, %v", cur, ok)
	}
}

func TestLateArrivingChangeSplitsInterval(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.UpsertAt("k", ts(30), "C")

	cs := s.UpsertAt("k", ts(20), "B")
	if a, u, r := cs.Counts(); a != 1 || u != 1 || r != 0 {
		t.Fatalf("split changeset = %v, want 1 add + 1 update", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{
		iv(10, 20, "A"), iv(20, 30, "B"), iv(30, 0, "C"),
	})
	wantAsOf(t, s, "k", ts(15), "A", true)
	wantAsOf(t, s, "k", ts(25), "B", true)
	wantAsOf(t, s, "k", ts(30), "C", true)
}

func TestLateArrivingInsertBeforeFirst(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(30), "B")
	s.UpsertAt("k", ts(10), "A")
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 30, "A"), iv(30, 0, "B")})
	wantAsOf(t, s, "k", ts(5), "", false)
	wantAsOf(t, s, "k", ts(10), "A", true)
}

func TestNoOpUpsertMerges(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")

	// Same attributes later: merged back into one open interval, no changes.
	cs := s.UpsertAt("k", ts(20), "A")
	if !cs.Empty() {
		t.Fatalf("no-op upsert produced %v", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 0, "A")})
}

func TestAdjacentEqualIntervalsMerge(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.UpsertAt("k", ts(20), "B")

	// Change back to A at 20: the two A-runs merge into one.
	cs := s.UpsertAt("k", ts(20), "A")
	if a, u, r := cs.Counts(); a != 0 || u != 1 || r != 1 {
		t.Fatalf("merge changeset = %v, want 1 update + 1 remove", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 0, "A")})
}

func TestLateUpsertEqualToCoveringIsNoOp(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.UpsertAt("k", ts(30), "B")

	cs := s.UpsertAt("k", ts(20), "A")
	if !cs.Empty() {
		t.Fatalf("equal late upsert produced %v", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 30, "A"), iv(30, 0, "B")})
}

func TestDeleteClosesCurrent(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")

	cs := s.DeleteAt("k", ts(20))
	if a, u, r := cs.Counts(); a != 0 || u != 1 || r != 0 {
		t.Fatalf("delete changeset = %v, want 1 update", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 20, "A")})
	if _, ok := s.Current("k"); ok {
		t.Fatal("current row still present after delete")
	}
	wantAsOf(t, s, "k", ts(15), "A", true)
	wantAsOf(t, s, "k", ts(20), "", false)
}

func TestDeleteInMiddleKeepsLaterIntervals(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.UpsertAt("k", ts(40), "C")

	s.DeleteAt("k", ts(20))
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 20, "A"), iv(40, 0, "C")})
	wantAsOf(t, s, "k", ts(25), "", false)
	wantAsOf(t, s, "k", ts(45), "C", true)
}

func TestReinsertAfterDelete(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.DeleteAt("k", ts(20))
	s.UpsertAt("k", ts(30), "B")
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 20, "A"), iv(30, 0, "B")})
	wantAsOf(t, s, "k", ts(25), "", false)
	wantAsOf(t, s, "k", ts(30), "B", true)
}

func TestLateDeleteSplitsInterval(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.UpsertAt("k", ts(30), "B")

	// Late delete at 30 removes exactly the B interval.
	cs := s.DeleteAt("k", ts(30))
	if a, u, r := cs.Counts(); a != 0 || u != 0 || r != 1 {
		t.Fatalf("late delete changeset = %v, want 1 remove", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 30, "A")})
}

func TestSameTimestampChangeLastWriteWins(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")

	cs := s.UpsertAt("k", ts(10), "B")
	if a, u, r := cs.Counts(); a != 0 || u != 1 || r != 0 {
		t.Fatalf("same-ts changeset = %v, want 1 update", cs)
	}
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 0, "B")})
}

func TestDeleteUnknownKeyIsNoOp(t *testing.T) {
	s := New[string]()
	if cs := s.DeleteAt("missing", ts(10)); !cs.Empty() {
		t.Fatalf("delete on missing key produced %v", cs)
	}
}

func TestLateChangeInsideMergedIntervalKeepsTail(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.UpsertAt("k", ts(20), "A") // merges into [10, inf)
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 0, "A")})

	// Late change at 15: the tail beyond the recorded event at 20
	// must fall back to A.
	s.UpsertAt("k", ts(15), "B")
	wantIntervals(t, s, "k", []Interval[string]{
		iv(10, 15, "A"), iv(15, 20, "B"), iv(20, 0, "A"),
	})
	wantAsOf(t, s, "k", ts(17), "B", true)
	wantAsOf(t, s, "k", ts(25), "A", true)
}

func TestLateDeleteInsideMergedIntervalKeepsTail(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.UpsertAt("k", ts(20), "A") // merges into [10, inf)

	s.DeleteAt("k", ts(15))
	wantIntervals(t, s, "k", []Interval[string]{iv(10, 15, "A"), iv(20, 0, "A")})
	wantAsOf(t, s, "k", ts(17), "", false)
	wantAsOf(t, s, "k", ts(25), "A", true)
}

func TestDeleteAtStartOfMergedIntervalKeepsTail(t *testing.T) {
	s := New[string]()
	s.UpsertAt("k", ts(10), "A")
	s.UpsertAt("k", ts(20), "A") // merges into [10, inf)

	s.DeleteAt("k", ts(10))
	wantIntervals(t, s, "k", []Interval[string]{iv(20, 0, "A")})
	wantAsOf(t, s, "k", ts(10), "", false)
	wantAsOf(t, s, "k", ts(20), "A", true)
}

func TestKeysAreIndependent(t *testing.T) {
	s := New[string]()
	s.UpsertAt("a", ts(1), "A")
	s.UpsertAt("b", ts(5), "B")
	s.DeleteAt("a", ts(10))
	wantIntervals(t, s, "a", []Interval[string]{iv(1, 10, "A")})
	wantIntervals(t, s, "b", []Interval[string]{iv(5, 0, "B")})
}

func ExampleStore() {
	s := New[string]()
	s.UpsertAt("cust-1", ts(1), "gold")
	s.UpsertAt("cust-1", ts(10), "platinum")

	// Late-arriving correction: the customer was silver from day 5.
	for _, c := range s.UpsertAt("cust-1", ts(5), "silver") {
		fmt.Println(c)
	}
	if iv, ok := s.AsOf("cust-1", ts(7)); ok {
		fmt.Println("as of day 7:", iv.Attrs)
	}
	// Output:
	// UPDATE cust-1[2026-01-01T00:00:00Z, 2026-01-10T00:00:00Z)=gold -> cust-1[2026-01-01T00:00:00Z, 2026-01-05T00:00:00Z)=gold
	// ADD    cust-1[2026-01-05T00:00:00Z, 2026-01-10T00:00:00Z)=silver
	// as of day 7: silver
}
