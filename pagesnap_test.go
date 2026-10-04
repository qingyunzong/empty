package pagesnap

import (
	"bytes"
	"testing"
)

func fill(b []byte, v byte) []byte {
	for i := range b {
		b[i] = v
	}
	return b
}

func mustRead(t *testing.T, snap *Snapshot, page uint64) []byte {
	t.Helper()
	data, err := snap.Read(page)
	if err != nil {
		t.Fatalf("Read(%d): %v", page, err)
	}
	return data
}

func mustWrite(t *testing.T, snap *Snapshot, page uint64, data []byte) {
	t.Helper()
	if err := snap.Write(page, data); err != nil {
		t.Fatalf("Write(%d): %v", page, err)
	}
}

func mustClose(t *testing.T, snap *Snapshot) {
	t.Helper()
	if err := snap.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func mustFork(t *testing.T, snap *Snapshot) *Snapshot {
	t.Helper()
	child, err := snap.Fork()
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	return child
}

func TestUnwrittenPageReadsZero(t *testing.T) {
	s := NewStore()
	a := s.NewSnapshot()
	defer a.Close()
	got := mustRead(t, a, 7)
	if !bytes.Equal(got, make([]byte, PageSize)) {
		t.Fatal("unwritten page is not all zeros")
	}
	if st := s.Stats(); st.LivePages != 0 {
		t.Fatalf("reading an unwritten page allocated storage: %+v", st)
	}
}

func TestForkIsolationBothDirections(t *testing.T) {
	s := NewStore()
	a := s.NewSnapshot()
	mustWrite(t, a, 0, fill(make([]byte, 100), 0xAA))

	b := mustFork(t, a)
	// Both branches rewrite the same shared page.
	mustWrite(t, a, 0, fill(make([]byte, 100), 0xBB))
	mustWrite(t, b, 0, fill(make([]byte, 100), 0xCC))

	if got := mustRead(t, a, 0); got[0] != 0xBB {
		t.Fatalf("branch a sees 0x%02X, want 0xBB", got[0])
	}
	if got := mustRead(t, b, 0); got[0] != 0xCC {
		t.Fatalf("branch b sees 0x%02X, want 0xCC", got[0])
	}
	if err := s.VerifyRefCounts(); err != nil {
		t.Fatal(err)
	}
	mustClose(t, a)
	mustClose(t, b)
	if st := s.Stats(); st.LivePages != 0 {
		t.Fatalf("pages leaked: %+v", st)
	}
}

func TestRefCountsAndReclamation(t *testing.T) {
	s := NewStore()
	a := s.NewSnapshot()
	mustWrite(t, a, 0, fill(make([]byte, 10), 0x01))

	b := mustFork(t, a) // shares the page
	c := mustFork(t, a) // shares the page
	if st := s.Stats(); st.LivePages != 1 || st.TotalRefs != 3 {
		t.Fatalf("after forks: %+v, want 1 page with 3 refs", st)
	}

	// b diverges: COW allocates a second page.
	mustWrite(t, b, 0, fill(make([]byte, 10), 0x02))
	if st := s.Stats(); st.LivePages != 2 || st.CowCopies != 1 {
		t.Fatalf("after COW: %+v, want 2 pages and 1 cow copy", st)
	}

	// Closing a must not reclaim the page: c still references it.
	mustClose(t, a)
	if st := s.Stats(); st.LivePages != 2 {
		t.Fatalf("page reclaimed while old view alive: %+v", st)
	}
	if got := mustRead(t, c, 0); got[0] != 0x01 {
		t.Fatalf("surviving view c sees 0x%02X, want original 0x01", got[0])
	}

	mustClose(t, c) // drops the original page
	if st := s.Stats(); st.LivePages != 1 {
		t.Fatalf("after closing c: %+v, want 1 page left", st)
	}
	mustClose(t, b)
	if st := s.Stats(); st.LivePages != 0 || st.Allocs != st.Frees {
		t.Fatalf("not fully reclaimed: %+v", st)
	}
	if err := s.VerifyRefCounts(); err != nil {
		t.Fatal(err)
	}
}

func TestPartialWritePreservesRest(t *testing.T) {
	s := NewStore()
	a := s.NewSnapshot()
	mustWrite(t, a, 0, fill(make([]byte, PageSize), 0x0F))
	b := mustFork(t, a)
	mustWrite(t, b, 0, fill(make([]byte, 16), 0x77)) // COW, partial
	got := mustRead(t, b, 0)
	if got[0] != 0x77 || got[100] != 0x0F {
		t.Fatalf("partial write clobbered untouched bytes: got[0]=0x%02X got[100]=0x%02X", got[0], got[100])
	}
	// The shared source page must be untouched.
	if got := mustRead(t, a, 0); got[0] != 0x0F {
		t.Fatalf("source view modified by child's COW write: 0x%02X", got[0])
	}
	mustClose(t, a)
	mustClose(t, b)
}

func TestClosedSnapshotRejectsOps(t *testing.T) {
	s := NewStore()
	a := s.NewSnapshot()
	mustWrite(t, a, 0, []byte("x"))
	mustClose(t, a)
	if _, err := a.Read(0); err != ErrClosed {
		t.Fatalf("Read after close: %v", err)
	}
	if err := a.Write(0, []byte("y")); err != ErrClosed {
		t.Fatalf("Write after close: %v", err)
	}
	if _, err := a.Fork(); err != ErrClosed {
		t.Fatalf("Fork after close: %v", err)
	}
	if err := a.Close(); err != ErrClosed {
		t.Fatalf("double Close: %v", err)
	}
}

func TestWriteOverflowRejected(t *testing.T) {
	s := NewStore()
	a := s.NewSnapshot()
	defer a.Close()
	if err := a.Write(0, make([]byte, PageSize+1)); err != ErrOverflow {
		t.Fatalf("oversized write: %v", err)
	}
}

func TestDeepForkChain(t *testing.T) {
	s := NewStore()
	snaps := []*Snapshot{s.NewSnapshot()}
	mustWrite(t, snaps[0], 0, []byte("gen-0"))
	// Fork a chain of 64 generations, each tagging its own page.
	for i := 1; i < 64; i++ {
		snaps = append(snaps, mustFork(t, snaps[i-1]))
		mustWrite(t, snaps[i], uint64(i), []byte{byte(i)})
	}
	// Every ancestor must still see its own generation and zeros beyond.
	for i, snap := range snaps {
		for j := 0; j < 64; j++ {
			got := mustRead(t, snap, uint64(j))
			want := byte(0)
			if j <= i && j > 0 {
				want = byte(j)
			}
			if j == 0 {
				if string(got[:5]) != "gen-0" {
					t.Fatalf("gen %d lost root page", i)
				}
				continue
			}
			if got[0] != want {
				t.Fatalf("gen %d page %d = %d, want %d", i, j, got[0], want)
			}
		}
	}
	// Close in random-ish order; every page must be reclaimed exactly once.
	for i := len(snaps) - 1; i >= 0; i-- {
		mustClose(t, snaps[i])
		if err := s.VerifyRefCounts(); err != nil {
			t.Fatalf("after closing gen %d: %v", i, err)
		}
	}
	if st := s.Stats(); st.LivePages != 0 {
		t.Fatalf("leaked pages: %+v", st)
	}
}
