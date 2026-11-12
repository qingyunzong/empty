package qpackdec

import (
	"math/big"
	"testing"
)

// refRequiredInsertCount is an independent, deliberately straightforward
// implementation of the required-insert-count recovery written with big.Int.
// It shares no arithmetic helper with the production code and serves as the
// independent arithmetic reference requested for wrap-around correctness.
func refRequiredInsertCount(e, i, m int64) (int64, bool) {
	if e < 0 || i < 0 || m < 0 {
		return 0, false
	}
	E := big.NewInt(e)
	I := big.NewInt(i)
	K := new(big.Int).Quo(big.NewInt(m), big.NewInt(32))
	F := new(big.Int).Lsh(K, 1) // 2*K

	if E.Sign() == 0 {
		return 0, true
	}
	if K.Sign() == 0 {
		return 0, false
	}
	if E.Cmp(F) > 0 {
		return 0, false
	}
	V := new(big.Int).Add(I, K)
	q := new(big.Int).Quo(V, F)
	R := new(big.Int).Add(new(big.Int).Mul(q, F), E)
	R.Sub(R, big.NewInt(1))
	if R.Cmp(V) > 0 {
		if R.Cmp(F) <= 0 {
			return 0, false
		}
		R.Sub(R, F)
	}
	if R.Sign() == 0 {
		return 0, false
	}
	if !R.IsInt64() {
		return 0, false
	}
	return R.Int64(), true
}

func refBase(r int64, sign int, delta int64) (int64, bool) {
	if delta < 0 || (sign != 0 && sign != 1) {
		return 0, false
	}
	R := big.NewInt(r)
	D := big.NewInt(delta)
	var B *big.Int
	if sign == 0 {
		B = new(big.Int).Add(R, D)
	} else {
		B = new(big.Int).Sub(R, D)
		B.Sub(B, big.NewInt(1))
	}
	if B.Sign() < 0 || !B.IsInt64() {
		return 0, false
	}
	return B.Int64(), true
}

func TestRequiredInsertCountHandChecked(t *testing.T) {
	// M=320 -> K=10, F=20.
	const m int64 = 320
	cases := []struct {
		name string
		e, i int64
		want int64
		ok   bool
	}{
		{"E zero", 0, 0, 0, true},
		{"first window", 1, 0, 0, false}, // R resolves to zero -> error
		{"first window valid", 2, 0, 1, true},
		{"wrap subtract branch", 3, 11, 2, true},                  // floor(V/F)=1: 20+3-1=22 -> -20 = 2
		{"subtract saves wrapped value", 7, 5, 6, true},           // R=26>V=15, R>F -> -20 = 6
		{"subtract saves larger wrapped value", 17, 11, 16, true}, // R=36>V=21, R>F -> -20 = 16
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := requiredInsertCount(tc.e, tc.i, m)
			if tc.ok && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatalf("expected error, got R=%d", got)
			}
			if tc.ok && got != tc.want {
				t.Fatalf("R=%d want %d", got, tc.want)
			}
			if ref, okRef := refRequiredInsertCount(tc.e, tc.i, m); okRef != tc.ok || (tc.ok && ref != tc.want) {
				t.Fatalf("reference mismatch: ref=(%d,%v) want=(%d,%v)", ref, okRef, tc.want, tc.ok)
			}
		})
	}
}

func TestRequiredInsertCountSameEncodedDifferentMeaning(t *testing.T) {
	// E=8 with M=320 (F=20) must decode differently as I advances.
	const m int64 = 320
	const e int64 = 8
	want := map[int64]int64{
		0:  7,  // q=0 -> R=7
		10: 7,  // V=20, q=1, R=27 > 20 -> subtract -> 7
		25: 27, // V=35, q=1 -> R=27 <= V, no subtract
	}
	for i, expected := range want {
		got, err := requiredInsertCount(e, i, m)
		if err != nil {
			t.Fatalf("I=%d: %v", i, err)
		}
		if got != expected {
			t.Fatalf("I=%d E=%d -> R=%d want %d", i, e, got, expected)
		}
		ref, ok := refRequiredInsertCount(e, i, m)
		if !ok || ref != got {
			t.Fatalf("reference mismatch at I=%d: %d,%v", i, ref, ok)
		}
	}
}

func TestRequiredInsertCountZeroCapacity(t *testing.T) {
	if r, err := requiredInsertCount(0, 5, 0); err != nil || r != 0 {
		t.Fatalf("E=0 must always give R=0, got %d,%v", r, err)
	}
	if _, err := requiredInsertCount(1, 0, 0); err == nil {
		t.Fatal("non-zero E with K=0 must error")
	}
	if _, ok := refRequiredInsertCount(1, 0, 0); ok {
		t.Fatal("reference must also reject E>0 with K=0")
	}
}

func TestRequiredInsertCountExceedsFullRange(t *testing.T) {
	if _, err := requiredInsertCount(21, 0, 320); err == nil {
		t.Fatal("E > F must error")
	}
}

func TestRequiredInsertCountMatchesReference(t *testing.T) {
	ms := []int64{0, 31, 32, 320, 1024, 4096}
	for _, m := range ms {
		f := 2 * (m / 32)
		for e := int64(0); e <= f+1 && e < 64; e++ {
			for _, i := range []int64{0, 1, 5, 10, 11, 20, 25, 40, 100} {
				got, gErr := requiredInsertCount(e, i, m)
				ref, rOK := refRequiredInsertCount(e, i, m)
				if rOK != (gErr == nil) {
					t.Fatalf("M=%d E=%d I=%d: ok mismatch err=%v refOK=%v", m, e, i, gErr, rOK)
				}
				if rOK && got != ref {
					t.Fatalf("M=%d E=%d I=%d: R=%d ref=%d", m, e, i, got, ref)
				}
			}
		}
	}
}

func TestComputeBaseSigns(t *testing.T) {
	cases := []struct {
		r           int64
		sign, delta int64
		want        int64
		ok          bool
	}{
		{5, 0, 3, 8, true},   // R + Delta
		{5, 1, 3, 1, true},   // R - Delta - 1
		{0, 1, 0, -1, false}, // 0 - 0 - 1 negative
		{2, 1, 2, -1, false}, // 2 - 2 - 1 negative
		{0, 0, 0, 0, true},
	}
	for _, tc := range cases {
		got, err := computeBase(tc.r, int(tc.sign), tc.delta)
		if tc.ok != (err == nil) || (tc.ok && got != tc.want) {
			t.Fatalf("r=%d sign=%d d=%d got=(%d,%v) want=(%d,%v)",
				tc.r, tc.sign, tc.delta, got, err, tc.want, tc.ok)
		}
		ref, ok := refBase(tc.r, int(tc.sign), tc.delta)
		if ok != tc.ok || (tc.ok && ref != tc.want) {
			t.Fatalf("reference base mismatch: %d,%v", ref, ok)
		}
	}
}

func TestCheckedArithmetic(t *testing.T) {
	if _, ok := addChecked(maxInt64, 1); ok {
		t.Fatal("expected add overflow")
	}
	if _, ok := subChecked(minInt64, 1); ok {
		t.Fatal("expected sub overflow")
	}
	if _, ok := mulChecked(maxInt64, 2); ok {
		t.Fatal("expected mul overflow")
	}
	if v, ok := addChecked(maxInt64, 0); !ok || v != maxInt64 {
		t.Fatal("identity add broken")
	}
}
