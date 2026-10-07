package pagestore

import (
	"errors"
	"fmt"
	"testing"
)

func put(t *testing.T, tx *Txn, key, val string) {
	t.Helper()
	if err := tx.Put(key, []byte(val)); err != nil {
		t.Fatal(err)
	}
}

func mustOpen(t *testing.T, b Backend, capacity int) *Store {
	t.Helper()
	s, err := Open(b, capacity)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func mustCommit(t *testing.T, tx *Txn) {
	t.Helper()
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
}

func mustGet(t *testing.T, v *View, key, want string) {
	t.Helper()
	got, ok, err := v.Get(key)
	if err != nil {
		t.Fatalf("Get(%q): %v", key, err)
	}
	if !ok {
		t.Fatalf("Get(%q): key missing", key)
	}
	if string(got) != want {
		t.Fatalf("Get(%q) = %q, want %q", key, got, want)
	}
}

// New pages written by a transaction consume quota; committing switches
// the root so new readers see the new version.
func TestCommitConsumesQuotaAndSwitchesRoot(t *testing.T) {
	s := mustOpen(t, NewMemBackend(), 64)
	if got := s.Stats(); got.Used != 1 {
		t.Fatalf("fresh store Used = %d, want 1 (root page)", got.Used)
	}

	tx := s.Begin()
	put(t, tx, "a", "1")
	put(t, tx, "b", "2")
	mustCommit(t, tx)

	st := s.Stats()
	if st.Version != 1 {
		t.Fatalf("Version = %d, want 1", st.Version)
	}
	// 2 data pages + 1 new root; the old root is reclaimed at once
	// because no reader pins the previous version.
	if st.Used != 3 {
		t.Fatalf("Used = %d, want 3", st.Used)
	}

	v := s.BeginRead()
	defer v.Close()
	mustGet(t, v, "a", "1")
	mustGet(t, v, "b", "2")
}

// A reader pinned to an old root keeps reading old pages while a
// concurrent commit publishes new ones.
func TestOldReadersKeepOldSnapshot(t *testing.T) {
	s := mustOpen(t, NewMemBackend(), 64)

	tx := s.Begin()
	put(t, tx, "k", "old")
	mustCommit(t, tx)

	r1 := s.BeginRead()
	defer r1.Close()

	tx2 := s.Begin()
	put(t, tx2, "k", "new")
	mustCommit(t, tx2)

	mustGet(t, r1, "k", "old") // pinned snapshot unchanged

	r2 := s.BeginRead()
	defer r2.Close()
	mustGet(t, r2, "k", "new") // new readers see the new root
}

// Superseded pages stay out of the freelist while a reader pins their
// version, and are reclaimed as soon as the last such reader closes.
func TestReclaimWaitsForReaders(t *testing.T) {
	s := mustOpen(t, NewMemBackend(), 64)

	tx := s.Begin()
	put(t, tx, "k", "v1")
	mustCommit(t, tx)

	r1 := s.BeginRead()

	tx2 := s.Begin()
	put(t, tx2, "k", "v2")
	mustCommit(t, tx2)

	st := s.Stats()
	// The superseded data page and old root are pinned by r1.
	if st.PendingFree != 2 {
		t.Fatalf("PendingFree = %d, want 2 while reader is pinned", st.PendingFree)
	}
	if st.Free != 0 {
		t.Fatalf("Free = %d, want 0: pinned pages must not be reclaimed", st.Free)
	}

	r1.Close()
	st = s.Stats()
	if st.PendingFree != 0 {
		t.Fatalf("PendingFree = %d after last reader closed, want 0", st.PendingFree)
	}
	if st.Free != 2 {
		t.Fatalf("Free = %d after reader closed, want 2 reclaimed pages", st.Free)
	}
}

// Repeated commits without pinned readers must not grow usage: freed
// pages are recycled, so capacity is conserved across versions.
func TestCapacityConservedAcrossChurn(t *testing.T) {
	s := mustOpen(t, NewMemBackend(), 16)
	maxUsed := 0
	for i := 0; i < 200; i++ {
		tx := s.Begin()
		key := fmt.Sprintf("k%d", i%4)
		put(t, tx, key, fmt.Sprintf("val-%d", i))
		if i%3 == 0 {
			if err := tx.Delete(fmt.Sprintf("k%d", (i+1)%4)); err != nil {
				t.Fatal(err)
			}
		}
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit %d: %v", i, err)
		}
		if u := s.Stats().Used; u > maxUsed {
			maxUsed = u
		}
	}
	st := s.Stats()
	if st.Used > st.Capacity {
		t.Fatalf("Used = %d exceeds capacity %d", st.Used, st.Capacity)
	}
	if maxUsed > 10 {
		t.Fatalf("max Used = %d over 200 commits, recycling broken", maxUsed)
	}
	if st.PendingFree != 0 {
		t.Fatalf("PendingFree = %d with no readers, want 0", st.PendingFree)
	}
}

