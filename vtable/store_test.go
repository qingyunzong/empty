package vtable

import (
	"errors"
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

func mustPut(t *testing.T, s *Store, key string, seq uint64, val string) {
	t.Helper()
	if err := s.Put(key, seq, []byte(val)); err != nil {
		t.Fatalf("Put(%q, %d): %v", key, seq, err)
	}
}

func mustGet(t *testing.T, s *Store, key string, seq uint64, want string, wantOK bool) {
	t.Helper()
	got, ok := s.Get(key, seq)
	if ok != wantOK || (wantOK && string(got) != want) {
		t.Fatalf("Get(%q, %d) = %q, %v; want %q, %v", key, seq, got, ok, want, wantOK)
	}
}

func TestSnapshotReadsLatestAtOrBelowSeq(t *testing.T) {
	s := New()
	mustPut(t, s, "a", 10, "v10")
	mustPut(t, s, "a", 20, "v20")
	mustPut(t, s, "a", 30, "v30")

	mustGet(t, s, "a", 5, "", false) // before any commit
	mustGet(t, s, "a", 10, "v10", true)
	mustGet(t, s, "a", 15, "v10", true) // between commits
	mustGet(t, s, "a", 20, "v20", true)
	mustGet(t, s, "a", 99, "v30", true) // after last commit
	mustGet(t, s, "missing", 99, "", false)
}

func TestOutOfOrderCommits(t *testing.T) {
	s := New()
	mustPut(t, s, "k", 30, "v30")
	mustPut(t, s, "k", 10, "v10")
	mustPut(t, s, "k", 20, "v20")
	mustGet(t, s, "k", 25, "v20", true)
	mustGet(t, s, "k", 10, "v10", true)
}

func TestTombstoneHidesOlderValues(t *testing.T) {
	s := New()
	mustPut(t, s, "a", 1, "alive")
	if err := s.Delete("a", 2); err != nil {
		t.Fatal(err)
	}
	mustGet(t, s, "a", 1, "alive", true)
	mustGet(t, s, "a", 2, "", false)
	mustGet(t, s, "a", 100, "", false)

	mustPut(t, s, "a", 3, "revived")
	mustGet(t, s, "a", 3, "revived", true)
}

func TestSameSeqDifferentContentRejected(t *testing.T) {
	s := New()
	mustPut(t, s, "a", 7, "x")

	// Identical re-commit is idempotent.
	if err := s.Put("a", 7, []byte("x")); err != nil {
		t.Fatalf("idempotent re-commit failed: %v", err)
	}
	// Different value at the same seq is rejected.
	err := s.Put("a", 7, []byte("y"))
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError, got %v", err)
	}
	if ce.Key != "a" || ce.Seq != 7 {
		t.Fatalf("unexpected conflict details: %+v", ce)
	}
	// Value vs tombstone at the same seq is also a conflict.
	if err := s.Delete("a", 7); !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError for value/tombstone clash, got %v", err)
	}
	// Failed commits leave the original intact.
	mustGet(t, s, "a", 7, "x", true)
	if n := s.NumRecords("a"); n != 1 {
		t.Fatalf("NumRecords = %d, want 1", n)
	}
}

func TestCompactionPreservesRegisteredReaders(t *testing.T) {
	s := New()
	mustPut(t, s, "k", 1, "v1")
	mustPut(t, s, "k", 2, "v2")
	mustPut(t, s, "k", 3, "v3")
	mustPut(t, s, "k", 4, "v4")

	gen := s.NewGeneration()
	r2, err := s.RegisterReader(gen, 2)
	if err != nil {
		t.Fatal(err)
	}
	r4, err := s.RegisterReader(gen, 4)
	if err != nil {
		t.Fatal(err)
	}

	s.Compact()
	// History at or below the oldest pin (seq 2) collapses to one record.
	if n := s.NumRecords("k"); n != 3 { // {v2, v3, v4}
		t.Fatalf("NumRecords after compact = %d, want 3", n)
	}
	// Both readers still observe exactly their pinned snapshots.
	if got, ok := r2.Get("k"); !ok || string(got) != "v2" {
		t.Fatalf("reader@2 got %q, %v; want v2", got, ok)
	}
	if got, ok := r4.Get("k"); !ok || string(got) != "v4" {
		t.Fatalf("reader@4 got %q, %v; want v4", got, ok)
	}
	mustGet(t, s, "k", 3, "v3", true)

	// Releasing the oldest reader lets the next compaction drop v2.
	r2.Release()
	s.Compact()
	if n := s.NumRecords("k"); n != 1 { // only v4 remains (pin at 4)
		t.Fatalf("NumRecords after second compact = %d, want 1", n)
	}
	mustGet(t, s, "k", 4, "v4", true)
	r4.Release()
}

