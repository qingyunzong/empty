package logcheck

import (
	"fmt"
	"math/rand"
	"testing"
)

func entries(values ...string) []Entry {
	out := make([]Entry, len(values))
	for i, v := range values {
		out[i] = Entry{Seq: int64(i + 1), Value: v}
	}
	return out
}

func node(id string, status Status, values ...string) *Node {
	return &Node{ID: id, Status: status, Log: entries(values...)}
}

func TestFullReportConsistent(t *testing.T) {
	rep, err := FullReport([]*Node{
		node("n1", StatusAlive, "a", "b", "c"),
		node("n2", StatusCrashed, "a", "b"),
		node("n3", StatusAlive, "a", "b", "c"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != VerdictOK {
		t.Fatalf("verdict = %s, want OK", rep.Verdict)
	}
	if len(rep.Short) != 1 || rep.Short[0].NodeID != "n2" || !rep.Short[0].Allowed {
		t.Fatalf("short notes = %+v, want n2 allowed", rep.Short)
	}
}

func TestFullReportEarliestConflictAndSources(t *testing.T) {
	rep, err := FullReport([]*Node{
		node("n1", StatusAlive, "a", "b", "c", "d"),
		node("n2", StatusAlive, "a", "x", "c", "d"),
		node("n3", StatusAlive, "a", "b", "c", "y"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != VerdictConflict {
		t.Fatalf("verdict = %s, want CONFLICT", rep.Verdict)
	}
	c := rep.Conflict
	if c.Index != 1 || c.SourceA != "n1" || c.SourceB != "n2" {
		t.Fatalf("conflict = %+v, want index 1 sources n1,n2", c)
	}
	if c.EntryA.Value != "b" || c.EntryB.Value != "x" {
		t.Fatalf("conflict entries = %+v", c)
	}
}

// The conflicting pair must be the lexicographically smallest pair among
// those diverging at the earliest index, even when the reference (the
// longest log) is not part of that pair.
func TestConflictPairTieBreak(t *testing.T) {
	rep, err := FullReport([]*Node{
		node("a", StatusAlive, "x", "y"),
		node("b", StatusAlive, "x", "y", "z"),
		node("c", StatusAlive, "x", "w"),
	})
	if err != nil {
		t.Fatal(err)
	}
	c := rep.Conflict
	if c.Index != 1 || c.SourceA != "a" || c.SourceB != "c" {
		t.Fatalf("conflict = %+v, want index 1 sources a,c", c)
	}
}

func TestCrashedNodeMayHoldShortPrefix(t *testing.T) {
	rep, err := FullReport([]*Node{
		node("n1", StatusAlive, "a", "b", "c"),
		node("n2", StatusCrashed, "a"),
		node("n3", StatusAlive, "a", "b", "c"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != VerdictOK {
		t.Fatalf("verdict = %s, want OK (crashed short prefix allowed)", rep.Verdict)
	}
}

// A node of unknown status with a short prefix must not be counted as a
// fault.
func TestUnknownStatusIsNotAFault(t *testing.T) {
	rep, err := FullReport([]*Node{
		node("n1", StatusAlive, "a", "b", "c"),
		node("n2", StatusUnknown, "a"),
		node("n3", StatusAlive, "a", "b", "c"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != VerdictOK {
		t.Fatalf("verdict = %s, want OK (unknown status is not a fault)", rep.Verdict)
	}
	if len(rep.Short) != 1 || rep.Short[0].NodeID != "n2" || !rep.Short[0].Allowed {
		t.Fatalf("short notes = %+v, want n2 recorded but not a fault", rep.Short)
	}
}

func TestAliveNodeShortPrefixIsFault(t *testing.T) {
	rep, err := FullReport([]*Node{
		node("n1", StatusAlive, "a", "b", "c"),
		node("n2", StatusAlive, "a"),
		node("n3", StatusAlive, "a", "b", "c"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != VerdictShortPrefix {
		t.Fatalf("verdict = %s, want SHORT_PREFIX", rep.Verdict)
	}
	if len(rep.Short) != 1 || rep.Short[0].NodeID != "n2" || rep.Short[0].Allowed {
		t.Fatalf("short notes = %+v, want n2 not allowed", rep.Short)
	}
}

// A crashed node is allowed a short prefix, never a diverging entry.
func TestCrashedNodeConflictStillReported(t *testing.T) {
	rep, err := FullReport([]*Node{
		node("n1", StatusAlive, "a", "b"),
		node("n2", StatusCrashed, "a", "x"),
		node("n3", StatusAlive, "a", "b"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != VerdictConflict || rep.Conflict.Index != 1 {
		t.Fatalf("verdict = %s conflict = %+v, want CONFLICT at 1", rep.Verdict, rep.Conflict)
	}
}

func TestParseStatus(t *testing.T) {
	for _, s := range []Status{StatusAlive, StatusCrashed, StatusUnknown} {
		if got, err := ParseStatus(string(s)); err != nil || got != s {
			t.Fatalf("ParseStatus(%q) = %v, %v", s, got, err)
		}
	}
	if _, err := ParseStatus("bogus"); err == nil {
		t.Fatal("ParseStatus(bogus) succeeded, want error")
	}
}

func TestAppendRejectsBadInput(t *testing.T) {
	c, err := NewChecker([]*Node{
		node("n1", StatusAlive, "a"),
		node("n2", StatusAlive),
		node("n3", StatusAlive),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Append("ghost", Entry{Seq: 1, Value: "x"}); err == nil {
		t.Fatal("append to unknown node succeeded, want error")
	}
	if err := c.Append("n1", Entry{Seq: 1, Value: "x"}); err == nil {
		t.Fatal("append with non-increasing seq succeeded, want error")
	}
	if err := c.Append("n2", Entry{Seq: 5, Value: "x"}, Entry{Seq: 5, Value: "y"}); err == nil {
		t.Fatal("append with duplicate seq succeeded, want error")
	}
}

func TestIncrementalMatchesFullModelScripted(t *testing.T) {
	nodes := []*Node{
		node("n1", StatusAlive),
		node("n2", StatusCrashed),
		node("n3", StatusUnknown),
	}
	c, err := NewChecker(nodes)
	if err != nil {
		t.Fatal(err)
	}
	steps := []struct {
		node    string
		entries []Entry
	}{
		{"n1", entries("a", "b", "c")},
		{"n2", entries("a", "b")},
		{"n3", entries("a")},
		{"n3", []Entry{{Seq: 2, Value: "b"}}},
		{"n1", []Entry{{Seq: 4, Value: "d"}}},
		{"n2", []Entry{{Seq: 3, Value: "X"}}}, // divergence at index 2
	}
	for i, s := range steps {
		if err := c.Append(s.node, s.entries...); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		assertModelsAgree(t, c, nodes, fmt.Sprintf("step %d", i))
	}
	rep := c.Report()
	if rep.Verdict != VerdictConflict || rep.Conflict.Index != 2 ||
		rep.Conflict.SourceA != "n1" || rep.Conflict.SourceB != "n2" {
		t.Fatalf("final report = %+v", rep)
	}
}

func assertModelsAgree(t *testing.T, c *Checker, nodes []*Node, ctx string) {
	t.Helper()
	inc := c.Report()
	full, err := FullReport(nodes)
	if err != nil {
		t.Fatalf("%s: full model: %v", ctx, err)
	}
	if !sameReport(inc, full) {
		t.Fatalf("%s: incremental %+v != full model %+v", ctx, inc, full)
	}
}

func sameReport(a, b Report) bool {
	if a.Verdict != b.Verdict || len(a.Short) != len(b.Short) {
		return false
	}
	if (a.Conflict == nil) != (b.Conflict == nil) {
		return false
	}
	if a.Conflict != nil && *a.Conflict != *b.Conflict {
		return false
	}
	for i := range a.Short {
		if a.Short[i] != b.Short[i] {
			return false
		}
	}
	return true
}

// Randomized cross-check: after every incremental append, the checker's
// report must equal the full all-pairs model's report, both for the
// live checker and for a checker rebuilt from scratch.
func TestIncrementalMatchesFullModelRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	statuses := []Status{StatusAlive, StatusCrashed, StatusUnknown}
	for trial := 0; trial < 200; trial++ {
		nodes := []*Node{
			{ID: "n1", Status: statuses[rng.Intn(3)]},
			{ID: "n2", Status: statuses[rng.Intn(3)]},
			{ID: "n3", Status: statuses[rng.Intn(3)]},
		}
		c, err := NewChecker(nodes)
		if err != nil {
			t.Fatal(err)
		}
		seqs := map[string]int64{"n1": 1, "n2": 1, "n3": 1}
		for step := 0; step < 40; step++ {
			id := fmt.Sprintf("n%d", rng.Intn(3)+1)
			batch := rng.Intn(3) + 1
			var batchEntries []Entry
			for k := 0; k < batch; k++ {
				// Small alphabet forces frequent divergences.
				value := string(rune('a' + rng.Intn(3)))
				batchEntries = append(batchEntries, Entry{Seq: seqs[id], Value: value})
				seqs[id]++
			}
			if err := c.Append(id, batchEntries...); err != nil {
				t.Fatalf("trial %d step %d: %v", trial, step, err)
			}
			ctx := fmt.Sprintf("trial %d step %d", trial, step)
			assertModelsAgree(t, c, nodes, ctx)

			rebuilt, err := NewChecker(nodes)
			if err != nil {
				t.Fatal(err)
			}
			assertModelsAgree(t, rebuilt, nodes, ctx+" rebuilt")
		}
	}
}
