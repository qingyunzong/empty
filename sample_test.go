package dataeng_test

import (
	"errors"
	"math/big"
	"slices"
	"testing"

	dataeng "example.org/dataeng/q0109"
)

func item(id string, weight, priority uint64) dataeng.Item {
	return dataeng.Item{ID: id, Weight: weight, Priority: priority}
}

// oracleTopK recomputes the expected sample using big.Rat exact rationals.
func oracleTopK(items []dataeng.Item, k int) []dataeng.Item {
	unique := make(map[string]dataeng.Item, len(items))
	for _, it := range items {
		unique[it.ID] = it
	}
	all := make([]dataeng.Item, 0, len(unique))
	for _, it := range unique {
		all = append(all, it)
	}
	slices.SortFunc(all, func(a, b dataeng.Item) int {
		ra := new(big.Rat).SetFrac(new(big.Int).SetUint64(a.Priority), new(big.Int).SetUint64(a.Weight))
		rb := new(big.Rat).SetFrac(new(big.Int).SetUint64(b.Priority), new(big.Int).SetUint64(b.Weight))
		if c := ra.Cmp(rb); c != 0 {
			return c
		}
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	if k < len(all) {
		all = all[:k]
	}
	return all
}

func TestRetainsSmallestKWithExactRationals(t *testing.T) {
	// Values chosen so that float division and 64-bit multiplication would
	// misorder: the cross products exceed 2^64.
	items := []dataeng.Item{
		item("c", 1<<63, 3),      // 3/2^63
		item("a", (1<<63)+17, 3), // slightly smaller ratio than c
		item("b", 2, 1<<63),      // huge ratio
		item("d", 1<<63, 1<<63),  // ratio 1
		item("e", 1<<62, (1<<62)+1),
	}
	s := dataeng.NewSampler(3)
	for _, it := range items {
		if err := s.Add(it); err != nil {
			t.Fatalf("Add(%v): %v", it, err)
		}
	}
	got := s.Items()
	want := oracleTopK(items, 3)
	if !slices.Equal(got, want) {
		t.Fatalf("sample mismatch\ngot  %v\nwant %v", got, want)
	}
	if got[0].ID != "a" || got[1].ID != "c" || got[2].ID != "d" {
		t.Fatalf("unexpected order: %v", got)
	}
}

func TestTieBreaksByIDByteOrder(t *testing.T) {
	items := []dataeng.Item{
		item("zzz", 2, 1),
		item("aaa", 4, 2), // same ratio 1/2
		item("mmm", 6, 3), // same ratio 1/2
	}
	s := dataeng.NewSampler(3)
	for _, it := range items {
		if err := s.Add(it); err != nil {
			t.Fatal(err)
		}
	}
	got := s.Items()
	wantIDs := []string{"aaa", "mmm", "zzz"}
	for i, want := range wantIDs {
		if got[i].ID != want {
			t.Fatalf("position %d: got %s want %s (full %v)", i, got[i].ID, want, got)
		}
	}
}

func TestDuplicateIgnoredAndConflictRejected(t *testing.T) {
	s := dataeng.NewSampler(2)
	first := item("x", 5, 1)
	if err := s.Add(first); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := s.Add(item("x", 5, 1)); err != nil {
			t.Fatalf("identical re-add: %v", err)
		}
	}
	if s.Len() != 1 {
		t.Fatalf("Len = %d, want 1", s.Len())
	}

	bad := item("x", 5, 2)
	err := s.Add(bad)
	var conflict *dataeng.ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("want ConflictError, got %v", err)
	}
	if conflict.Existing != first || conflict.Incoming != bad || conflict.ID != "x" {
		t.Fatalf("unexpected conflict payload: %+v", conflict)
	}
	if s.Len() != 1 {
		t.Fatalf("Len after conflict = %d, want 1", s.Len())
	}
	if got := s.Items(); len(got) != 1 || got[0] != first {
		t.Fatalf("state mutated after conflict: %v", got)
	}

	if err := s.Add(item("z", 0, 1)); !errors.Is(err, dataeng.ErrZeroWeight) {
		t.Fatalf("want ErrZeroWeight, got %v", err)
	}
}

