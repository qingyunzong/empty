package lp1_test

import (
	"testing"

	"example.org/dataeng/q0317/lp1"
)

func FuzzOpenNoPanic(f *testing.F) {
	f.Add(lp1.EmptyPage())
	f.Fuzz(func(t *testing.T, page []byte) {
		snap, err := lp1.Open(page)
		if err != nil {
			return
		}
		// Every accepted page must traverse fully in both directions and the
		// independent model must agree.
		fwd := forwardValues(t, snap)
		bwd := backwardValues(t, snap)
		if len(fwd) != int(snap.Count()) || len(bwd) != len(fwd) {
			t.Fatal("traversal count mismatch")
		}
		for i := range fwd {
			if fwd[i].Type() != bwd[len(bwd)-1-i].Type() {
				t.Fatal("forward/backward type mismatch")
			}
		}
		model, mErr := fixDecodePage(snap.Bytes())
		if mErr != nil || len(model) != len(fwd) {
			t.Fatalf("independent model disagreement: %v", mErr)
		}
	})
}

func FuzzSpliceNoPanic(f *testing.F) {
	base, _ := lp1.Open(lp1.EmptyPage())
	f.Add(0, 0, uint64(0), []byte{0x01})
	f.Fuzz(func(t *testing.T, start, deleteCount int, budget uint64, payload []byte) {
		vals := []lp1.Value{lp1.Integer(int64(start)), lp1.String(payload)}
		next, err := base.Splice(start, deleteCount, vals, budget)
		if err != nil {
			return
		}
		if _, vErr := lp1.Open(next.Bytes()); vErr != nil {
			t.Fatalf("splice output invalid: %v", vErr)
		}
	})
}
