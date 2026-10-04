package cover

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
)

var (
	srcA = DigestOf([]byte("package a\nfunc A() {}\n"))
	srcB = DigestOf([]byte("package b\nfunc B() {}\n"))
)

func TestMergeSumsAcrossProcesses(t *testing.T) {
	s := NewStore(srcA)
	// Two processes (distinct run IDs) report overlapping edges.
	if ok, err := s.Merge(Delta{Digest: srcA, RunID: 1, Edges: map[uint64]uint64{0: 3, 1: 5}}); !ok || err != nil {
		t.Fatalf("merge run 1: ok=%v err=%v", ok, err)
	}
	if ok, err := s.Merge(Delta{Digest: srcA, RunID: 2, Edges: map[uint64]uint64{1: 7, 2: 11}}); !ok || err != nil {
		t.Fatalf("merge run 2: ok=%v err=%v", ok, err)
	}
	for edge, want := range map[uint64]uint64{0: 3, 1: 12, 2: 11} {
		if got := s.Count(edge); got != want {
			t.Errorf("edge %d: got %d, want %d", edge, got, want)
		}
	}
	if s.Runs() != 2 {
		t.Errorf("Runs() = %d, want 2", s.Runs())
	}
}

func TestForeignDigestRejected(t *testing.T) {
	s := NewStore(srcA)
	if _, err := s.Merge(Delta{Digest: srcA, RunID: 1, Edges: map[uint64]uint64{0: 1}}); err != nil {
		t.Fatal(err)
	}
	ok, err := s.Merge(Delta{Digest: srcB, RunID: 2, Edges: map[uint64]uint64{0: 100, 9: 100}})
	if !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("err = %v, want ErrDigestMismatch", err)
	}
	if ok {
		t.Fatal("foreign delta reported as applied")
	}
	// Counts from another source must not leak into the store.
	if got := s.Count(0); got != 1 {
		t.Errorf("edge 0 = %d, want 1 (foreign counts mixed in)", got)
	}
	if got := s.Count(9); got != 0 {
		t.Errorf("edge 9 = %d, want 0 (foreign counts mixed in)", got)
	}
	if s.Runs() != 1 {
		t.Errorf("Runs() = %d, want 1", s.Runs())
	}
}

func TestDuplicateRunCountedOnce(t *testing.T) {
	s := NewStore(srcA)
	d := Delta{Digest: srcA, RunID: 42, Edges: map[uint64]uint64{7: 4}}
	if ok, err := s.Merge(d); !ok || err != nil {
		t.Fatalf("first merge: ok=%v err=%v", ok, err)
	}
	for i := 0; i < 3; i++ {
		ok, err := s.Merge(d)
		if err != nil {
			t.Fatalf("re-merge %d: err=%v", i, err)
		}
		if ok {
			t.Fatalf("re-merge %d reported as applied", i)
		}
	}
	if got := s.Count(7); got != 4 {
		t.Errorf("edge 7 = %d, want 4 (duplicate run counted more than once)", got)
	}
	if s.Runs() != 1 {
		t.Errorf("Runs() = %d, want 1", s.Runs())
	}
}

func TestOverflowReportedAndAtomic(t *testing.T) {
	s := NewStore(srcA)
	if _, err := s.Merge(Delta{Digest: srcA, RunID: 1, Edges: map[uint64]uint64{0: math.MaxUint64 - 3, 1: 10}}); err != nil {
		t.Fatal(err)
	}
	// Edge 0 overflows; edge 1 would fit but must not be applied either.
	ok, err := s.Merge(Delta{Digest: srcA, RunID: 2, Edges: map[uint64]uint64{0: 4, 1: 5}})
	if !errors.Is(err, ErrOverflow) {
		t.Fatalf("err = %v, want ErrOverflow", err)
	}
	if ok {
		t.Fatal("overflowing delta reported as applied")
	}
	if got := s.Count(0); got != math.MaxUint64-3 {
		t.Errorf("edge 0 = %d, want %d (partial merge)", got, uint64(math.MaxUint64-3))
	}
	if got := s.Count(1); got != 10 {
		t.Errorf("edge 1 = %d, want 10 (partial merge)", got)
	}
	if s.Runs() != 1 {
		t.Errorf("Runs() = %d, want 1 (failed run recorded)", s.Runs())
	}
	// Exactly hitting MaxUint64 is still legal.
	if ok, err := s.Merge(Delta{Digest: srcA, RunID: 3, Edges: map[uint64]uint64{0: 3}}); !ok || err != nil {
		t.Fatalf("boundary merge: ok=%v err=%v", ok, err)
	}
	if got := s.Count(0); got != math.MaxUint64 {
		t.Errorf("edge 0 = %d, want MaxUint64", got)
	}
}

func TestWALRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cover.wal")
	l, err := Open(path, srcA)
	if err != nil {
		t.Fatal(err)
	}
	deltas := []Delta{
		{Digest: srcA, RunID: 1, Edges: map[uint64]uint64{0: 1, 1: 2}},
		{Digest: srcA, RunID: 2, Edges: map[uint64]uint64{1: 3, 2: 4}},
		{Digest: srcA, RunID: 2, Edges: map[uint64]uint64{1: 3, 2: 4}}, // duplicate: not logged
		{Digest: srcA, RunID: 3, Edges: map[uint64]uint64{2: 5}},
	}
	for _, d := range deltas {
		if _, err := l.Merge(d); err != nil {
			t.Fatal(err)
		}
	}
	want := l.Store().Snapshot()
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}

	rec, err := Open(path, srcA)
	if err != nil {
		t.Fatal(err)
	}
	defer rec.Close()
	got := rec.Store().Snapshot()
	if len(got) != len(want) {
		t.Fatalf("recovered %d edges, want %d", len(got), len(want))
	}
	for edge, c := range want {
		if got[edge] != c {
			t.Errorf("edge %d: recovered %d, want %d", edge, got[edge], c)
		}
	}
	if rec.Store().Runs() != 3 {
		t.Errorf("recovered Runs() = %d, want 3 (duplicate not persisted)", rec.Store().Runs())
	}
	// Re-merging an already-persisted run after recovery is still a no-op.
	if ok, err := rec.Merge(deltas[0]); ok || err != nil {
		t.Errorf("re-merge after recovery: ok=%v err=%v, want no-op", ok, err)
	}
}

func TestWALRejectsForeignLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cover.wal")
	l, err := Open(path, srcA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.Merge(Delta{Digest: srcA, RunID: 1, Edges: map[uint64]uint64{0: 1}}); err != nil {
		t.Fatal(err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	// Reopening the same log under a different source digest must fail
	// rather than mix counts.
	if _, err := Open(path, srcB); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("reopen with foreign digest: err = %v, want ErrDigestMismatch", err)
	}
}

func TestWALTornTailIgnored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cover.wal")
	l, err := Open(path, srcA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.Merge(Delta{Digest: srcA, RunID: 1, Edges: map[uint64]uint64{0: 9}}); err != nil {
		t.Fatal(err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	// Simulate a crash mid-write: garbage appended to the log.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{0, 0, 0, 40, '{', '"'}); err != nil {
		t.Fatal(err)
	}
	f.Close()

	rec, err := Open(path, srcA)
	if err != nil {
		t.Fatalf("recovery with torn tail: %v", err)
	}
	defer rec.Close()
	if got := rec.Store().Count(0); got != 9 {
		t.Errorf("edge 0 = %d, want 9 after torn-tail recovery", got)
	}
}
