package seglog

import "testing"

func TestIntervalSetMergesAdjacent(t *testing.T) {
	var s intervalSet
	for _, id := range []int{4, 2, 3, 0, 1} {
		s.add(id)
	}
	if len(s.ivs) != 1 || s.ivs[0] != (interval{0, 5}) {
		t.Fatalf("expected single interval [0,5), got %v", s.ivs)
	}
}

func TestIntervalSetKeepsGaps(t *testing.T) {
	var s intervalSet
	for _, id := range []int{0, 1, 3, 5, 6} {
		s.add(id)
	}
	want := []interval{{0, 2}, {3, 4}, {5, 7}}
	if len(s.ivs) != len(want) {
		t.Fatalf("got %v, want %v", s.ivs, want)
	}
	for i := range want {
		if s.ivs[i] != want[i] {
			t.Fatalf("got %v, want %v", s.ivs, want)
		}
	}
}

func TestIntervalSetPrefixStopsAtGap(t *testing.T) {
	var s intervalSet
	for _, id := range []int{0, 1, 2, 4, 5} {
		s.add(id)
	}
	if got := s.prefix(0); got != 3 {
		t.Fatalf("prefix = %d, want 3", got)
	}
	s.add(3)
	if got := s.prefix(0); got != 6 {
		t.Fatalf("prefix after filling gap = %d, want 6", got)
	}
}

func TestIntervalSetDropBelow(t *testing.T) {
	var s intervalSet
	for _, id := range []int{0, 1, 2, 3, 4, 7} {
		s.add(id)
	}
	s.dropBelow(3)
	want := []interval{{3, 5}, {7, 8}}
	if len(s.ivs) != len(want) {
		t.Fatalf("got %v, want %v", s.ivs, want)
	}
	for i := range want {
		if s.ivs[i] != want[i] {
			t.Fatalf("got %v, want %v", s.ivs, want)
		}
	}
	if got := s.prefix(3); got != 5 {
		t.Fatalf("prefix from base 3 = %d, want 5", got)
	}
}

func TestIntervalSetContains(t *testing.T) {
	var s intervalSet
	for _, id := range []int{1, 2, 3, 9} {
		s.add(id)
	}
	for _, id := range []int{1, 2, 3, 9} {
		if !s.contains(id) {
			t.Fatalf("contains(%d) = false, want true", id)
		}
	}
	for _, id := range []int{0, 4, 8, 10} {
		if s.contains(id) {
			t.Fatalf("contains(%d) = true, want false", id)
		}
	}
}
