package dedup

import "testing"

func TestObserveBasic(t *testing.T) {
	s := NewSet(128)
	if d := s.Observe("A", 1); d != New {
		t.Fatalf("first observe = %v, want new", d)
	}
	if d := s.Observe("A", 1); d != Duplicate {
		t.Fatalf("re-observe = %v, want duplicate", d)
	}
	if d := s.Observe("B", 1); d != New {
		t.Fatalf("other producer = %v, want new", d)
	}
}

func TestSequenceGapsAllowed(t *testing.T) {
	s := NewSet(128)
	for _, seq := range []uint64{10, 30, 20} { // holes at 11..19, 21..29
		if d := s.Observe("A", seq); d != New {
			t.Fatalf("seq %d = %v, want new", seq, d)
		}
	}
	for _, seq := range []uint64{11, 19, 21, 29} { // filling holes later is fine
		if d := s.Observe("A", seq); d != New {
			t.Fatalf("hole seq %d = %v, want new", seq, d)
		}
	}
	for _, seq := range []uint64{10, 20, 30, 11, 29} {
		if d := s.Observe("A", seq); d != Duplicate {
			t.Fatalf("seq %d = %v, want duplicate", seq, d)
		}
	}
}

func TestTooOldBoundary(t *testing.T) {
	s := NewSet(128) // window covers (max-128, max]
	s.Observe("A", 200)
	if d := s.Observe("A", 72); d != TooOld { // 200-72 = 128, outside
		t.Fatalf("seq 72 = %v, want too-old", d)
	}
	if d := s.Observe("A", 73); d != New { // 200-73 = 127, inside
		t.Fatalf("seq 73 = %v, want new", d)
	}
	// Too-old messages must not be recorded: still too old afterwards.
	if d := s.Observe("A", 72); d != TooOld {
		t.Fatalf("seq 72 again = %v, want too-old", d)
	}
}

func TestLargeJumpEvictsWindow(t *testing.T) {
	s := NewSet(128)
	s.Observe("A", 5)
	s.Observe("A", 1000) // jump far beyond the window
	if d := s.Observe("A", 5); d != TooOld {
		t.Fatalf("seq 5 after jump = %v, want too-old", d)
	}
	if d := s.Observe("A", 999); d != New {
		t.Fatalf("seq 999 = %v, want new", d)
	}
	if d := s.Observe("A", 1000); d != Duplicate {
		t.Fatalf("seq 1000 = %v, want duplicate", d)
	}
}

func TestWindowSizeRounding(t *testing.T) {
	if got := NewSet(1).WindowSize(); got != 64 {
		t.Fatalf("window size = %d, want 64", got)
	}
	if got := NewSet(100).WindowSize(); got != 128 {
		t.Fatalf("window size = %d, want 128", got)
	}
}

func TestDecisionString(t *testing.T) {
	if New.String() != "new" || Duplicate.String() != "duplicate" || TooOld.String() != "too-old" {
		t.Fatalf("unexpected decision strings: %v %v %v", New, Duplicate, TooOld)
	}
}
