package statmatch

import (
	"math/rand"
	"strings"
	"testing"
)

func TestAlignerLimits(t *testing.T) {
	al := NewAligner(rat(1, 1))
	for i := 0; i < MaxPoints; i++ {
		p := Point{ID: "a" + string(rune('A'+i)), T: rat(int64(i), 1), V: int64(i)}
		if err := al.AddPoint(SideA, p); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	if err := al.AddPoint(SideA, Point{"overflow", rat(99, 1), 0}); err == nil {
		t.Fatal("expected error beyond MaxPoints")
	}
	if err := al.AddPoint(SideA, Point{"aA", rat(0, 1), 0}); err == nil {
		t.Fatal("expected duplicate ID error")
	}
	if err := al.RemovePoint(SideA, "missing"); err == nil {
		t.Fatal("expected unknown ID error")
	}
	if err := al.AddPoint(SideA, Point{"nilT", nil, 0}); err == nil {
		t.Fatal("expected nil time error")
	}
}

// Adding a point that changes the matching must recompute the
// correlation.
func TestMatchingChangeRecomputes(t *testing.T) {
	al := NewAligner(rat(3, 1))
	add := func(side Side, id string, n, d, v int64) {
		t.Helper()
		if err := al.AddPoint(side, Point{id, rat(n, d), v}); err != nil {
			t.Fatal(err)
		}
	}
	add(SideA, "a1", 0, 1, 1)
	add(SideA, "a2", 2, 1, 2)
	add(SideA, "a3", 4, 1, 3)
	add(SideB, "b1", 0, 1, 3)
	add(SideB, "b2", 19, 10, 4)
	if got, want := pairIDs(al.Pairs()), [][2]string{{"a1", "b1"}, {"a2", "b2"}}; !equalIDs(got, want) {
		t.Fatalf("pairs = %v, want %v", got, want)
	}
	// b3 joins at t=4, extending the matching to three pairs.
	add(SideB, "b3", 4, 1, 9)
	// Pairs are ordered by (difference, IDs): a3~b3 has difference 0.
	if got, want := pairIDs(al.Pairs()), [][2]string{{"a1", "b1"}, {"a3", "b3"}, {"a2", "b2"}}; !equalIDs(got, want) {
		t.Fatalf("pairs = %v, want %v", got, want)
	}
	st := al.Stats()
	// Pairs (1,3),(2,4),(3,9): Cov=18, VarX=6, VarY=62, r=3√93/31.
	wantBig(t, "Cov", st.Cov, 18)
	wantBig(t, "VarX", st.VarX, 6)
	wantBig(t, "VarY", st.VarY, 62)
	if got := st.R.String(); got != "3√93/31" {
		t.Fatalf("R = %s, want 3√93/31", got)
	}
	// Removing b2 steals a2's match onto nothing and shrinks the
	// matching; statistics must follow the new matching.
	if err := al.RemovePoint(SideB, "b2"); err != nil {
		t.Fatal(err)
	}
	if got, want := pairIDs(al.Pairs()), [][2]string{{"a1", "b1"}, {"a3", "b3"}}; !equalIDs(got, want) {
		t.Fatalf("pairs = %v, want %v", got, want)
	}
	st = al.Stats()
	// Pairs (1,3),(3,9): Cov = 2·30−4·12 = 12, VarX = 4, VarY = 36.
	wantBig(t, "Cov", st.Cov, 12)
	if got := st.R.String(); got != "1" {
		t.Fatalf("R = %s, want 1", got)
	}
}

// Randomized cross-check: after every add/remove the incrementally
// maintained sums and statistics must equal the direct summation model
// recomputed from scratch.
func TestAddRemoveVsDirectSummation(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	gap := rat(3, 2)
	al := NewAligner(gap)
	var nextA, nextB int
	for step := 0; step < 400; step++ {
		side := Side(rng.Intn(2))
		if rng.Intn(2) == 0 {
			var id string
			if side == SideA {
				id = "a" + strings.Repeat("x", nextA)
				nextA++
			} else {
				id = "b" + strings.Repeat("x", nextB)
				nextB++
			}
			p := Point{id, rat(int64(rng.Intn(13)), int64(1+rng.Intn(4))), int64(rng.Intn(21) - 10)}
			_ = al.AddPoint(side, p) // may fail at MaxPoints; fine
		} else {
			a, b := al.Points()
			ps := a
			if side == SideB {
				ps = b
			}
			if len(ps) > 0 {
				_ = al.RemovePoint(side, ps[rng.Intn(len(ps))].ID)
			}
		}

		a, b := al.Points()
		pairs := Match(a, b, gap)
		direct := DirectSums(pairs)
		if got := al.Sums(); !got.Equal(direct) {
			t.Fatalf("step %d: incremental sums diverge from direct summation", step)
		}
		st, dst := al.Stats(), direct.Stats()
		if st.Defined != dst.Defined || st.Cov.Cmp(dst.Cov) != 0 ||
			st.VarX.Cmp(dst.VarX) != 0 || st.VarY.Cmp(dst.VarY) != 0 {
			t.Fatalf("step %d: statistics diverge", step)
		}
		if st.Defined && !radicalEqual(st.R, dst.R) {
			t.Fatalf("step %d: correlation diverges", step)
		}
		if step%25 == 0 {
			if _, err := al.Certificate(); err != nil {
				t.Fatalf("step %d: certificate: %v", step, err)
			}
		}
	}
}