// When quota is insufficient the commit is rejected, the store is
// untouched, and the draft survives: after old readers release their
// pages, the same transaction commits successfully.
func TestQuotaExceededRejectsCommitAndKeepsDraft(t *testing.T) {
	s := mustOpen(t, NewMemBackend(), 10)

	tx := s.Begin()
	for _, k := range []string{"k1", "k2", "k3"} {
		put(t, tx, k, "v1")
	}
	mustCommit(t, tx) // v1: 4 pages used, 1 reclaimed

	r1 := s.BeginRead() // pins v1, blocking reclaim of its pages

	tx2 := s.Begin()
	for _, k := range []string{"k1", "k2", "k3"} {
		put(t, tx2, k, "v2")
	}
	mustCommit(t, tx2) // v2: 8 pages used, v1's 4 pages pinned by r1

	// A third rewrite needs 4 fresh pages; with v1 pinned the store
	// cannot stay within the quota of 10.
	tx3 := s.Begin()
	for _, k := range []string{"k1", "k2", "k3"} {
		put(t, tx3, k, "v3")
	}

	before := s.Stats()
	err := tx3.Commit()
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("Commit err = %v, want ErrQuotaExceeded", err)
	}
	if after := s.Stats(); after != before {
		t.Fatalf("stats changed by rejected commit: %+v -> %+v", before, after)
	}

	// Draft intact: staged values still readable, transaction not closed.
	for _, k := range []string{"k1", "k2", "k3"} {
		got, ok, gerr := tx3.Get(k)
		if gerr != nil || !ok || string(got) != "v3" {
			t.Fatalf("draft lost after rejection: Get(%q)=%q,%v,%v", k, got, ok, gerr)
		}
	}

	// Committed state untouched.
	mustGet(t, r1, "k1", "v1")

	// Releasing the old reader reclaims v1's pages, and the very same
	// draft now commits within quota.
	r1.Close()
	mustCommit(t, tx3)

	v := s.BeginRead()
	defer v.Close()
	mustGet(t, v, "k1", "v3")
}

// An injected write failure must abort the commit atomically: root
// unchanged, old readers unaffected, and page accounting conserved so a
// retry against a healthy device succeeds.
func TestWriteFailureIsAtomicAndConservesCapacity(t *testing.T) {
	fb := &FailBackend{Inner: NewMemBackend()}
	s := mustOpen(t, fb, 32)

	tx := s.Begin()
	put(t, tx, "k", "v1")
	mustCommit(t, tx)

	r1 := s.BeginRead()
	defer r1.Close()

	tx2 := s.Begin()
	put(t, tx2, "k", "v2")
	put(t, tx2, "k2", "x")

	before := s.Stats()
	fb.Reset()
	fb.FailAt = 2 // fail mid-commit, before the root page is written

	if err := tx2.Commit(); err == nil {
		t.Fatal("expected injected write failure")
	}
	if fb.Writes() != 2 {
		t.Fatalf("Writes = %d, want 2 (stopped at injected failure)", fb.Writes())
	}

	after := s.Stats()
	if after != before {
		t.Fatalf("capacity not conserved across failed commit: %+v -> %+v", before, after)
	}
	mustGet(t, r1, "k", "v1") // old root still serves old readers
	if _, ok, _ := r1.Get("k2"); ok {
		t.Fatal("k2 visible after failed commit: root switch was not atomic")
	}

	// Device recovers; the intact draft commits and the root switches once.
	fb.Reset()
	mustCommit(t, tx2)

	v := s.BeginRead()
	defer v.Close()
	mustGet(t, v, "k", "v2")
	mustGet(t, v, "k2", "x")
}

// A sync failure (after all pages were written) must also roll back
// cleanly: no root switch, no quota leak.
func TestSyncFailureIsAtomicAndConservesCapacity(t *testing.T) {
	fb := &FailBackend{Inner: NewMemBackend()}
	s := mustOpen(t, fb, 32)

	tx := s.Begin()
	put(t, tx, "k", "v1")
	mustCommit(t, tx)

	tx2 := s.Begin()
	put(t, tx2, "k", "v2")

	before := s.Stats()
	fb.SyncErr = errors.New("disk stuck")
	if err := tx2.Commit(); err == nil {
		t.Fatal("expected sync failure")
	}
	if after := s.Stats(); after != before {
		t.Fatalf("capacity not conserved across sync failure: %+v -> %+v", before, after)
	}

	fb.Reset()
	mustCommit(t, tx2)

	v := s.BeginRead()
	defer v.Close()
	mustGet(t, v, "k", "v2")
}

// A transaction sees its own staged writes before commit.
func TestReadYourWrites(t *testing.T) {
	s := mustOpen(t, NewMemBackend(), 32)
	tx := s.Begin()
	put(t, tx, "a", "staged")
	got, ok, err := tx.Get("a")
	if err != nil || !ok || string(got) != "staged" {
		t.Fatalf("Get = %q,%v,%v", got, ok, err)
	}
	if err := tx.Delete("a"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := tx.Get("a"); ok {
		t.Fatal("deleted key still visible in txn")
	}
	tx.Abort()
}
