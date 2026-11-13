package dataeng

import (
	"errors"
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)

func at(sec float64) time.Time {
	return t0.Add(time.Duration(sec * float64(time.Second)))
}

// distTable models a network where staying on the same road costs the
// 10 m spacing of the test fixes, while switching roads implies a 200 m
// detour.
func distTable(from, to Candidate) (float64, bool) {
	if from.RoadID == to.RoadID {
		return 10, true
	}
	return 200, true
}

func obs(sec float64, sigma float64, cands ...Candidate) Observation {
	return Observation{
		Time:  at(sec),
		X:     sec * 10, // 10 m per step
		Sigma: sigma,
		Cands: cands,
	}
}

func roadIDs(ms []Match) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.RoadID
	}
	return out
}

func TestStablePrefixCommitsOnWindowOverflow(t *testing.T) {
	m := New(Config{Window: 3}, distTable)
	var committed []Match
	for i := 0; i < 6; i++ {
		out, err := m.Add(obs(float64(i), 5,
			Candidate{RoadID: "A", Off: 1},
			Candidate{RoadID: "B", Off: 40},
		))
		if err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
		committed = append(committed, out...)
	}
	if len(committed) != 3 {
		t.Fatalf("committed %d matches, want 3", len(committed))
	}
	for i, mt := range committed {
		if mt.RoadID != "A" {
			t.Errorf("committed[%d].RoadID = %q, want A", i, mt.RoadID)
		}
		if mt.Segment != 1 {
			t.Errorf("committed[%d].Segment = %d, want 1", i, mt.Segment)
		}
		if !mt.Time.Equal(at(float64(i))) {
			t.Errorf("committed[%d].Time = %v, want %v", i, mt.Time, at(float64(i)))
		}
	}
	rest := m.Flush()
	if len(rest) != 3 {
		t.Fatalf("Flush returned %d matches, want 3", len(rest))
	}
	for _, mt := range rest {
		if mt.RoadID != "A" {
			t.Errorf("flushed RoadID = %q, want A", mt.RoadID)
		}
	}
}

