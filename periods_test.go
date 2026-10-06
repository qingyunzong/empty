package seqperiods

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestKnownPeriods(t *testing.T) {
	cases := []struct {
		name    string
		a       []int64
		periods []int
	}{
		{"empty", nil, nil},
		{"single", []int64{7}, []int{1}},
		{"constant", []int64{3, 3, 3, 3}, []int{1, 2, 3, 4}},
		{"alternating odd", []int64{1, 2, 1, 2, 1}, []int{2, 4, 5}},
		{"alternating even", []int64{1, 2, 1, 2}, []int{2, 4}},
		{"no small period", []int64{1, 2, 3, 4, 5}, []int{5}},
		{"partial repeat", []int64{4, 5, 6, 4, 5, 6, 4}, []int{3, 6, 7}},
		{"negatives", []int64{-1, 2, -1, 2, -1}, []int{2, 4, 5}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := New(c.a)
			if got := s.AllPeriods(); !reflect.DeepEqual(got, c.periods) {
				t.Fatalf("AllPeriods(%v) = %v, want %v", c.a, got, c.periods)
			}
			wantMin := 0
			if len(c.periods) > 0 {
				wantMin = c.periods[0]
			}
			if got := s.MinPeriod(); got != wantMin {
				t.Fatalf("MinPeriod(%v) = %d, want %d", c.a, got, wantMin)
			}
		})
	}
}

func TestFirstMismatchKnown(t *testing.T) {
	s := New([]int64{1, 2, 3, 1, 2, 4})
	// p = 3: pairs (0,3) ok, (1,4) ok, (2,5): 3 != 4 -> first failure.
	i, j, bad := s.FirstMismatch(3)
	if !bad || i != 2 || j != 5 {
		t.Fatalf("FirstMismatch(3) = (%d, %d, %v), want (2, 5, true)", i, j, bad)
	}
	if ok, _, _ := s.CheckPeriod(3); ok {
		t.Fatal("CheckPeriod(3) should report not a period")
	}
	// p = 5: only pair (0,1)... wait (0,5): 1 != 4.
	i, j, bad = s.FirstMismatch(5)
	if !bad || i != 0 || j != 5 {
		t.Fatalf("FirstMismatch(5) = (%d, %d, %v), want (0, 5, true)", i, j, bad)
	}
	// p = 6 >= n: trivially a period, no mismatch.
	if _, _, bad := s.FirstMismatch(6); bad {
		t.Fatal("FirstMismatch(6) should find no mismatch")
	}
	if !s.IsPeriod(6) {
		t.Fatal("IsPeriod(6) should be true for n = 6")
	}
}

func TestSetUpdates(t *testing.T) {
	s := New([]int64{1, 2, 3, 4, 5})
	if got := s.MinPeriod(); got != 5 {
		t.Fatalf("MinPeriod before update = %d, want 5", got)
	}
	// Turn into 1 2 1 2 1: periods become {2, 4, 5}.
	s.Set(2, 1)
	s.Set(3, 2)
	s.Set(4, 1)
	if got := s.AllPeriods(); !reflect.DeepEqual(got, []int{2, 4, 5}) {
		t.Fatalf("AllPeriods after updates = %v, want [2 4 5]", got)
	}
	// Break period 2 again: 1 2 1 9 1.
	s.Set(3, 9)
	if s.IsPeriod(2) {
		t.Fatal("IsPeriod(2) should be false after Set(3, 9)")
	}
	i, j, bad := s.FirstMismatch(2)
	if !bad || i != 1 || j != 3 {
		t.Fatalf("FirstMismatch(2) = (%d, %d, %v), want (1, 3, true)", i, j, bad)
	}
	// No-op update keeps state intact.
	s.Set(3, 9)
	if got := s.AllPeriods(); !reflect.DeepEqual(got, BrutePeriods([]int64{1, 2, 1, 9, 1})) {
		t.Fatalf("AllPeriods = %v, want %v", got, BrutePeriods([]int64{1, 2, 1, 9, 1}))
	}
}

func checkAgainstBrute(t *testing.T, s *Sequence, a []int64) {
	t.Helper()
	want := BrutePeriods(a)
	if got := s.AllPeriods(); !reflect.DeepEqual(got, want) {
		t.Fatalf("AllPeriods = %v, want %v (a = %v)", got, want, a)
	}
	if got, wantMin := s.MinPeriod(), BruteMinPeriod(a); got != wantMin {
		t.Fatalf("MinPeriod = %d, want %d (a = %v)", got, wantMin, a)
	}
	for p := 1; p <= len(a)+1; p++ {
		if got, wantIs := s.IsPeriod(p), BruteIsPeriod(a, p); got != wantIs {
			t.Fatalf("IsPeriod(%d) = %v, want %v (a = %v)", p, got, wantIs, a)
		}
		gi, gj, gbad := s.FirstMismatch(p)
		wi, wj, wbad := BruteFirstMismatch(a, p)
		if gbad != wbad || (gbad && (gi != wi || gj != wj)) {
			t.Fatalf("FirstMismatch(%d) = (%d, %d, %v), want (%d, %d, %v) (a = %v)",
				p, gi, gj, gbad, wi, wj, wbad, a)
		}
	}
}

func TestRandomAgainstBrute(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(40)
		alphabet := int64(1 + rng.Intn(4)) // small alphabets give rich periods
		a := make([]int64, n)
		for i := range a {
			a[i] = rng.Int63n(alphabet) - 1 // include 0 and negatives
		}
		s := New(a)
		checkAgainstBrute(t, s, a)
		for u := 0; u < 20; u++ {
			idx := rng.Intn(n)
			v := rng.Int63n(alphabet) - 1
			s.Set(idx, v)
			a[idx] = v
			checkAgainstBrute(t, s, a)
		}
	}
}

func TestLargeValues(t *testing.T) {
	a := []int64{1 << 62, -(1 << 62), 1 << 62, -(1 << 62), 1 << 62}
	s := New(a)
	if got := s.AllPeriods(); !reflect.DeepEqual(got, []int{2, 4, 5}) {
		t.Fatalf("AllPeriods = %v, want [2 4 5]", got)
	}
	s.Set(0, 0)
	if s.IsPeriod(2) {
		t.Fatal("IsPeriod(2) should be false after changing a[0]")
	}
}
