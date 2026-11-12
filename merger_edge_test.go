package dataeng

import (
	"context"
	"errors"
	"testing"
)

// TestDuplicateOnlyTailCompletesWithoutEmptyBatch covers a merge where the
// final sources contain only records already delivered by an earlier source.
// The merger must reach completion without emitting an empty non-terminal
// batch.
func TestDuplicateOnlyTailCompletesWithoutEmptyBatch(t *testing.T) {
	base := []Record{
		rec(1, "a", "A"), rec(2, "b", "B"), rec(3, "c", "C"),
		rec(4, "d", "D"), rec(5, "e", "E"),
	}
	// The second source starts with a record already present in base and
	// adds nothing new globally.
	duplicates := []Record{rec(2, "b", "B"), rec(4, "d", "D")}
	fakes := []*fakeSource{
		buildSource("primary", base, 2),
		buildSource("mirror", duplicates, 1),
	}
	want := referenceMerge(base, duplicates)

	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 2, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	batches := drainMerger(t, merger)
	assertRecordsEqual(t, flatten(batches), want)

	final := tx.Current()
	if final == nil || !final.Complete {
		t.Fatal("completion marker must be durable")
	}
	if _, err := merger.Next(context.Background()); !errors.Is(err, ErrComplete) {
		t.Fatalf("Next after completion = %v, want ErrComplete", err)
	}

	// Every confirmed non-terminal batch had at least one record.
	for i, batch := range tx.Delivered() {
		if len(batch) == 0 {
			t.Fatalf("confirmed batch %d is empty", i)
		}
	}
}

// TestResumeSkipsAlreadyDeliveredDuplicates verifies that a merger rebuilt
// from a checkpoint skips records at or below LastDelivered instead of
// redelivering them.
func TestResumeSkipsAlreadyDeliveredDuplicates(t *testing.T) {
	groupA := []Record{rec(1, "a", "A"), rec(3, "c", "C"), rec(5, "e", "E")}
	groupB := []Record{rec(2, "b", "B"), rec(3, "c", "C"), rec(6, "f", "F")}
	want := referenceMerge(groupA, groupB)

	fakes := []*fakeSource{
		buildSource("A", groupA, 1),
		buildSource("B", groupB, 1),
	}
	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 2, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	first, err := merger.Next(context.Background())
	if err != nil {
		t.Fatalf("first Next: %v", err)
	}

	// Simulate a crash and resume from the durable checkpoint with fresh
	// source instances.
	resumedFakes := []*fakeSource{
		buildSource("A", groupA, 1),
		buildSource("B", groupB, 1),
	}
	resumed, err := ResumeMerger(asInterfaces(resumedFakes), tx.Current(), 2, tx)
	if err != nil {
		t.Fatalf("ResumeMerger: %v", err)
	}
	got := append(append([]Record{}, first...), flatten(drainMerger(t, resumed))...)
	assertRecordsEqual(t, got, want)
	assertStrictlyOrderedUnique(t, flatten(tx.Delivered()))
}

// TestHeapRefillAcrossPageBoundary forces the internal refill path where the
// heap is drained by duplicate records while a source still has unread pages.
func TestHeapRefillAcrossPageBoundary(t *testing.T) {
	// Primary delivers ids a..f across small pages. Mirror contains only
	// duplicates of the earliest ids on a single page, so after popping them
	// the heap must be refilled from the primary's later pages.
	primary := []Record{
		rec(1, "a", "A"), rec(2, "b", "B"), rec(3, "c", "C"),
		rec(4, "d", "D"), rec(5, "e", "E"), rec(6, "f", "F"),
	}
	mirror := []Record{rec(1, "a", "A"), rec(2, "b", "B")}
	fakes := []*fakeSource{
		buildSource("primary", primary, 1),
		buildSource("mirror", mirror, 5),
	}
	want := referenceMerge(primary, mirror)

	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 1, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	got := flatten(drainMerger(t, merger))
	assertRecordsEqual(t, got, want)
	assertStrictlyOrderedUnique(t, got)

	final := tx.Current()
	if final == nil || !final.Complete {
		t.Fatal("completion marker must be durable")
	}
}

func TestResumeMergerValidation(t *testing.T) {
	group := []Record{rec(1, "a", "A")}
	fakes := []*fakeSource{buildSource("A", group, 1)}
	tx := NewMemoryTransaction()

	if _, err := ResumeMerger(asInterfaces(fakes), nil, 1, tx); err == nil {
		t.Fatal("expected error for nil checkpoint")
	}

	good := &Checkpoint{Sources: map[string]SourceCheckpoint{
		"A": {Cursor: "A-c0"},
	}}
	other := &Checkpoint{Sources: map[string]SourceCheckpoint{
		"B": {Cursor: "B-c0"},
	}}
	if _, err := ResumeMerger(asInterfaces(fakes), other, 1, tx); err == nil {
		t.Fatal("expected error for mismatched source name")
	}

	extra := &Checkpoint{Sources: map[string]SourceCheckpoint{
		"A": {Cursor: "A-c0"},
		"B": {Cursor: "B-c0"},
	}}
	if _, err := ResumeMerger(asInterfaces(fakes), extra, 1, tx); err == nil {
		t.Fatal("expected error for extra checkpoint source")
	}

	if _, err := ResumeMerger(asInterfaces(fakes), good, 1, tx); err != nil {
		t.Fatalf("valid resume: %v", err)
	}
}

// TestRefillHeapsDirectly exercises the internal refill helper by emptying
// the heap while a source still holds an unread page.
func TestRefillHeapsDirectly(t *testing.T) {
	groupA := []Record{rec(1, "a", "A"), rec(2, "b", "B"), rec(3, "c", "C")}
	groupB := []Record{rec(4, "d", "D")}
	fakes := []*fakeSource{
		buildSource("A", groupA, 1),
		buildSource("B", groupB, 1),
	}
	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 1, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	ctx := context.Background()
	if err := merger.ensureRuntime(ctx); err != nil {
		t.Fatalf("ensureRuntime: %v", err)
	}

	// Consume every head currently in the heap without refilling, then ask
	// refillHeaps to repopulate it from later pages.
	merger.heads = nil
	if merger.allExhausted() {
		t.Fatal("sources must not be exhausted at this point")
	}
	if err := merger.refillHeaps(ctx); err != nil {
		t.Fatalf("refillHeaps: %v", err)
	}
	if merger.heads.Len() != len(fakes) {
		t.Fatalf("heap size after refill = %d, want %d", merger.heads.Len(), len(fakes))
	}

	got := flatten(drainMerger(t, merger))
	want := referenceMerge(groupA, groupB)
	assertRecordsEqual(t, got, want)
}
