package pieceaffine

import "testing"

func testChain(t *testing.T) *Chain {
	t.Helper()
	d0 := Interval{Lo: -16, Hi: 16}
	l0 := mustMap(t, d0, Piece{Dom: d0, A: -1, B: 1, C: 2})
	d1 := Interval{Lo: -8, Hi: 9}
	l1 := mustMap(t, d1,
		Piece{Dom: Interval{Lo: -8, Hi: 0}, A: 2, B: 3, C: 3},
		Piece{Dom: Interval{Lo: 0, Hi: 9}, A: -2, B: 1, C: 3})
	d2 := Interval{Lo: -6, Hi: 2}
	l2 := mustMap(t, d2, Piece{Dom: d2, A: 3, B: -1, C: 2})
	c, err := NewChain([]Map{l0, l1, l2})
	if err != nil {
		t.Fatalf("NewChain: %v", err)
	}
	return c
}

// TestChainPreimageComposite verifies the layered preimage against direct
// composite evaluation over the short input domain.
func TestChainPreimageComposite(t *testing.T) {
	c := testChain(t)
	for _, y := range []Interval{{Lo: -2, Hi: 1}, {Lo: 0, Hi: 3}, {Lo: -5, Hi: -3}, {Lo: 7, Hi: 9}} {
		proof := c.Preimage(y)
		want := bruteChainPreimage(c, y)
		if !equalIntervals(proof.Result, want) {
			t.Errorf("chain preimage of %v = %v, want %v", y, proof.Result, want)
		}
		if len(proof.Steps) != len(c.Layers) {
			t.Fatalf("proof has %d steps, want %d", len(proof.Steps), len(c.Layers))
		}
		// Steps run from the last layer back to the first, and each
		// step's input must feed the next step's output.
		for i, st := range proof.Steps {
			if st.Layer != len(c.Layers)-1-i {
				t.Errorf("step %d refers to layer %d", i, st.Layer)
			}
			if i+1 < len(proof.Steps) && !equalIntervals(st.Input, proof.Steps[i+1].Output) {
				t.Errorf("step %d input %v != step %d output %v", i, st.Input, i+1, proof.Steps[i+1].Output)
			}
		}
		if !equalIntervals(proof.Steps[len(proof.Steps)-1].Input, proof.Result) {
			t.Errorf("final step input != result")
		}
	}
}

// TestPreimageTraversesRoundings ensures the chain preimage crosses every
// intermediate rounding instead of merging coefficients: two layers of
// floor(-x/2) compose to ceil(x/4), not floor(x/4), so a merged-coefficient
// map must give a different (wrong) preimage.
func TestPreimageTraversesRoundings(t *testing.T) {
	d0 := Interval{Lo: -9, Hi: 9}
	neg := mustMap(t, d0, Piece{Dom: d0, A: -1, B: 0, C: 2})
	d1 := Interval{Lo: -5, Hi: 5}
	neg2 := mustMap(t, d1, Piece{Dom: d1, A: -1, B: 0, C: 2})
	c, err := NewChain([]Map{neg, neg2})
	if err != nil {
		t.Fatalf("NewChain: %v", err)
	}
	y := Interval{Lo: -3, Hi: 2}
	got := c.Preimage(y).Result
	want := bruteChainPreimage(c, y)
	if !equalIntervals(got, want) {
		t.Fatalf("layered preimage = %v, want %v", got, want)
	}
	merged := mustMap(t, d0, Piece{Dom: d0, A: 1, B: 0, C: 4}) // naive A1*A2, C1*C2
	naive := merged.Preimage(y)
	if equalIntervals(got, naive) {
		t.Fatalf("layered preimage %v must differ from merged-coefficient preimage %v", got, naive)
	}
}

func TestVersionedBatch(t *testing.T) {
	c := testChain(t)
	if c.Version != 0 {
		t.Fatalf("initial version = %d, want 0", c.Version)
	}
	bad := Edit{Index: len(c.Layers) + 1, Layer: c.Layers[0]}
	if _, err := c.ApplyBatch([]Edit{bad}); err == nil {
		t.Fatal("out-of-range edit accepted")
	}
	if c.Version != 0 {
		t.Fatalf("failed batch bumped version to %d", c.Version)
	}
	d := Interval{Lo: -4, Hi: 4}
	repl := mustMap(t, d, Piece{Dom: d, A: 1, B: 0, C: 1})
	extra := mustMap(t, d, Piece{Dom: d, A: 2, B: 0, C: 1})
	v, err := c.ApplyBatch([]Edit{
		{Index: 1, Layer: repl},
		{Index: len(c.Layers), Layer: extra},
	})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if v != 1 || c.Version != 1 {
		t.Fatalf("version = %d, want 1", c.Version)
	}
	if len(c.Layers) != 4 {
		t.Fatalf("layers = %d, want 4", len(c.Layers))
	}
	if len(c.History) != 1 || c.History[0].Edits != 2 || c.History[0].Layers != 4 {
		t.Fatalf("history = %+v", c.History)
	}
	// The appended identity-then-double tail must be observable via Eval.
	if got, ok := c.Layers[3].Eval(3); !ok || got != 6 {
		t.Fatalf("appended layer Eval(3) = %d, %v; want 6, true", got, ok)
	}
	// An invalid layer inside a batch must reject the whole batch.
	broken := Map{Dom: d, Pieces: []Piece{{Dom: d, A: 1, C: -1}}}
	if _, err := c.ApplyBatch([]Edit{{Index: 0, Layer: broken}}); err == nil {
		t.Fatal("invalid layer accepted")
	}
	if c.Version != 1 {
		t.Fatalf("failed batch bumped version to %d", c.Version)
	}
}