func TestLatePointRevisesUnstableTail(t *testing.T) {
	m := New(Config{Window: 10, Watermark: 30 * time.Second}, distTable)
	// Ambiguous fixes: ties resolve to the lexicographically smaller road.
	for i := 0; i < 5; i++ {
		if _, err := m.Add(obs(float64(i), 5,
			Candidate{RoadID: "B", Off: 5},
			Candidate{RoadID: "A", Off: 5},
		)); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	if got := roadIDs(m.Tail()); got[2] != "A" {
		t.Fatalf("tail[2] = %q before late point, want A", got[2])
	}
	// A late point at t=2.5 with overwhelming evidence for B revises the tail.
	if _, err := m.Add(obs(2.5, 5,
		Candidate{RoadID: "A", Off: 100},
		Candidate{RoadID: "B", Off: 0},
	)); err != nil {
		t.Fatalf("late Add: %v", err)
	}
	got := roadIDs(m.Tail())
	if len(got) != 6 {
		t.Fatalf("tail length = %d, want 6", len(got))
	}
	if got[3] != "B" {
		t.Errorf("tail[3] = %q after late point, want B", got[3])
	}
}

func TestLatePointRejectedBeyondWatermark(t *testing.T) {
	m := New(Config{Window: 2, Watermark: time.Second}, distTable)
	c := []Candidate{{RoadID: "A", Off: 1}}
	for i := 0; i < 5; i++ {
		if _, err := m.Add(obs(float64(i), 5, c...)); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	// t=1 is older than the committed prefix (window 2 committed t0..t2).
	if _, err := m.Add(obs(1, 5, c...)); !errors.Is(err, ErrTooLate) {
		t.Errorf("committed-prefix late point: err = %v, want ErrTooLate", err)
	}
	// t=2.5 is uncommitted but 2.5 s behind the newest fix, beyond the 1 s watermark.
	if _, err := m.Add(obs(2.5, 5, c...)); !errors.Is(err, ErrTooLate) {
		t.Errorf("beyond-watermark late point: err = %v, want ErrTooLate", err)
	}
	// t=3.5 is within the watermark and must be accepted.
	if _, err := m.Add(obs(3.5, 5, c...)); err != nil {
		t.Errorf("in-watermark late point: err = %v, want nil", err)
	}
	// Duplicate timestamps are rejected.
	if _, err := m.Add(obs(3.5, 5, c...)); !errors.Is(err, ErrDuplicateTime) {
		t.Errorf("duplicate time: err = %v, want ErrDuplicateTime", err)
	}
}

func TestGapStartsNewSegment(t *testing.T) {
	m := New(Config{Window: 10, Gap: 5 * time.Second}, distTable)
	c := []Candidate{{RoadID: "A", Off: 1}}
	if _, err := m.Add(obs(0, 5, c...)); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Add(obs(1, 5, c...)); err != nil {
		t.Fatal(err)
	}
	// 10 s later exceeds the 5 s gap threshold: the first segment commits.
	out, err := m.Add(obs(10, 5, c...))
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 {
		t.Fatalf("gap Add committed %d matches, want 2", len(out))
	}
	for _, mt := range out {
		if mt.Segment != 1 {
			t.Errorf("pre-gap match Segment = %d, want 1", mt.Segment)
		}
	}
	rest := m.Flush()
	if len(rest) != 1 || rest[0].Segment != 2 {
		t.Fatalf("post-gap Flush = %+v, want one match in segment 2", rest)
	}
}

func TestTieBreaksToSmallerRoadID(t *testing.T) {
	m := New(Config{Window: 10}, distTable)
	// Candidates supplied in reverse order with identical scores.
	for i := 0; i < 3; i++ {
		if _, err := m.Add(obs(float64(i), 5,
			Candidate{RoadID: "C", Off: 5},
			Candidate{RoadID: "B", Off: 5},
			Candidate{RoadID: "A", Off: 5},
		)); err != nil {
			t.Fatal(err)
		}
	}
	for i, mt := range m.Flush() {
		if mt.RoadID != "A" {
			t.Errorf("match[%d].RoadID = %q, want A", i, mt.RoadID)
		}
	}
}

func TestUnreachableTransitionForced(t *testing.T) {
	dist := func(from, to Candidate) (float64, bool) {
		if from.RoadID == "A" && to.RoadID == "B" {
			return 0, false // no route from A to B
		}
		return 10, true
	}
	m := New(Config{Window: 10}, dist)
	// First fix prefers A, second prefers B; the A->B ban must keep the
	// path on B for both fixes.
	if _, err := m.Add(obs(0, 5, Candidate{RoadID: "A", Off: 0}, Candidate{RoadID: "B", Off: 8})); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Add(obs(1, 5, Candidate{RoadID: "A", Off: 20}, Candidate{RoadID: "B", Off: 0})); err != nil {
		t.Fatal(err)
	}
	got := roadIDs(m.Flush())
	if got[0] != "B" || got[1] != "B" {
		t.Errorf("path = %v, want [B B]", got)
	}
}

func TestLogDomainScoresAreFinite(t *testing.T) {
	m := New(Config{Window: 10}, distTable)
	// Zero offset and zero linear distance must not produce NaN.
	if _, err := m.Add(obs(0, 5, Candidate{RoadID: "A", Off: 0})); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Add(obs(0.5, 5, Candidate{RoadID: "A", Off: 0})); err != nil {
		t.Fatal(err)
	}
	for i, c := range m.cols {
		for j, s := range c.states {
			if math.IsNaN(s.delta) {
				t.Errorf("col %d state %d: delta is NaN", i, j)
			}
		}
	}
}

func TestValidation(t *testing.T) {
	m := New(Config{}, distTable)
	if _, err := m.Add(obs(0, 5)); !errors.Is(err, ErrNoCandidates) {
		t.Errorf("no candidates: err = %v, want ErrNoCandidates", err)
	}
	if _, err := m.Add(obs(0, 0, Candidate{RoadID: "A"})); !errors.Is(err, ErrBadSigma) {
		t.Errorf("zero sigma: err = %v, want ErrBadSigma", err)
	}
}
