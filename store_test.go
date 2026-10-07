package dedup

import (
	"fmt"
	"testing"
)

func TestStoreCommitRecover(t *testing.T) {
	mv := NewMemVolume()
	s, err := OpenStore(mv, 8)
	if err != nil {
		t.Fatal(err)
	}
	w := NewWindow(8)
	for _, seq := range []uint64{10, 11, 15, 13} {
		w.Observe(seq)
		if err := s.Commit("p1", w, []byte(fmt.Sprintf("e%d", seq))); err != nil {
			t.Fatal(err)
		}
	}
	s2, err := OpenStore(mv, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.Journal) != 4 {
		t.Fatalf("journal len = %d, want 4", len(s2.Journal))
	}
	w2 := s2.Windows["p1"]
	for _, seq := range []uint64{10, 11, 13, 15} {
		if !w2.Seen(seq) {
			t.Fatalf("seq %d lost after recovery", seq)
		}
	}
	if w2.Seen(12) || w2.Seen(14) {
		t.Fatal("unseen seq reported as seen after recovery")
	}
}

func TestStoreIgnoresTornTail(t *testing.T) {
	for _, tc := range []struct {
		name string
		tail func(rec []byte) []byte
	}{
		{"partial_record", func(rec []byte) []byte { return rec[:len(rec)/2] }},
		{"header_only", func(rec []byte) []byte { return rec[:headerLen] }},
		{"partial_header", func(rec []byte) []byte { return rec[:3] }},
		{"bad_crc", func(rec []byte) []byte {
			out := append([]byte(nil), rec...)
			out[len(out)-1] ^= 0xff
			return out
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mv := NewMemVolume()
			s, err := OpenStore(mv, 8)
			if err != nil {
				t.Fatal(err)
			}
			w := NewWindow(8)
			w.Observe(1)
			if err := s.Commit("p", w, []byte("e1")); err != nil {
				t.Fatal(err)
			}
			w.Observe(2)
			if err := s.Commit("p", w, []byte("e2")); err != nil {
				t.Fatal(err)
			}
			// Simulate a torn third commit directly on the volume.
			w.Observe(3)
			rec := encodeRecord(encodeDelta("p", w, []byte("e3")))
			if err := mv.Append(tc.tail(rec)); err != nil {
				t.Fatal(err)
			}
			if err := mv.Sync(); err != nil {
				t.Fatal(err)
			}

			s2, err := OpenStore(mv, 8)
			if err != nil {
				t.Fatal(err)
			}
			if len(s2.Journal) != 2 {
				t.Fatalf("journal len = %d, want 2 (torn tail must be ignored)", len(s2.Journal))
			}
			// The store must keep accepting commits after a torn tail.
			if err := s2.Commit("p", w, []byte("e3")); err != nil {
				t.Fatal(err)
			}
			s3, err := OpenStore(mv, 8)
			if err != nil {
				t.Fatal(err)
			}
			if len(s3.Journal) != 3 {
				t.Fatalf("journal len = %d, want 3", len(s3.Journal))
			}
		})
	}
}

