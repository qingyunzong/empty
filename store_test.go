package pagestore

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

func checkConservation(t *testing.T, s *Store) Stats {
	t.Helper()
	st := s.Stats()
	if st.Free+st.Used != st.Capacity {
		t.Fatalf("capacity not conserved: free=%d used=%d capacity=%d",
			st.Free, st.Used, st.Capacity)
	}
	if st.Free < 0 || st.Used < 0 {
		t.Fatalf("negative quota: %+v", st)
	}
	return st
}

func mustGet(t *testing.T, r *Reader, key, want string) {
	t.Helper()
	got, ok := r.Get(key)
	if !ok {
		t.Fatalf("key %q missing at version %d", key, r.Version())
	}
	if string(got) != want {
		t.Fatalf("key %q = %q, want %q", key, got, want)
	}
}

func TestCapacityConservation(t *testing.T) {
	s := NewStore(NewMemBackend(), 8)
	checkConservation(t, s)

	// Fill the store with commits of varying size.
	for i := 0; i < 4; i++ {
		tx := s.Begin()
		tx.Put(fmt.Sprintf("k%d", i), []byte("v"))
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit %d: %v", i, err)
		}
		st := checkConservation(t, s)
		if st.Used != i+1 {
			t.Fatalf("after commit %d: used=%d, want %d", i, st.Used, i+1)
		}
	}

	// Overwrites consume a new page but recycle the old one once the
	// previous version is unpinned: net usage stays constant.
	for i := 0; i < 3; i++ {
		tx := s.Begin()
		tx.Put("k0", []byte(fmt.Sprintf("gen%d", i)))
		if err := tx.Commit(); err != nil {
			t.Fatalf("overwrite %d: %v", i, err)
		}
		st := checkConservation(t, s)
		if st.Used != 4 {
			t.Fatalf("after overwrite %d: used=%d, want 4", i, st.Used)
		}
	}

	// Deletes release pages back to the free pool.
	tx := s.Begin()
	tx.Delete("k1")
	tx.Delete("k2")
	if err := tx.Commit(); err != nil {
		t.Fatalf("delete: %v", err)
	}
	st := checkConservation(t, s)
	if st.Used != 2 || st.Free != 6 {
		t.Fatalf("after deletes: %+v, want used=2 free=6", st)
	}
}

func TestCommitRejectedWhenQuotaInsufficient(t *testing.T) {
	s := NewStore(NewMemBackend(), 4)

	tx1 := s.Begin()
	tx1.Put("a", []byte("1"))
	tx1.Put("b", []byte("2"))
	tx1.Put("c", []byte("3"))
	if err := tx1.Commit(); err != nil {
		t.Fatalf("tx1: %v", err)
	}
	if st := checkConservation(t, s); st.Free != 1 {
		t.Fatalf("free=%d, want 1", st.Free)
	}

	// Two new pages needed, one free: commit must be rejected.
	tx2 := s.Begin()
	tx2.Put("d", []byte("4"))
	tx2.Put("e", []byte("5"))
	if err := tx2.Commit(); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("commit err=%v, want ErrQuotaExceeded", err)
	}

	// Quota untouched, root untouched, old data still served.
	if st := checkConservation(t, s); st.Free != 1 || st.Used != 3 {
		t.Fatalf("after rejection: %+v, want free=1 used=3", st)
	}
	r := s.Acquire()
	mustGet(t, r, "a", "1")
	if _, ok := r.Get("d"); ok {
		t.Fatal("rejected commit leaked key d into the root")
	}
	r.Close()

	// The draft survives rejection: keep editing, still rejected.
	tx2.Put("f", []byte("6"))
	if err := tx2.Commit(); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("commit err=%v, want ErrQuotaExceeded", err)
	}

	// Free quota by deleting keys in another transaction; superseded
	// pages recycle immediately because no reader pins version 1.
	tx3 := s.Begin()
	tx3.Delete("a")
	tx3.Delete("b")
	if err := tx3.Commit(); err != nil {
		t.Fatalf("tx3: %v", err)
	}
	if st := checkConservation(t, s); st.Free != 3 {
		t.Fatalf("free=%d, want 3", st.Free)
	}

	// The preserved draft now commits in full.
	if err := tx2.Commit(); err != nil {
		t.Fatalf("retry: %v", err)
	}
	checkConservation(t, s)
	r = s.Acquire()
	defer r.Close()
	mustGet(t, r, "c", "3")
	mustGet(t, r, "d", "4")
	mustGet(t, r, "e", "5")
	mustGet(t, r, "f", "6")
	if _, ok := r.Get("a"); ok {
		t.Fatal("deleted key a still visible")
	}
}