func TestKZeroIndexesButNeverSamples(t *testing.T) {
	s := dataeng.NewSampler(0)
	for i := uint64(1); i <= 10; i++ {
		if err := s.Add(item(string(rune('a'+i-1)), i, i)); err != nil {
			t.Fatal(err)
		}
	}
	if s.Len() != 10 {
		t.Fatalf("Len = %d, want 10", s.Len())
	}
	if got := s.Items(); len(got) != 0 {
		t.Fatalf("K=0 sample = %v, want empty", got)
	}
	if got := s.Snapshot().Sample(); len(got) != 0 {
		t.Fatalf("K=0 summary sample = %v, want empty", got)
	}
}

func TestNegativeKPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("NewSampler(-1) should panic")
		}
	}()
	_ = dataeng.NewSampler(-1)
}

func TestAccessorsAndErrorMessages(t *testing.T) {
	s := dataeng.NewSampler(4)
	if s.K() != 4 {
		t.Fatalf("K = %d, want 4", s.K())
	}
	err := s.Add(item("id-1", 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	conflictErr := s.Add(item("id-1", 1, 2))
	if conflictErr == nil || conflictErr.Error() == "" {
		t.Fatalf("conflict error message missing: %v", conflictErr)
	}
}

func TestConflictDetectedOutsideRetainedSample(t *testing.T) {
	s1 := dataeng.NewSampler(1)
	s2 := dataeng.NewSampler(1)
	mustAdd(t, s1, item("lo", 1, 1))
	mustAdd(t, s1, item("evicted", 1, 1000))
	mustAdd(t, s2, item("other", 1, 2))
	mustAdd(t, s2, item("evicted", 2, 1000)) // same ID, different content

	if got := s1.Items(); len(got) != 1 || got[0].ID != "lo" {
		t.Fatalf("evicted item should be outside sample, got %v", got)
	}
	_, err := dataeng.Merge(s1.Snapshot(), s2.Snapshot())
	var mergeErr *dataeng.MergeError
	if !errors.As(err, &mergeErr) {
		t.Fatalf("want MergeError, got %v", err)
	}
	if ids := mergeErr.IDs(); len(ids) != 1 || ids[0] != "evicted" {
		t.Fatalf("conflict ids = %v, want [evicted]", ids)
	}
}

func TestMergeRejectsMismatchedK(t *testing.T) {
	_, err := dataeng.Merge(
		dataeng.NewSampler(2).Snapshot(),
		dataeng.NewSampler(3).Snapshot(),
	)
	if err == nil {
		t.Fatal("want error for mismatched K")
	}
}

func TestMergeEmptyAndNil(t *testing.T) {
	m, err := dataeng.Merge(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.K() != 0 || m.Len() != 0 || len(m.Sample()) != 0 {
		t.Fatalf("empty merge unexpected: %+v", m)
	}
}

func TestSnapshotIsolationAndResume(t *testing.T) {
	s := dataeng.NewSampler(2)
	mustAdd(t, s, item("a", 1, 9))
	snap := s.Snapshot()
	mustAdd(t, s, item("b", 1, 1))
	if snap.Len() != 1 {
		t.Fatalf("snapshot mutated by later Add: Len=%d", snap.Len())
	}
	resumed := snap.Sampler()
	mustAdd(t, resumed, item("b", 1, 1))
	if !slices.Equal(resumed.Items(), s.Items()) {
		t.Fatalf("resumed sample %v != %v", resumed.Items(), s.Items())
	}
}

func mustAdd(t *testing.T, s *dataeng.Sampler, it dataeng.Item) {
	t.Helper()
	if err := s.Add(it); err != nil {
		t.Fatalf("Add(%v): %v", it, err)
	}
}
