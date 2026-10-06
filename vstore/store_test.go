package vstore

import (
	"errors"
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

func mustRegister(t *testing.T, s *Store, snap uint64) *Reader {
	t.Helper()
	r, err := s.RegisterReader(snap)
	if err != nil {
		t.Fatalf("RegisterReader(%d): %v", snap, err)
	}
	return r
}

func mustGet(t *testing.T, r *Reader, key, want string) {
	t.Helper()
	got, ok, err := r.Get(key)
	if err != nil {
		t.Fatalf("Get(%q) error: %v", key, err)
	}
	if !ok || string(got) != want {
		t.Fatalf("Get(%q) = %q, %v; want %q, true", key, got, ok, want)
	}
}

func mustMiss(t *testing.T, r *Reader, key string) {
	t.Helper()
	got, ok, err := r.Get(key)
	if err != nil {
		t.Fatalf("Get(%q) error: %v", key, err)
	}
	if ok {
		t.Fatalf("Get(%q) = %q, true; want miss", key, got)
	}
}

func TestSnapshotReadsLatestNotGreaterThanSeq(t *testing.T) {
	s := NewStore()
	for _, rec := range []struct {
		seq uint64
		val string
	}{{1, "a"}, {3, "b"}, {7, "c"}, {9, "d"}} {
		if err := s.Put("k", rec.seq, []byte(rec.val)); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		snap uint64
		want string
		ok   bool
	}{
		{0, "", false}, {1, "a", true}, {2, "a", true}, {3, "b", true},
		{6, "b", true}, {7, "c", true}, {8, "c", true}, {9, "d", true}, {100, "d", true},
	}
	for _, c := range cases {
		r := mustRegister(t, s, c.snap)
		got, ok, err := r.Get("k")
		if err != nil {
			t.Fatal(err)
		}
		if ok != c.ok || (ok && string(got) != c.want) {
			t.Errorf("snap %d: got %q,%v want %q,%v", c.snap, got, ok, c.want, c.ok)
		}
		r.Release()
	}
}

func TestTombstoneHidesOlderValues(t *testing.T) {
	s := NewStore()
	s.Put("k", 1, []byte("v1"))
	s.Delete("k", 2)
	s.Put("k", 3, []byte("v3"))

	r1 := mustRegister(t, s, 1)
	r2 := mustRegister(t, s, 2)
	r3 := mustRegister(t, s, 3)
	mustGet(t, r1, "k", "v1")
	mustMiss(t, r2, "k")
	mustGet(t, r3, "k", "v3")
}

func TestSameSeqDifferentContentRejected(t *testing.T) {
	s := NewStore()
	if err := s.Put("k", 5, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("k", 5, []byte("y")); !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	if err := s.Delete("k", 5); !errors.Is(err, ErrConflict) {
		t.Fatalf("value vs tombstone: want ErrConflict, got %v", err)
	}
	// Identical re-commit is an idempotent no-op.
	if err := s.Put("k", 5, []byte("x")); err != nil {
		t.Fatalf("identical re-commit: %v", err)
	}
	s.Delete("d", 9)
	if err := s.Delete("d", 9); err != nil {
		t.Fatalf("identical tombstone re-commit: %v", err)
	}
	if err := s.Put("d", 9, []byte("z")); !errors.Is(err, ErrConflict) {
		t.Fatalf("tombstone vs value: want ErrConflict, got %v", err)
	}
}

func TestCompactionPreservesRegisteredReaders(t *testing.T) {
	s := NewStore()
	s.Put("k", 1, []byte("v1"))
	s.Put("k", 2, []byte("v2"))
	s.Put("k", 3, []byte("v3"))
	s.Put("k", 4, []byte("v4"))

	old := mustRegister(t, s, 2) // sees v2
	mid := mustRegister(t, s, 3) // sees v3
	s.Compact()

	// Oldest live snapshot is 2: records >2 plus newest <=2 survive.
	if got := s.Len("k"); got != 3 {
		t.Fatalf("after compact: Len = %d, want 3", got)
	}
	mustGet(t, old, "k", "v2")
	mustGet(t, mid, "k", "v3")

	old.Release()
	mid.Release()
	s.Compact()
	if got := s.Len("k"); got != 1 {
		t.Fatalf("after full release: Len = %d, want 1", got)
	}
	mustGet(t, mustRegister(t, s, 100), "k", "v4")
}

func TestCompactionHorizonRejectsOldSnapshots(t *testing.T) {
	s := NewStore()
	s.Put("k", 1, []byte("v1"))
	s.Put("k", 2, []byte("v2"))
	s.Compact() // no readers: horizon advances to newest committed seq
	if got := s.MinSnapshot(); got != 2 {
		t.Fatalf("MinSnapshot = %d, want 2", got)
	}
	if _, err := s.RegisterReader(1); !errors.Is(err, ErrSnapshotTooOld) {
		t.Fatalf("want ErrSnapshotTooOld, got %v", err)
	}
	mustGet(t, mustRegister(t, s, 2), "k", "v2")
}

func TestCompactionDropsDeadTombstones(t *testing.T) {
	s := NewStore()
	s.Put("gone", 1, []byte("x"))
	s.Delete("gone", 2)
	s.Put("kept", 1, []byte("y"))
	s.Compact() // no readers: only newest record per key survives
	if got := s.Len("gone"); got != 0 {
		t.Fatalf("dead tombstone key retained: Len = %d, want 0", got)
	}
	if got := s.Len("kept"); got != 1 {
		t.Fatalf("Len(kept) = %d, want 1", got)
	}
	mustMiss(t, mustRegister(t, s, 100), "gone")
}

func TestReaderGenerationExpiry(t *testing.T) {
	s := NewStore()
	s.Put("k", 1, []byte("v1"))
	s.Put("k", 2, []byte("v2"))

	stale := mustRegister(t, s, 1)
	s.AdvanceGeneration()
	if _, _, err := stale.Get("k"); !errors.Is(err, ErrReaderClosed) {
		t.Fatalf("stale reader: want ErrReaderClosed, got %v", err)
	}

	fresh := mustRegister(t, s, 2)
	s.Compact() // stale reader must not pin records
	if got := s.Len("k"); got != 1 {
		t.Fatalf("Len = %d, want 1 (only newest kept)", got)
	}
	mustGet(t, fresh, "k", "v2")

	stale.Release() // releasing an expired reader is harmless
	if _, _, err := stale.Get("k"); !errors.Is(err, ErrReaderClosed) {
		t.Fatalf("released stale reader: want ErrReaderClosed, got %v", err)
	}
}

// model is a full-history reference implementation used to verify the store.
type model struct {
	hist map[string][]Record // complete, uncompacted history
}

func newModel() *model { return &model{hist: make(map[string][]Record)} }

func (m *model) apply(key string, rec Record) {
	hist := m.hist[key]
	i := sort.Search(len(hist), func(i int) bool { return hist[i].Seq >= rec.Seq })
	if i < len(hist) && hist[i].Seq == rec.Seq {
		return // identical re-commit only; conflicts are never generated
	}
	hist = append(hist, Record{})
	copy(hist[i+1:], hist[i:])
	hist[i] = rec
	m.hist[key] = hist
}

func (m *model) get(key string, snap uint64) (string, bool) {
	rec, ok := getAt(m.hist[key], snap)
	if !ok || rec.Tombstone {
		return "", false
	}
	return string(rec.Value), true
}

// TestRandomizedAgainstFullHistory commits random values and tombstones,
// interleaves reader registration, release, generation advancement and
// compaction, and verifies every live reader against a full-history
// reference model.
func TestRandomizedAgainstFullHistory(t *testing.T) {
	for seed := int64(0); seed < 20; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			s := NewStore()
			m := newModel()
			keys := []string{"a", "b", "c", "d"}
			var readers []*Reader
			var seq uint64

			checkAll := func() {
				t.Helper()
				for _, r := range readers {
					for _, k := range keys {
						got, ok, err := r.Get(k)
						if err != nil {
							t.Fatalf("reader@%d Get(%q): %v", r.Snapshot(), k, err)
						}
						want, wantOK := m.get(k, r.Snapshot())
						if ok != wantOK || (ok && string(got) != want) {
							t.Fatalf("reader@%d Get(%q) = %q,%v; model wants %q,%v",
								r.Snapshot(), k, got, ok, want, wantOK)
						}
					}
				}
			}

			for step := 0; step < 400; step++ {
				switch rng.Intn(6) {
				case 0, 1, 2: // commit a value or tombstone at a fresh seq
					seq++
					key := keys[rng.Intn(len(keys))]
					if rng.Intn(4) == 0 {
						if err := s.Delete(key, seq); err != nil {
							t.Fatal(err)
						}
						m.apply(key, Record{Seq: seq, Tombstone: true})
					} else {
						val := fmt.Sprintf("v%d", seq)
						if err := s.Put(key, seq, []byte(val)); err != nil {
							t.Fatal(err)
						}
						m.apply(key, Record{Seq: seq, Value: []byte(val)})
					}
				case 3: // register a reader at a random snapshot >= horizon
					horizon := s.MinSnapshot()
					snap := horizon
					if seq > horizon {
						snap += rng.Uint64() % (seq - horizon + 1)
					}
					r, err := s.RegisterReader(snap)
					if err != nil {
						t.Fatal(err)
					}
					readers = append(readers, r)
				case 4: // release a random live reader
					if len(readers) > 0 {
						i := rng.Intn(len(readers))
						readers[i].Release()
						readers = append(readers[:i], readers[i+1:]...)
					}
				case 5: // expire the generation, then compact
					for _, r := range readers {
						r.Release()
					}
					readers = readers[:0]
					s.AdvanceGeneration()
					s.Compact()
				}
				if step%17 == 0 {
					s.Compact() // compact with a mix of live readers
				}
				checkAll()
			}
		})
	}
}
