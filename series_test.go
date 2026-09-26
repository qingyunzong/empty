package counterrate

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)

func at(sec int, v float64, restart ...bool) Sample {
	s := Sample{Ts: t0.Add(time.Duration(sec) * time.Second), Value: v}
	if len(restart) > 0 {
		s.Restart = restart[0]
	}
	return s
}

func TestOutOfOrderEqualsOrdered(t *testing.T) {
	ordered := NewSeries(ConflictLastWins)
	ordered.Add(at(0, 100), at(10, 140), at(20, 5, true), at(30, 25))
	shuffled := NewSeries(ConflictLastWins)
	shuffled.Add(at(30, 25), at(20, 5, true), at(0, 100), at(10, 140))

	end := 30 * time.Second
	ro, err := ordered.WindowRate(t0, t0.Add(end))
	if err != nil {
		t.Fatal(err)
	}
	rs, err := shuffled.WindowRate(t0, t0.Add(end))
	if err != nil {
		t.Fatal(err)
	}
	if ro != rs {
		t.Fatalf("out-of-order mismatch: ordered %+v shuffled %+v", ro, rs)
	}
}

func TestConflictPolicies(t *testing.T) {
	mk := func(p ConflictPolicy) *Series {
		s := NewSeries(p)
		s.Add(at(0, 10), at(0, 20))
		return s
	}
	cases := []struct {
		name   string
		policy ConflictPolicy
		want   float64
	}{
		{"last-wins", ConflictLastWins, 20},
		{"first-wins", ConflictFirstWins, 10},
		{"max-wins", ConflictMaxWins, 20},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := mk(tc.policy)
			segs, err := s.Resolve()
			if err != nil {
				t.Fatal(err)
			}
			if got := segs[0][0].Value; got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
			if s.Conflicts != 1 {
				t.Fatalf("conflicts=%d want 1", s.Conflicts)
			}
		})
	}

	t.Run("error-policy", func(t *testing.T) {
		s := mk(ConflictError)
		if _, err := s.Resolve(); !errors.Is(err, ErrConflict) {
			t.Fatalf("want ErrConflict, got %v", err)
		}
	})

	t.Run("identical-duplicates-are-not-conflicts", func(t *testing.T) {
		s := NewSeries(ConflictLastWins)
		s.Add(at(0, 10), at(0, 10), at(5, 15))
		segs, err := s.Resolve()
		if err != nil {
			t.Fatal(err)
		}
		if len(segs) != 1 || len(segs[0]) != 2 {
			t.Fatalf("dedupe failed: %+v", segs)
		}
		if s.Conflicts != 0 {
			t.Fatalf("conflicts=%d want 0", s.Conflicts)
		}
	})
}