func TestGenerationExpiryReleasesOldVersions(t *testing.T) {
	s := New()
	mustPut(t, s, "k", 1, "v1")
	mustPut(t, s, "k", 2, "v2")

	gen1 := s.NewGeneration()
	r1, err := s.RegisterReader(gen1, 1)
	if err != nil {
		t.Fatal(err)
	}
	r1.Release() // gen1 now empty -> expired
	if n := s.LiveGenerations(); n != 0 {
		t.Fatalf("LiveGenerations = %d, want 0", n)
	}

	// Registering in an expired generation fails.
	if _, err := s.RegisterReader(gen1, 1); !errors.Is(err, ErrUnknownGeneration) {
		t.Fatalf("expected ErrUnknownGeneration, got %v", err)
	}

	s.Compact()
	if n := s.NumRecords("k"); n != 1 {
		t.Fatalf("NumRecords = %d, want 1 (expired generation pins nothing)", n)
	}
	mustGet(t, s, "k", 2, "v2", true)
}

func TestCompactionDropsTombstonedHistory(t *testing.T) {
	s := New()
	mustPut(t, s, "k", 1, "v1")
	if err := s.Delete("k", 2); err != nil {
		t.Fatal(err)
	}
	s.Compact() // no readers: only the tombstone remains
	if n := s.NumRecords("k"); n != 1 {
		t.Fatalf("NumRecords = %d, want 1", n)
	}
	mustGet(t, s, "k", 100, "", false)
	// Same-seq conflict detection still works on the surviving tombstone.
	if err := s.Put("k", 2, []byte("ghost")); err == nil {
		t.Fatal("expected conflict against surviving tombstone")
	}
}

// reference is a full-history oracle: it never compacts.
type reference struct {
	recs map[string][]record // ascending by seq
}

func newReference() *reference { return &reference{recs: make(map[string][]record)} }

func (r *reference) apply(key string, rec record) {
	recs := r.recs[key]
	i := sort.Search(len(recs), func(i int) bool { return recs[i].seq >= rec.seq })
	if i < len(recs) && recs[i].seq == rec.seq {
		return // idempotent; conflicts are filtered before apply
	}
	recs = append(recs, record{})
	copy(recs[i+1:], recs[i:])
	recs[i] = rec
	r.recs[key] = recs
}

func (r *reference) get(key string, seq uint64) ([]byte, bool) {
	rec, ok := lookup(r.recs[key], seq)
	if !ok || rec.tombstone {
		return nil, false
	}
	return rec.value, true
}