func TestOldReadersKeepOldPages(t *testing.T) {
	s := NewStore(NewMemBackend(), 3)

	tx1 := s.Begin()
	tx1.Put("x", []byte("v1"))
	tx1.Put("y", []byte("v1"))
	if err := tx1.Commit(); err != nil {
		t.Fatalf("tx1: %v", err)
	}

	old := s.Acquire() // pins version 1
	if st := checkConservation(t, s); st.Versions != 1 {
		t.Fatalf("versions=%d, want 1 (root and pin coincide)", st.Versions)
	}

	// Overwrite x: the new page consumes the last free slot, and the
	// old x page cannot be recycled while the old reader holds it.
	tx2 := s.Begin()
	tx2.Put("x", []byte("v2"))
	if err := tx2.Commit(); err != nil {
		t.Fatalf("tx2: %v", err)
	}
	st := checkConservation(t, s)
	if st.Free != 0 || st.Used != 3 || st.Versions != 2 {
		t.Fatalf("while pinned: %+v, want free=0 used=3 versions=2", st)
	}

	// Old reader sees old data; new reader sees new data.
	mustGet(t, old, "x", "v1")
	mustGet(t, old, "y", "v1")
	cur := s.Acquire()
	mustGet(t, cur, "x", "v2")
	cur.Close()

	// Releasing the old reader recycles the superseded x page.
	old.Close()
	st = checkConservation(t, s)
	if st.Free != 1 || st.Used != 2 || st.Versions != 1 {
		t.Fatalf("after release: %+v, want free=1 used=2 versions=1", st)
	}
}

func TestFailingWriteAdapter(t *testing.T) {
	t.Run("page write failure", func(t *testing.T) {
		mem := NewMemBackend()
		fb := &FailBackend{Inner: mem, FailWritePages: 1}
		s := NewStore(fb, 2)

		tx := s.Begin()
		tx.Put("k", []byte("v"))
		if err := tx.Commit(); !errors.Is(err, ErrInjected) {
			t.Fatalf("commit err=%v, want ErrInjected", err)
		}

		// Nothing published, quota fully rolled back, root still empty.
		if st := checkConservation(t, s); st.Free != 2 || st.Used != 0 {
			t.Fatalf("after failure: %+v, want free=2 used=0", st)
		}
		r := s.Acquire()
		if _, ok := r.Get("k"); ok {
			t.Fatal("failed commit leaked key k")
		}
		r.Close()

		// Draft intact: retry against the now-healthy backend succeeds.
		if err := tx.Commit(); err != nil {
			t.Fatalf("retry: %v", err)
		}
		r = s.Acquire()
		defer r.Close()
		mustGet(t, r, "k", "v")
	})

	t.Run("root write failure", func(t *testing.T) {
		mem := NewMemBackend()
		fb := &FailBackend{Inner: mem, FailWriteRoot: 1}
		s := NewStore(fb, 2)

		tx := s.Begin()
		tx.Put("k", []byte("v"))
		if err := tx.Commit(); !errors.Is(err, ErrInjected) {
			t.Fatalf("commit err=%v, want ErrInjected", err)
		}

		// The root pointer never advanced, in memory or durably.
		if len(mem.Roots) != 0 {
			t.Fatalf("durable roots=%v, want none", mem.Roots)
		}
		if st := checkConservation(t, s); st.Free != 2 || st.Used != 0 {
			t.Fatalf("after failure: %+v, want free=2 used=0", st)
		}

		if err := tx.Commit(); err != nil {
			t.Fatalf("retry: %v", err)
		}
		if len(mem.Roots) != 1 || mem.Roots[0] != 1 {
			t.Fatalf("durable roots=%v, want [1]", mem.Roots)
		}
		checkConservation(t, s)
	})
}

func TestAtomicRootSwitchConcurrent(t *testing.T) {
	// Each commit writes k1 and k2 with the same payload; any reader
	// observing a root must see both keys from the same generation.
	// Torn root switches would surface as mismatched values.
	s := NewStore(NewMemBackend(), 64)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				r := s.Acquire()
				v1, ok1 := r.Get("k1")
				v2, ok2 := r.Get("k2")
				if ok1 != ok2 {
					t.Errorf("torn root: k1 present=%v k2 present=%v", ok1, ok2)
				} else if ok1 && string(v1) != string(v2) {
					t.Errorf("torn root: k1=%q k2=%q", v1, v2)
				}
				r.Close()
			}
		}()
	}

	for gen := 0; gen < 200; gen++ {
		tx := s.Begin()
		val := []byte(fmt.Sprintf("gen-%d", gen))
		tx.Put("k1", val)
		tx.Put("k2", val)
		for {
			err := tx.Commit()
			if errors.Is(err, ErrQuotaExceeded) {
				continue // readers are holding pages; retry
			}
			if err != nil {
				t.Fatalf("commit gen %d: %v", gen, err)
			}
			break
		}
		checkConservation(t, s)
	}
	close(stop)
	wg.Wait()

	r := s.Acquire()
	defer r.Close()
	mustGet(t, r, "k1", "gen-199")
	mustGet(t, r, "k2", "gen-199")
}