func TestStoreCompact(t *testing.T) {
	mv := NewMemVolume()
	s, err := OpenStore(mv, 8)
	if err != nil {
		t.Fatal(err)
	}
	w1 := NewWindow(8)
	w1.Observe(7)
	w2 := NewWindow(8)
	w2.Observe(42)
	if err := s.Commit("a", w1, []byte("ea")); err != nil {
		t.Fatal(err)
	}
	if err := s.Commit("b", w2, []byte("eb")); err != nil {
		t.Fatal(err)
	}
	if err := s.Compact(); err != nil {
		t.Fatal(err)
	}
	s2, err := OpenStore(mv, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.Journal) != 2 || !s2.Windows["a"].Seen(7) || !s2.Windows["b"].Seen(42) {
		t.Fatalf("state lost across compact: journal=%d windows=%v", len(s2.Journal), s2.Windows)
	}
	// Commits after a compact must survive recovery too.
	w1.Observe(8)
	if err := s2.Commit("a", w1, []byte("ea2")); err != nil {
		t.Fatal(err)
	}
	s3, err := OpenStore(mv, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(s3.Journal) != 3 || !s3.Windows["a"].Seen(8) {
		t.Fatalf("state lost after post-compact commit: journal=%d", len(s3.Journal))
	}
}

// compactIndex is the script position before which a compaction is
// injected, so crash points on the Replace boundary are covered too.
const compactIndex = 6

func buildScript() []Message {
	return []Message{
		{Producer: "p1", Seq: 10},
		{Producer: "p1", Seq: 11},
		{Producer: "p1", Seq: 11}, // duplicate
		{Producer: "p1", Seq: 15}, // gap jump
		{Producer: "p1", Seq: 13}, // gap fill
		{Producer: "p1", Seq: 13}, // duplicate
		{Producer: "p2", Seq: 100},
		{Producer: "p1", Seq: 5},  // too old (window 8, high 15)
		{Producer: "p1", Seq: 9},  // in-window old, accepted
		{Producer: "p1", Seq: 30}, // big jump, window cleared
		{Producer: "p1", Seq: 15}, // now too old
		{Producer: "p1", Seq: 29}, // in-window, accepted
		{Producer: "p2", Seq: 100},
		{Producer: "p1", Seq: 29},
	}
}

// runScript executes the script against a fresh FaultVolume, crashing
// once at the target write boundary (target <= 0 means no crash), then
// returns the recovered journal.
func runScript(t *testing.T, script []Message, windowSize, target, torn int) (*Consumer, []string) {
	t.Helper()
	fv := NewFaultVolume(NewMemVolume())
	fv.TornAppend = torn
	n := 0
	fv.OnBoundary = func(Boundary) {
		n++
		if n == target {
			panic(errCrash)
		}
	}
	c, err := OpenConsumer(fv, windowSize, testEffect)
	if err != nil {
		t.Fatal(err)
	}
	crashed := false
	tryDo := func(fn func()) {
		defer func() {
			if r := recover(); r != nil {
				if r != errCrash {
					panic(r)
				}
				crashed = true
			}
		}()
		fn()
	}
	for i, m := range script {
		if i == compactIndex {
			tryDo(func() { _ = c.Compact() })
			if crashed {
				c = reopenConsumer(t, fv, windowSize)
				crashed = false
			}
		}
		tryDo(func() { _, _ = c.Handle(m) })
		if crashed {
			c = reopenConsumer(t, fv, windowSize)
			crashed = false
			// At-least-once redelivery of the in-flight message.
			if !c.Seen(m.Producer, m.Seq) {
				if _, err := c.Handle(m); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	// Final reboot: the journal must survive recovery.
	c = reopenConsumer(t, fv, windowSize)
	return c, journalStrings(c)
}

func countBoundaries(t *testing.T, script []Message, windowSize int) int {
	t.Helper()
	fv := NewFaultVolume(NewMemVolume())
	n := 0
	fv.OnBoundary = func(Boundary) { n++ }
	c, err := OpenConsumer(fv, windowSize, testEffect)
	if err != nil {
		t.Fatal(err)
	}
	for i, m := range script {
		if i == compactIndex {
			if err := c.Compact(); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := c.Handle(m); err != nil {
			t.Fatal(err)
		}
	}
	return n
}

// TestCrashAtEveryWriteBoundary injects a power loss at every single
// write boundary of the workload and verifies, against the full-set
// reference, that no effect is ever duplicated or lost.
func TestCrashAtEveryWriteBoundary(t *testing.T) {
	const windowSize = 8
	script := buildScript()
	want := runReference(script, windowSize)
	total := countBoundaries(t, script, windowSize)
	if total == 0 {
		t.Fatal("no write boundaries observed")
	}
	for target := 1; target <= total; target++ {
		t.Run(fmt.Sprintf("boundary_%d_of_%d", target, total), func(t *testing.T) {
			_, got := runScript(t, script, windowSize, target, 0)
			assertJournalEqual(t, got, want)
		})
	}
}

// TestCrashWithTornWrites repeats the boundary sweep with partially
// flushed (torn) writes of various lengths leaking to disk.
func TestCrashWithTornWrites(t *testing.T) {
	const windowSize = 8
	script := buildScript()
	want := runReference(script, windowSize)
	total := countBoundaries(t, script, windowSize)
	for _, torn := range []int{1, 3, 7, 64, 1 << 20} {
		for target := 1; target <= total; target++ {
			t.Run(fmt.Sprintf("torn_%d_boundary_%d", torn, target), func(t *testing.T) {
				_, got := runScript(t, script, windowSize, target, torn)
				assertJournalEqual(t, got, want)
			})
		}
	}
}