// TestRandomizedAgainstFullHistory drives the store with random commits,
// deletes, reader registrations, releases and compactions, then verifies
// every live reader's snapshot and a sweep of post-watermark snapshots
// against the full-history reference.
func TestRandomizedAgainstFullHistory(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	s := New()
	ref := newReference()

	keys := []string{"alpha", "beta", "gamma", "delta"}
	var maxSeq uint64
	type liveReader struct {
		r   *Reader
		seq uint64
	}
	var readers []liveReader
	gens := []uint64{s.NewGeneration(), s.NewGeneration()}

	// watermark computes the oldest pinned seq among live readers.
	watermark := func() (uint64, bool) {
		if len(readers) == 0 {
			return 0, false
		}
		min := readers[0].seq
		for _, lr := range readers[1:] {
			if lr.seq < min {
				min = lr.seq
			}
		}
		return min, true
	}

	verify := func(step int) {
		t.Helper()
		// Every live reader must observe exactly the reference snapshot.
		for _, lr := range readers {
			for _, k := range keys {
				wantV, wantOK := ref.get(k, lr.seq)
				gotV, gotOK := lr.r.Get(k)
				if wantOK != gotOK || string(wantV) != string(gotV) {
					t.Fatalf("step %d: reader@%d Get(%q) = %q,%v; ref = %q,%v",
						step, lr.seq, k, gotV, gotOK, wantV, wantOK)
				}
			}
		}
		// Sweep snapshot seqs from the watermark up to maxSeq.
		start := uint64(0)
		if wm, ok := watermark(); ok {
			start = wm
		} else if maxSeq > 0 {
			start = maxSeq // no readers: only the latest state is guaranteed
		}
		for seq := start; seq <= maxSeq; seq++ {
			for _, k := range keys {
				wantV, wantOK := ref.get(k, seq)
				gotV, gotOK := s.Get(k, seq)
				if wantOK != gotOK || string(wantV) != string(gotV) {
					t.Fatalf("step %d: Get(%q, %d) = %q,%v; ref = %q,%v",
						step, k, seq, gotV, gotOK, wantV, wantOK)
				}
			}
		}
	}

	const steps = 4000
	for step := 0; step < steps; step++ {
		switch rng.Intn(10) {
		case 0, 1, 2, 3: // commit a new version
			maxSeq++
			key := keys[rng.Intn(len(keys))]
			rec := record{seq: maxSeq}
			if rng.Intn(4) == 0 {
				rec.tombstone = true
				if err := s.Delete(key, maxSeq); err != nil {
					t.Fatalf("step %d: Delete: %v", step, err)
				}
			} else {
				rec.value = []byte(fmt.Sprintf("val-%d", maxSeq))
				if err := s.Put(key, maxSeq, rec.value); err != nil {
					t.Fatalf("step %d: Put: %v", step, err)
				}
			}
			ref.apply(key, rec)

		case 4: // idempotent re-commit and conflicting re-commit
			if maxSeq == 0 {
				continue
			}
			key := keys[rng.Intn(len(keys))]
			seq := uint64(rng.Intn(int(maxSeq))) + 1
			wantV, wantOK := ref.get(key, seq)
			// Find whether seq is an exact commit point in the reference.
			var exact *record
			for i := range ref.recs[key] {
				if ref.recs[key][i].seq == seq {
					exact = &ref.recs[key][i]
					break
				}
			}
			if exact == nil {
				continue
			}
			if exact.tombstone {
				if err := s.Delete(key, seq); err != nil {
					t.Fatalf("step %d: idempotent Delete: %v", step, err)
				}
				if err := s.Put(key, seq, []byte("conflict")); err == nil {
					t.Fatalf("step %d: expected conflict (tombstone vs value)", step)
				}
			} else {
				if err := s.Put(key, seq, exact.value); err != nil {
					t.Fatalf("step %d: idempotent Put: %v", step, err)
				}
				if err := s.Delete(key, seq); err == nil {
					t.Fatalf("step %d: expected conflict (value vs tombstone)", step)
				}
				if err := s.Put(key, seq, []byte("conflict")); err == nil {
					t.Fatalf("step %d: expected conflict (different value)", step)
				}
			}
			_ = wantV
			_ = wantOK

		case 5, 6: // register a reader at a random historical snapshot
			if maxSeq == 0 {
				continue
			}
			gi := rng.Intn(len(gens))
			seq := uint64(rng.Intn(int(maxSeq))) + 1
			r, err := s.RegisterReader(gens[gi], seq)
			if errors.Is(err, ErrUnknownGeneration) {
				// The generation expired when its last reader released;
				// start a fresh cohort and retry.
				gens[gi] = s.NewGeneration()
				r, err = s.RegisterReader(gens[gi], seq)
			}
			if err != nil {
				t.Fatalf("step %d: RegisterReader: %v", step, err)
			}
			readers = append(readers, liveReader{r: r, seq: seq})

		case 7: // release a random reader
			if len(readers) == 0 {
				continue
			}
			i := rng.Intn(len(readers))
			readers[i].r.Release()
			readers = append(readers[:i], readers[i+1:]...)

		case 8: // compact, then verify against full history
			s.Compact()
			verify(step)

		case 9: // fresh generation cohort
			gens = append(gens, s.NewGeneration())
		}
	}

	// Drain all readers, compact, and verify the latest state survives.
	for _, lr := range readers {
		lr.r.Release()
	}
	readers = nil
	s.Compact()
	for _, k := range keys {
		wantV, wantOK := ref.get(k, maxSeq)
		gotV, gotOK := s.Get(k, maxSeq)
		if wantOK != gotOK || string(wantV) != string(gotV) {
			t.Fatalf("final: Get(%q, %d) = %q,%v; ref = %q,%v", k, maxSeq, gotV, gotOK, wantV, wantOK)
		}
	}
	if n := s.LiveGenerations(); n != 0 {
		t.Fatalf("final: LiveGenerations = %d, want 0", n)
	}
}
