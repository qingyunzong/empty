package seqlib

import (
	"math/rand"
	"reflect"
	"testing"
)

// brutePeriods is the reference full scan over all candidate periods.
func brutePeriods(a []int64) []int {
	n := len(a)
	out := []int{}
	for p := 1; p <= n; p++ {
		ok := true
		for i := 0; i+p < n; i++ {
			if a[i] != a[i+p] {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, p)
		}
	}
	return out
}

func bruteFirstMismatch(a []int64, p int) (int, int, bool) {
	n := len(a)
	for i := 0; i+p < n; i++ {
		if a[i] != a[i+p] {
			return i, i + p, true
		}
	}
	return 0, 0, false
}

func checkAgainstBrute(t *testing.T, s *Seq) {
	t.Helper()
	n := s.Len()
	a := make([]int64, n)
	for i := range a {
		a[i] = s.At(i)
	}
	want := brutePeriods(a)
	if got := s.Periods(); !reflect.DeepEqual(got, want) {
		t.Fatalf("a=%v Periods()=%v, want %v", a, got, want)
	}
	wantMin := 0
	if len(want) > 0 {
		wantMin = want[0]
	}
	if got := s.MinPeriod(); got != wantMin {
		t.Fatalf("a=%v MinPeriod()=%d, want %d", a, got, wantMin)
	}
	for p := 1; p <= n; p++ {
		if got := s.IsPeriod(p); got != (brutePeriodsContain(want, p)) {
			t.Fatalf("a=%v IsPeriod(%d)=%v, want %v", a, p, got, !got)
		}
		wi, wj, wok := bruteFirstMismatch(a, p)
		gi, gj, gok := s.FirstMismatch(p)
		if gi != wi || gj != wj || gok != wok {
			t.Fatalf("a=%v FirstMismatch(%d)=(%d,%d,%v), want (%d,%d,%v)",
				a, p, gi, gj, gok, wi, wj, wok)
		}
	}
}

func brutePeriodsContain(ps []int, p int) bool {
	for _, q := range ps {
		if q == p {
			return true
		}
	}
	return false
}

func TestKnownCases(t *testing.T) {
	cases := []struct {
		a       []int64
		periods []int
	}{
		{[]int64{}, []int{}},
		{[]int64{7}, []int{1}},
		{[]int64{5, 5, 5}, []int{1, 2, 3}},
		{[]int64{1, 2, 1, 2, 1}, []int{2, 4, 5}}, // n not a multiple of 2 or 4
		{[]int64{1, 2, 3, 1, 2, 3}, []int{3, 6}}, // exact multiple
		{[]int64{1, 2, 3, 1, 2}, []int{3, 5}},    // partial final block
		{[]int64{1, 2, 3, 4}, []int{4}},          // only trivial period
		{[]int64{0, 1, 0, 1, 0, 1, 0}, []int{2, 4, 6, 7}},
	}
	for _, c := range cases {
		s := New(c.a)
		if got := s.Periods(); !reflect.DeepEqual(got, c.periods) {
			t.Errorf("a=%v Periods()=%v, want %v", c.a, got, c.periods)
		}
		wantMin := 0
		if len(c.periods) > 0 {
			wantMin = c.periods[0]
		}
		if got := s.MinPeriod(); got != wantMin {
			t.Errorf("a=%v MinPeriod()=%d, want %d", c.a, got, wantMin)
		}
		checkAgainstBrute(t, s)
	}
}

func TestFirstMismatch(t *testing.T) {
	s := New([]int64{1, 2, 1, 2, 1})
	if i, j, ok := s.FirstMismatch(2); ok {
		t.Errorf("FirstMismatch(2) = (%d,%d,%v), want ok=false for a period", i, j, ok)
	}
	if i, j, ok := s.FirstMismatch(1); !ok || i != 0 || j != 1 {
		t.Errorf("FirstMismatch(1) = (%d,%d,%v), want (0,1,true)", i, j, ok)
	}
	if i, j, ok := s.FirstMismatch(3); !ok || i != 0 || j != 3 {
		t.Errorf("FirstMismatch(3) = (%d,%d,%v), want (0,3,true)", i, j, ok)
	}
	if _, _, ok := s.FirstMismatch(5); ok {
		t.Errorf("FirstMismatch(5) ok=true, want false (vacuous period)")
	}
	if _, _, ok := s.FirstMismatch(6); ok {
		t.Errorf("FirstMismatch(6) ok=true, want false (out of range)")
	}
}

func TestSetUpdates(t *testing.T) {
	s := New([]int64{1, 2, 3, 4})
	if got := s.Periods(); !reflect.DeepEqual(got, []int{4}) {
		t.Fatalf("initial Periods()=%v, want [4]", got)
	}
	s.Set(3, 1) // [1 2 3 1]
	if got := s.Periods(); !reflect.DeepEqual(got, []int{3, 4}) {
		t.Fatalf("after Set(3,1) Periods()=%v, want [3 4]", got)
	}
	s.Set(1, 3) // [1 3 3 1]
	s.Set(2, 1) // [1 3 1 1]
	s.Set(3, 3) // [1 3 1 3]
	if got := s.Periods(); !reflect.DeepEqual(got, []int{2, 4}) {
		t.Fatalf("after updates Periods()=%v, want [2 4]", got)
	}
	if got := s.MinPeriod(); got != 2 {
		t.Fatalf("MinPeriod()=%d, want 2", got)
	}
	s.Set(0, 3) // [3 3 1 3]: breaks distance-2 equality at pair (0,2)
	if i, j, ok := s.FirstMismatch(2); !ok || i != 0 || j != 2 {
		t.Fatalf("FirstMismatch(2)=(%d,%d,%v), want (0,2,true)", i, j, ok)
	}
	if got := s.MinPeriod(); got != 3 { // p=3 holds: a[0]==a[3]==3
		t.Fatalf("MinPeriod()=%d, want 3", got)
	}
	// No-op set must not corrupt counters.
	s.Set(0, 3)
	checkAgainstBrute(t, s)
}

func TestRandomAgainstBrute(t *testing.T) {
	rng := rand.New(rand.NewSource(20261008))
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(12)    // short strings: 1..12
		alpha := 1 + rng.Intn(3) // small alphabet -> interesting periods
		a := make([]int64, n)
		for i := range a {
			a[i] = int64(rng.Intn(alpha))
		}
		s := New(a)
		checkAgainstBrute(t, s)
		for upd := 0; upd < 20; upd++ {
			s.Set(rng.Intn(n), int64(rng.Intn(alpha)))
			checkAgainstBrute(t, s)
		}
	}
}
