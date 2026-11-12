package dataeng_test

import (
	"errors"
	"slices"
	"testing"

	dataeng "example.org/dataeng/q0109"
)

func TestMergeIdenticalContentAcrossShards(t *testing.T) {
	shared := item("shared", 7, 3)
	s1 := dataeng.NewSampler(2)
	s2 := dataeng.NewSampler(2)
	mustAdd(t, s1, shared)
	mustAdd(t, s1, item("only-1", 1, 5))
	mustAdd(t, s2, shared) // same ID, identical content
	mustAdd(t, s2, item("only-2", 1, 2))

	merged, err := dataeng.Merge(s1.Snapshot(), s2.Snapshot())
	if err != nil {
		t.Fatalf("identical cross-shard content must not conflict: %v", err)
	}
	if merged.Len() != 3 {
		t.Fatalf("merged Len = %d, want 3", merged.Len())
	}
	got, ok := merged.Item("shared")
	if !ok || got != shared {
		t.Fatalf("Item lookup = %v %v, want %v", got, ok, shared)
	}
	if _, ok := merged.Item("missing"); ok {
		t.Fatal("missing ID should report ok=false")
	}

	// Merged summary can resume collection and stay equivalent to a full run.
	full := dataeng.NewSampler(2)
	mustAdd(t, full, shared)
	mustAdd(t, full, item("only-1", 1, 5))
	mustAdd(t, full, item("only-2", 1, 2))
	if !slices.Equal(merged.Sample(), full.Items()) {
		t.Fatalf("merged sample %v != full %v", merged.Sample(), full.Items())
	}
	if !slices.Equal(merged.Sampler().Items(), full.Items()) {
		t.Fatal("resumed merged sampler disagrees with full sampler")
	}
}

func TestMergeErrorPayloadDeterministic(t *testing.T) {
	versions := []dataeng.Item{
		item("dup", 9, 4),
		item("dup", 1, 7),
		item("dup", 1, 2),
	}
	snaps := make([]*dataeng.Summary, len(versions))
	for i, v := range versions {
		s := dataeng.NewSampler(0) // conflict ID never enters any sample
		mustAdd(t, s, v)
		snaps[i] = s.Snapshot()
	}
	_, err := dataeng.Merge(snaps...)
	var mergeErr *dataeng.MergeError
	if !errors.As(err, &mergeErr) {
		t.Fatalf("want MergeError, got %v", err)
	}
	got := mergeErr.Conflicts["dup"]
	// Distinct versions sorted by Weight then Priority.
	want := []dataeng.Item{
		item("dup", 1, 2),
		item("dup", 1, 7),
		item("dup", 9, 4),
	}
	if !slices.Equal(got, want) {
		t.Fatalf("conflict payload = %v, want %v", got, want)
	}
	if ids := mergeErr.IDs(); len(ids) != 1 || ids[0] != "dup" {
		t.Fatalf("IDs = %v", ids)
	}
	if mergeErr.Error() == "" {
		t.Fatal("Error() must not be empty")
	}
}

func TestMergeSnapshotCopyIsIndependent(t *testing.T) {
	s := dataeng.NewSampler(1)
	mustAdd(t, s, item("a", 1, 1))
	snap := s.Snapshot()
	copySnap := snap.Snapshot()
	mustAdd(t, s, item("b", 1, 2))
	if copySnap.Len() != 1 {
		t.Fatalf("copied summary changed: Len=%d", copySnap.Len())
	}
}

func TestMultiIDConflictAndKErrorMessage(t *testing.T) {
	s1 := dataeng.NewSampler(1)
	s2 := dataeng.NewSampler(1)
	mustAdd(t, s1, item("alpha", 1, 1))
	mustAdd(t, s1, item("beta", 1, 1))
	mustAdd(t, s2, item("alpha", 2, 1))
	mustAdd(t, s2, item("beta", 2, 1))

	_, err := dataeng.Merge(s1.Snapshot(), s2.Snapshot())
	var mergeErr *dataeng.MergeError
	if !errors.As(err, &mergeErr) {
		t.Fatalf("want MergeError, got %v", err)
	}
	if ids := mergeErr.IDs(); !slices.Equal(ids, []string{"alpha", "beta"}) {
		t.Fatalf("IDs = %v, want sorted [alpha beta]", ids)
	}
	if mergeErr.Error() == "" {
		t.Fatal("merge error message missing")
	}

	_, err = dataeng.Merge(
		dataeng.NewSampler(1).Snapshot(),
		dataeng.NewSampler(2).Snapshot(),
	)
	if err == nil || err.Error() == "" {
		t.Fatalf("want descriptive K mismatch error, got %v", err)
	}
}
