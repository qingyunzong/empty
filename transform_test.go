package robocalib

import (
	"math/rand"
	"testing"
)

func randomTransform(r *rand.Rand) Transform {
	return NewTransform(r.Intn(8)-2, r.Intn(21)-10, r.Intn(21)-10)
}

func TestComposeInverseRoundTrip(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 10000; i++ {
		a, b := randomTransform(r), randomTransform(r)
		if got := a.Compose(b).Compose(b.Inverse()); !got.Equal(a) {
			t.Fatalf("(a∘b)∘b⁻¹ = %v, want %v", got, a)
		}
		if got := b.Inverse().Compose(b); !got.IsIdentity() {
			t.Fatalf("b⁻¹∘b = %v, want identity", got)
		}
		if got := a.Compose(a.Inverse()); !got.IsIdentity() {
			t.Fatalf("a∘a⁻¹ = %v, want identity", got)
		}
	}
}

func TestComposeMatchesPointApplication(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	for i := 0; i < 10000; i++ {
		a, b := randomTransform(r), randomTransform(r)
		x, y := r.Intn(21)-10, r.Intn(21)-10
		// (a∘b)(p) must equal a(b(p)): composition order is significant.
		wx, wy := b.Apply(x, y)
		wantX, wantY := a.Apply(wx, wy)
		gotX, gotY := a.Compose(b).Apply(x, y)
		if gotX != wantX || gotY != wantY {
			t.Fatalf("(a∘b)(p) = (%d,%d), want a(b(p)) = (%d,%d)", gotX, gotY, wantX, wantY)
		}
	}
}

func TestCompositionIsNotCommutative(t *testing.T) {
	rot := NewTransform(1, 0, 0)
	shift := NewTransform(0, 3, 0)
	if rot.Compose(shift).Equal(shift.Compose(rot)) {
		t.Fatal("rotation and translation must not commute")
	}
	// R∘t moves (0,0) to R*(3,0) = (0,3); t∘R moves it to (3,0).
	if x, y := rot.Compose(shift).Apply(0, 0); x != 0 || y != 3 {
		t.Fatalf("R∘t origin = (%d,%d), want (0,3)", x, y)
	}
	if x, y := shift.Compose(rot).Apply(0, 0); x != 3 || y != 0 {
		t.Fatalf("t∘R origin = (%d,%d), want (3,0)", x, y)
	}
}

func TestRotationGroup(t *testing.T) {
	for k := 0; k < 4; k++ {
		rot := NewTransform(k, 0, 0)
		acc := Identity()
		for i := 0; i < 4; i++ {
			acc = rot.Compose(acc)
		}
		if !acc.IsIdentity() {
			t.Fatalf("rot(%d)^4 = %v, want identity", k, acc)
		}
	}
}
