package seglib

import (
	"errors"
	"testing"
)

func TestOutOfOrderAcksAdvanceOnlyContiguousPrefix(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.Append("a", "b", "c", "d", "e", "f")
	if err := s.Register("c1", 0); err != nil {
		t.Fatal(err)
	}
	for _, off := range []uint64{1, 2, 4} {
		if err := s.Ack("c1", off); err != nil {
			t.Fatal(err)
		}
	}
	if p, _ := s.Prefix("c1"); p != 0 {
		t.Fatalf("prefix moved past a gap: got %d, want 0", p)
	}
	if err := s.Ack("c1", 0); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Prefix("c1"); p != 3 {
		t.Fatalf("prefix after filling gap: got %d, want 3", p)
	}
	if err := s.Ack("c1", 3); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Prefix("c1"); p != 5 {
		t.Fatalf("prefix after chaining buffered acks: got %d, want 5", p)
	}
}

func TestReclaimUsesMinActivePrefix(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.Append("m0", "m1") // segment [0,2)
	s.Append("m2", "m3") // segment [2,4)
	s.Append("m4", "m5") // segment [4,6)
	mustRegister(t, s, "fast", 0)
	mustRegister(t, s, "slow", 0)
	for off := uint64(0); off < 5; off++ {
		if err := s.Ack("fast", off); err != nil {
			t.Fatal(err)
		}
	}
	for off := uint64(0); off < 2; off++ {
		if err := s.Ack("slow", off); err != nil {
			t.Fatal(err)
		}
	}
	if bound, ok := s.ReclaimBound(); !ok || bound != 2 {
		t.Fatalf("reclaim bound: got %d,%v want 2,true", bound, ok)
	}
	if n := s.Reclaim(); n != 1 {
		t.Fatalf("reclaimed %d segments, want 1", n)
	}
	segs := s.Segments()
	if len(segs) != 2 || segs[0].Base != 2 {
		t.Fatalf("surviving segments: %+v", segs)
	}
	// The slow consumer pins the bound; once it catches up, more goes.
	for off := uint64(2); off < 5; off++ {
		if err := s.Ack("slow", off); err != nil {
			t.Fatal(err)
		}
	}
	if n := s.Reclaim(); n != 1 {
		t.Fatalf("second reclaim dropped %d, want 1", n)
	}
	if segs := s.Segments(); len(segs) != 1 || segs[0].Base != 4 {
		t.Fatalf("surviving segments after catch-up: %+v", segs)
	}
}

func TestReclaimNoActiveConsumersIsNoop(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.Append("m0", "m1")
	if n := s.Reclaim(); n != 0 {
		t.Fatalf("reclaimed %d with no active consumers, want 0", n)
	}
	if _, ok := s.ReclaimBound(); ok {
		t.Fatal("reclaim bound reported with no active consumers")
	}
}

func TestCancelKeepsPersistentExitRecord(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Append("m0", "m1", "m2")
	mustRegister(t, s, "gone", 0)
	if err := s.Ack("gone", 0); err != nil {
		t.Fatal(err)
	}
	if err := s.Cancel("gone"); err != nil {
		t.Fatal(err)
	}
	if err := s.Register("gone", 0); !errors.Is(err, ErrConsumerExited) {
		t.Fatalf("re-register after cancel: got %v, want ErrConsumerExited", err)
	}

	// Restart: the exit record must survive and block resurrection.
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s2.Register("gone", 0); !errors.Is(err, ErrConsumerExited) {
		t.Fatalf("register after restart: got %v, want ErrConsumerExited", err)
	}
	rec, ok := s2.Exited("gone")
	if !ok {
		t.Fatal("exit record lost after restart")
	}
	if rec.FinalPrefix != 1 {
		t.Fatalf("recorded final prefix: got %d, want 1", rec.FinalPrefix)
	}
	if _, err := s2.Prefix("gone"); !errors.Is(err, ErrConsumerExited) {
		t.Fatalf("prefix of cancelled consumer: got %v, want ErrConsumerExited", err)
	}
	if err := s2.Cancel("gone"); !errors.Is(err, ErrConsumerExited) {
		t.Fatalf("double cancel: got %v, want ErrConsumerExited", err)
	}
}

func TestReplayStartsAtPrefixAndSkipsReclaimed(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.Append("m0", "m1")
	s.Append("m2", "m3")
	mustRegister(t, s, "c", 0)
	for _, off := range []uint64{0, 1, 2} {
		if err := s.Ack("c", off); err != nil {
			t.Fatal(err)
		}
	}
	if n := s.Reclaim(); n != 1 {
		t.Fatalf("reclaimed %d, want 1", n)
	}
	msgs, err := s.Replay("c")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Offset != 3 || msgs[0].Body != "m3" {
		t.Fatalf("replay: got %+v, want only m3 at offset 3", msgs)
	}
}

func TestUnknownConsumerErrors(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Ack("nope", 0); !errors.Is(err, ErrNoConsumer) {
		t.Fatalf("ack unknown: %v", err)
	}
	if err := s.Cancel("nope"); !errors.Is(err, ErrNoConsumer) {
		t.Fatalf("cancel unknown: %v", err)
	}
	mustRegister(t, s, "dup", 0)
	if err := s.Register("dup", 0); !errors.Is(err, ErrConsumerActive) {
		t.Fatalf("double register: %v", err)
	}
}

func mustRegister(t *testing.T, s *Store, name string, start uint64) {
	t.Helper()
	if err := s.Register(name, start); err != nil {
		t.Fatalf("register %s: %v", name, err)
	}
}
