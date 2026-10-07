package preimage

import (
	"math/rand"
	"testing"
)

// refFloorDiv is the independent reference for floor division.
func refFloorDiv(n, d int64) int64 {
	q := n / d
	if n%d != 0 && (n < 0) != (d < 0) {
		q--
	}
	return q
}

func refEval(f Affine, x int64) int64 { return refFloorDiv(f.A*x+f.B, f.C) }

func TestAffineEvalMatchesReference(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 2000; i++ {
		f := NewAffine(rng.Int63n(11)-5, rng.Int63n(41)-20, rng.Int63n(5)+1)
		for x := int64(-60); x < 60; x++ {
			if got, want := f.Eval(x), refEval(f, x); got != want {
				t.Fatalf("Eval(%v, %d) = %d, want %d", f, x, got, want)
			}
		}
	}
}

func TestNewAffineNormalizesNegativeDivisor(t *testing.T) {
	f := NewAffine(2, 3, -4)
	if f.C != 4 || f.A != -2 || f.B != -3 {
		t.Fatalf("normalization wrong: %+v", f)
	}
	for x := int64(-20); x < 20; x++ {
		if got, want := f.Eval(x), refFloorDiv(2*x+3, -4); got != want {
			t.Fatalf("Eval(%d) = %d, want %d", x, got, want)
		}
	}
}

// TestAffinePreimageValueByValue checks every short-domain preimage against
// a brute-force reference, and verifies the exact endpoints of every
// recovered interval, including the direction-flip case A < 0 and the
// constant case A == 0.
func TestAffinePreimageValueByValue(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	dom := Interval{Lo: -30, Hi: 30}
	for i := 0; i < 800; i++ {
		f := NewAffine(rng.Int63n(13)-6, rng.Int63n(31)-15, rng.Int63n(6)+1)
		y := Interval{Lo: rng.Int63n(21) - 10, Hi: 0}
		y.Hi = y.Lo + rng.Int63n(8) + 1

		got := f.preimage(y.Lo, y.Hi, dom)

		// Value-by-value reference.
		for x := dom.Lo; x < dom.Hi; x++ {
			in := y.Contains(refEval(f, x))
			if in != got.Contains(x) {
				t.Fatalf("f=%v y=%v: x=%d membership=%v, interval %v",
					f, y, x, in, got)
			}
		}
		if got.Empty() {
			continue
		}
		// Endpoint checks: just outside must not map in, just inside must.
		if dom.Contains(got.Lo - 1) {
			if y.Contains(refEval(f, got.Lo-1)) {
				t.Fatalf("f=%v y=%v: lower endpoint %d not tight", f, y, got.Lo)
			}
		}
		if !y.Contains(refEval(f, got.Lo)) || !y.Contains(refEval(f, got.Hi-1)) {
			t.Fatalf("f=%v y=%v: endpoints of %v do not map into y", f, y, got)
		}
		if dom.Contains(got.Hi) {
			if y.Contains(refEval(f, got.Hi)) {
				t.Fatalf("f=%v y=%v: upper endpoint %d not tight", f, y, got.Hi)
			}
		}
	}
}

// TestAffineDirectionFlip pins the orientation of the map: A > 0 is
// non-decreasing, A < 0 is non-increasing (flip), A == 0 is constant.
func TestAffineDirectionFlip(t *testing.T) {
	up := NewAffine(3, -2, 2)
	down := NewAffine(-3, 5, 2)
	flat := NewAffine(0, 7, 3)
	for x := int64(-40); x < 40; x++ {
		if up.Eval(x+1) < up.Eval(x) {
			t.Fatalf("positive slope decreased at %d", x)
		}
		if down.Eval(x+1) > down.Eval(x) {
			t.Fatalf("negative slope increased at %d (flip broken)", x)
		}
		if flat.Eval(x+1) != flat.Eval(x) {
			t.Fatalf("zero slope not constant at %d", x)
		}
	}
}

func TestAffinePreimageConstant(t *testing.T) {
	dom := Interval{Lo: -5, Hi: 9}
	f := NewAffine(0, 7, 2) // constant floor(7/2) = 3
	if got := f.preimage(3, 4, dom); got != dom {
		t.Fatalf("hit: got %v, want %v", got, dom)
	}
	if got := f.preimage(-3, 3, dom); got != (Interval{}) {
		t.Fatalf("miss below: got %v, want empty", got)
	}
	if got := f.preimage(4, 10, dom); got != (Interval{}) {
		t.Fatalf("miss above: got %v, want empty", got)
	}
}

func TestAffinePreimageFlippedEndpoints(t *testing.T) {
	// f(x) = floor(-x/2) on [0, 8): image decreases 0,0,-1,-1,...,-4.
	f := NewAffine(-1, 0, 2)
	dom := Interval{Lo: 0, Hi: 8}
	got := f.preimage(-3, -1, dom) // y in {-3, -2}
	want := Interval{Lo: 3, Hi: 7}
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}
