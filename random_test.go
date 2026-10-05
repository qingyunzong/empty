package bdd_test

import (
	"math/rand"
	"testing"

	"bdd"
)

// TestRandomizedModel16 runs a long random sequence of operations on the
// maximum of 16 variables, checking every produced handle against a
// full 2^16-entry truth-table model, and re-checking all live handles
// after every reorder, swap, and release.
func TestRandomizedModel16(t *testing.T) {
	const n = 16
	r := rand.New(rand.NewSource(20241005))
	m, err := bdd.NewManager(n)
	if err != nil {
		t.Fatal(err)
	}
	type entry struct {
		h  bdd.Node
		tt []bool
	}
	var live []entry

	verify := func(e entry, what string) {
		t.Helper()
		if got := m.TruthTable(e.h); !ttEqual(got, e.tt) {
			t.Fatalf("%s: truth table mismatch", what)
		}
	}
	verifyAll := func(what string) {
		t.Helper()
		for _, e := range live {
			verify(e, what)
		}
	}
	releaseRandom := func() {
		if len(live) == 0 {
			return
		}
		i := r.Intn(len(live))
		m.Release(live[i].h)
		live = append(live[:i], live[i+1:]...)
	}

	for iter := 0; iter < 300; iter++ {
		op := r.Intn(12)
		switch {
		case len(live) < 4 || op <= 1:
			v := r.Intn(n)
			live = append(live, entry{m.Var(v), varTT(n, v)})
		case op == 2 || op == 3:
			f, g := live[r.Intn(len(live))], live[r.Intn(len(live))]
			var h bdd.Node
			var tt []bool
			switch r.Intn(5) {
			case 0:
				h, tt = m.And(f.h, g.h), binTT(f.tt, g.tt, andOp)
			case 1:
				h, tt = m.Or(f.h, g.h), binTT(f.tt, g.tt, orOp)
			case 2:
				h, tt = m.Xor(f.h, g.h), binTT(f.tt, g.tt, xorOp)
			case 3:
				h, tt = m.Imply(f.h, g.h), binTT(f.tt, g.tt, impOp)
			default:
				h, tt = m.Equiv(f.h, g.h), binTT(f.tt, g.tt, eqvOp)
			}
			live = append(live, entry{h, tt})
			verify(live[len(live)-1], "binary op")
		case op == 4:
			f := live[r.Intn(len(live))]
			live = append(live, entry{m.Not(f.h), notTT(f.tt)})
			verify(live[len(live)-1], "Not")
		case op == 5:
			f := live[r.Intn(len(live))]
			k := 1 + r.Intn(6)
			qs := make(map[int]bool)
			vars := []int{}
			for len(qs) < k {
				v := r.Intn(n)
				if !qs[v] {
					qs[v] = true
					vars = append(vars, v)
				}
			}
			var h bdd.Node
			var tt []bool
			if r.Intn(2) == 0 {
				h, tt = m.Exists(f.h, vars...), quantifyTT(f.tt, qs, true)
			} else {
				h, tt = m.ForAll(f.h, vars...), quantifyTT(f.tt, qs, false)
			}
			live = append(live, entry{h, tt})
			verify(live[len(live)-1], "quantification")
		case op == 6:
			i, th, e := live[r.Intn(len(live))], live[r.Intn(len(live))], live[r.Intn(len(live))]
			live = append(live, entry{m.Ite(i.h, th.h, e.h), iteTT(i.tt, th.tt, e.tt)})
			verify(live[len(live)-1], "Ite")
		case op == 7:
			f := live[r.Intn(len(live))]
			live = append(live, entry{m.Rebuild(f.h), f.tt})
			verify(live[len(live)-1], "Rebuild")
		case op == 8:
			if err := m.Reorder(r.Perm(n)); err != nil {
				t.Fatal(err)
			}
			verifyAll("old handles after Reorder")
		case op == 9:
			if err := m.SwapAdjacent(r.Intn(n - 1)); err != nil {
				t.Fatal(err)
			}
			verifyAll("old handles after SwapAdjacent")
		default:
			releaseRandom()
			verifyAll("live handles after Release")
		}
		for len(live) > 14 {
			releaseRandom()
		}
	}
	for _, e := range live {
		m.Release(e.h)
	}
	if got := m.NodeCount(); got != 0 {
		t.Fatalf("NodeCount = %d, want 0 (leak)", got)
	}
}
