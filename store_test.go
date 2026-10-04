package seglog

import (
	"errors"
	"path/filepath"
	"testing"
)

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "store.wal")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, path
}

func TestOutOfOrderAcksAdvanceOnlyContiguousPrefix(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	if _, err := s.Append(10); err != nil {
		t.Fatal(err)
	}

	for _, id := range []int{2, 3, 5} {
		if err := s.Ack("c1", id); err != nil {
			t.Fatal(err)
		}
	}
	if got := s.Prefix("c1"); got != 0 {
		t.Fatalf("prefix with gap at 0 = %d, want 0", got)
	}

	if err := s.Ack("c1", 0); err != nil {
		t.Fatal(err)
	}
	if got := s.Prefix("c1"); got != 1 {
		t.Fatalf("prefix = %d, want 1 (gap at 1)", got)
	}

	if err := s.Ack("c1", 1); err != nil {
		t.Fatal(err)
	}
	if got := s.Prefix("c1"); got != 4 {
		t.Fatalf("prefix = %d, want 4 (gap at 4)", got)
	}

	if err := s.Ack("c1", 4); err != nil {
		t.Fatal(err)
	}
	if got := s.Prefix("c1"); got != 6 {
		t.Fatalf("prefix = %d, want 6", got)
	}
}

func TestAckValidation(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	if _, err := s.Append(3); err != nil {
		t.Fatal(err)
	}
	if err := s.Ack("c1", 3); !errors.Is(err, ErrSegmentOutOfRange) {
		t.Fatalf("ack beyond end: err = %v, want ErrSegmentOutOfRange", err)
	}
	if err := s.Ack("c1", 2); err != nil {
		t.Fatal(err)
	}
}

func TestCancelTombstoneSurvivesRestart(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Append(10); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{0, 1, 2, 3, 4} {
		if err := s.Ack("gone", id); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Ack("stayer", 0); err != nil {
		t.Fatal(err)
	}
	if err := s.Cancel("gone"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// Restart: replay the WAL. The cancelled consumer must stay cancelled
	// and its retained position must not be resurrected.
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if !s2.Cancelled("gone") {
		t.Fatal("cancelled consumer lost its tombstone after restart")
	}
	if err := s2.Ack("gone", 5); !errors.Is(err, ErrConsumerCancelled) {
		t.Fatalf("ack after restart: err = %v, want ErrConsumerCancelled", err)
	}
	if got := s2.Prefix("gone"); got != s2.Base() {
		t.Fatalf("resurrected retained point: prefix = %d, base = %d", got, s2.Base())
	}

	// The cancelled consumer must not hold back reclamation.
	base, err := s2.Reclaim()
	if err != nil {
		t.Fatal(err)
	}
	if base != 1 {
		t.Fatalf("base = %d, want 1 (only active consumer's prefix)", base)
	}
}

func TestReclaimTakesMinOfActivePrefixes(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	if _, err := s.Append(10); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{0, 1, 2} {
		if err := s.Ack("slow", id); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []int{0, 1, 2, 3, 4, 5, 6} {
		if err := s.Ack("fast", id); err != nil {
			t.Fatal(err)
		}
	}
	base, err := s.Reclaim()
	if err != nil {
		t.Fatal(err)
	}
	if base != 3 {
		t.Fatalf("base = %d, want 3 (min of active prefixes 3 and 7)", base)
	}

	// Once the slow consumer leaves, the fast one sets the watermark.
	if err := s.Cancel("slow"); err != nil {
		t.Fatal(err)
	}
	base, err = s.Reclaim()
	if err != nil {
		t.Fatal(err)
	}
	if base != 7 {
		t.Fatalf("base = %d, want 7 after slow consumer cancelled", base)
	}

	// Reclaimed segments are treated as covered: fast's prefix is
	// measured from the new base.
	if got := s.Prefix("fast"); got != 7 {
		t.Fatalf("fast prefix = %d, want 7", got)
	}
	// Acking a reclaimed id is a harmless no-op.
	if err := s.Ack("fast", 2); err != nil {
		t.Fatalf("ack of reclaimed id: %v", err)
	}
}

func TestReclaimWithNoActiveConsumersIsNoop(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	if _, err := s.Append(5); err != nil {
		t.Fatal(err)
	}
	if err := s.Ack("c1", 0); err != nil {
		t.Fatal(err)
	}
	if err := s.Cancel("c1"); err != nil {
		t.Fatal(err)
	}
	base, err := s.Reclaim()
	if err != nil {
		t.Fatal(err)
	}
	if base != 0 {
		t.Fatalf("base = %d, want 0 with no active consumers", base)
	}
}

func TestReplayRestoresStateExactly(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Append(6); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{0, 1, 3} {
		if err := s.Ack("a", id); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Ack("b", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reclaim(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if s2.Segments() != 6 || s2.Base() != 1 {
		t.Fatalf("segments=%d base=%d, want 6 and 1", s2.Segments(), s2.Base())
	}
	if got := s2.Prefix("a"); got != 2 {
		t.Fatalf("a prefix = %d, want 2 (gap at 2 survives replay)", got)
	}
	if got := s2.Prefix("b"); got != 1 {
		t.Fatalf("b prefix = %d, want 1", got)
	}
}
