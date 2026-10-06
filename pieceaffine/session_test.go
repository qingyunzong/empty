package pieceaffine

import (
	"encoding/json"
	"testing"
)

// TestSessionBudgetPauseResume runs the layered preimage with a tiny
// budget, forcing pauses, and checks the final result equals the
// unbudgeted proof.
func TestSessionBudgetPauseResume(t *testing.T) {
	c := testChain(t)
	y := Interval{Lo: -2, Hi: 1}
	full := c.Preimage(y)

	s := NewSession(c, y)
	steps := 0
	for !s.Finished {
		s.Step(1)
		steps++
		if steps > 10000 {
			t.Fatal("session did not terminate")
		}
	}
	if steps <= 1 {
		t.Fatalf("budget 1 finished in %d step, expected pauses", steps)
	}
	if !equalIntervals(s.Result, full.Result) {
		t.Fatalf("session result = %v, want %v", s.Result, full.Result)
	}
	proof, ok := s.Proof()
	if !ok {
		t.Fatal("finished session did not yield a proof")
	}
	if len(proof.Steps) != len(full.Steps) {
		t.Fatalf("session proof has %d steps, want %d", len(proof.Steps), len(full.Steps))
	}
	for i := range proof.Steps {
		if !equalIntervals(proof.Steps[i].Input, full.Steps[i].Input) ||
			!equalIntervals(proof.Steps[i].Output, full.Steps[i].Output) {
			t.Errorf("step %d differs: session %+v vs direct %+v", i, proof.Steps[i], full.Steps[i])
		}
	}
}

// TestSessionJSONResume serializes a paused session and resumes it from
// the decoded state.
func TestSessionJSONResume(t *testing.T) {
	c := testChain(t)
	y := Interval{Lo: -2, Hi: 1}
	full := c.Preimage(y)

	s := NewSession(c, y)
	s.Step(1)
	s.Step(1)
	if s.Finished {
		t.Fatal("session finished before pause could be tested")
	}
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var restored Session
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for !restored.Finished {
		restored.Step(2)
	}
	if !equalIntervals(restored.Result, full.Result) {
		t.Fatalf("restored session result = %v, want %v", restored.Result, full.Result)
	}
	if restored.Version != c.Version {
		t.Fatalf("session version = %d, want %d", restored.Version, c.Version)
	}
}

func TestSessionEmptyChain(t *testing.T) {
	c, err := NewChain(nil)
	if err != nil {
		t.Fatalf("NewChain(nil): %v", err)
	}
	y := Interval{Lo: 1, Hi: 4}
	s := NewSession(c, y)
	if !s.Finished {
		t.Fatal("empty chain session should finish immediately")
	}
	if !equalIntervals(s.Result, []Interval{y}) {
		t.Fatalf("result = %v, want [%v]", s.Result, y)
	}
}
