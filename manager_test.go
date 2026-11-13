package dataeng

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

func file(partition, path string, size int64) DataFile {
	return DataFile{Path: path, Partition: Partition(partition), SizeInBytes: size, RecordCount: 1}
}

func mustAppend(t *testing.T, m *Manager, files ...DataFile) int64 {
	t.Helper()
	id, err := m.Append(files...)
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}
	return id
}

func paths(files []DataFile) map[string]bool {
	out := make(map[string]bool, len(files))
	for _, f := range files {
		out[f.Path] = true
	}
	return out
}

func TestPlanSelectsSamePartitionAndUnclaimed(t *testing.T) {
	m := NewManager()
	mustAppend(t, m,
		file("p1", "p1/a", 10),
		file("p1", "p1/b", 10),
		file("p2", "p2/c", 10),
	)

	plan, err := m.PlanCompaction("p1", PlanOptions{PlanID: "a"})
	if err != nil {
		t.Fatalf("PlanCompaction: %v", err)
	}
	if plan.BaseSnapshotID != 1 {
		t.Fatalf("base snapshot = %d, want 1", plan.BaseSnapshotID)
	}
	got := paths(plan.Replacement.Inputs)
	if !got["p1/a"] || !got["p1/b"] || got["p2/c"] {
		t.Fatalf("plan selected wrong files: %v", got)
	}
	if plan.Status != PlanPlanned {
		t.Fatalf("status = %q, want planned", plan.Status)
	}
	if !m.IsClaimed("p1/a") || m.ClaimOwner("p1/a") != "a" {
		t.Fatalf("input files were not claimed by plan a")
	}
}

func TestClaimSkipsFilesOccupiedByOtherPlan(t *testing.T) {
	m := NewManager()
	mustAppend(t, m,
		file("p", "p/1", 10), file("p", "p/2", 10),
		file("p", "p/3", 10), file("p", "p/4", 10),
	)

	first, err := m.PlanCompaction("p", PlanOptions{PlanID: "first", MaxFiles: 2})
	if err != nil {
		t.Fatalf("first plan: %v", err)
	}
	firstInputs := paths(first.Replacement.Inputs)

	second, err := m.PlanCompaction("p", PlanOptions{PlanID: "second"})
	if err != nil {
		t.Fatalf("second plan: %v", err)
	}
	for _, f := range second.Replacement.Inputs {
		if firstInputs[f.Path] {
			t.Fatalf("second plan selected occupied file %s", f.Path)
		}
	}

	small := NewManager()
	mustAppend(t, small, file("q", "q/1", 1), file("q", "q/2", 1))
	if _, err := small.PlanCompaction("q", PlanOptions{PlanID: "q1"}); err != nil {
		t.Fatalf("q1: %v", err)
	}
	if _, err := small.PlanCompaction("q", PlanOptions{PlanID: "q2"}); !errors.Is(err, ErrConflict) &&
		!errors.Is(err, ErrNothingToCompact) {
		t.Fatalf("q2 error = %v, want ErrNothingToCompact", err)
	}
}

func TestPlanThresholdsAndSizeBounds(t *testing.T) {
	m := NewManager()
	mustAppend(t, m, file("p", "p/1", 60), file("p", "p/2", 60), file("p", "p/3", 60))

	if _, err := m.PlanCompaction("empty", PlanOptions{}); !errors.Is(err, ErrNothingToCompact) {
		t.Fatalf("empty partition error = %v", err)
	}

	plan, err := m.PlanCompaction("p", PlanOptions{MaxFiles: 2})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(plan.Replacement.Inputs) != 2 {
		t.Fatalf("selected %d files, want 2", len(plan.Replacement.Inputs))
	}
	if err := m.Abort(plan.ID); err != nil {
		t.Fatalf("abort: %v", err)
	}

	bounded, err := m.PlanCompaction("p", PlanOptions{MaxTotalSizeInBytes: 150})
	if err != nil {
		t.Fatalf("size bounded plan: %v", err)
	}
	var total int64
	for _, f := range bounded.Replacement.Inputs {
		total += f.SizeInBytes
	}
	if total > 150 {
		t.Fatalf("selected size %d exceeds bound 150", total)
	}
}

func TestCommitAppliesReplacementAndSnapshot(t *testing.T) {
	m := NewManager()
	mustAppend(t, m, file("p", "p/1", 10), file("p", "p/2", 10))

	plan, err := m.PlanCompaction("p", PlanOptions{PlanID: "c"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	output := file("p", "p/compacted", 20)
	result, err := m.Commit(plan.ID, []DataFile{output})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if result.SnapshotID != 2 {
		t.Fatalf("commit snapshot = %d, want 2", result.SnapshotID)
	}

	manifest := m.Manifest()
	if manifest.SnapshotID != 2 || len(manifest.Files) != 1 || manifest.Files[0].Path != "p/compacted" {
		t.Fatalf("unexpected manifest after commit: %+v", manifest)
	}

	committed, _ := m.GetPlan(plan.ID)
	if committed.Status != PlanCommitted || committed.CommitSnapshotID != 2 {
		t.Fatalf("plan not marked committed: %+v", committed)
	}

	snaps := m.Snapshots()
	if len(snaps) != 2 {
		t.Fatalf("snapshot history length = %d, want 2", len(snaps))
	}
	last := snaps[1]
	if last.ParentID != 1 || len(last.AddedFiles) != 1 || len(last.RemovedFiles) != 2 {
		t.Fatalf("compaction snapshot wrong: %+v", last)
	}

	item := m.RecycleList()[0]
	if item.Reason != RecycleReplacedInput || item.Immediately || item.SnapshotID != 2 {
		t.Fatalf("replaced input recycle entry wrong: %+v", item)
	}
	if m.IsClaimed("p/1") {
		t.Fatalf("claim was not released after commit")
	}
}

func TestIntersectingPlansOnlyOneCommits(t *testing.T) {
	m := NewManager()
	mustAppend(t, m, file("p", "p/1", 1), file("p", "p/2", 1), file("p", "p/3", 1))

	// NoClaim lets both plans overlap; commit-time OCC must still serialize.
	first, err := m.PlanCompaction("p", PlanOptions{PlanID: "first", NoClaim: true})
	if err != nil {
		t.Fatalf("first plan: %v", err)
	}
	second, err := m.PlanCompaction("p", PlanOptions{PlanID: "second", NoClaim: true})
	if err != nil {
		t.Fatalf("second plan: %v", err)
	}

	if _, err := m.Commit(first.ID, []DataFile{file("p", "p/out-a", 3)}); err != nil {
		t.Fatalf("first commit: %v", err)
	}
	if _, err := m.Commit(second.ID, []DataFile{file("p", "p/out-b", 3)}); !errors.Is(err, ErrConflict) {
		t.Fatalf("second commit error = %v, want ErrConflict", err)
	}

	// Conflict must be atomic: loser output is absent and loser stays open.
	if active := paths(m.Manifest().Files); active["p/out-b"] {
		t.Fatalf("loser output entered the manifest")
	}
	loser, _ := m.GetPlan(second.ID)
	if loser.Status != PlanPlanned {
		t.Fatalf("loser status = %q, want planned so it can retry", loser.Status)
	}

	if _, err := m.Commit(first.ID, []DataFile{file("p", "p/again", 1)}); !errors.Is(err, ErrPlanNotOpen) {
		t.Fatalf("double commit error = %v, want ErrPlanNotOpen", err)
	}
}

func TestLoserCanReplanAndCommit(t *testing.T) {
	m := NewManager()
	mustAppend(t, m, file("p", "p/1", 1), file("p", "p/2", 1))

	first, err := m.PlanCompaction("p", PlanOptions{PlanID: "first", NoClaim: true})
	if err != nil {
		t.Fatalf("first plan: %v", err)
	}
	second, err := m.PlanCompaction("p", PlanOptions{PlanID: "second", NoClaim: true})
	if err != nil {
		t.Fatalf("second plan: %v", err)
	}

	if _, err := m.Commit(first.ID, []DataFile{file("p", "p/merged", 2)}); err != nil {
		t.Fatalf("first commit: %v", err)
	}
	if _, err := m.Commit(second.ID, []DataFile{file("p", "p/lost", 2)}); !errors.Is(err, ErrConflict) {
		t.Fatalf("second commit error = %v, want ErrConflict", err)
	}

	// The stale loser is abandoned; a fresh plan compacts the winner output.
	if err := m.Abort(second.ID); err != nil {
		t.Fatalf("abort loser: %v", err)
	}
	retry, err := m.PlanCompaction("p", PlanOptions{PlanID: "retry", MinFiles: 1})
	if err != nil {
		t.Fatalf("retry plan: %v", err)
	}
	if len(retry.Replacement.Inputs) != 1 || retry.Replacement.Inputs[0].Path != "p/merged" {
		t.Fatalf("retry plan should target the winner output, got %+v", retry.Replacement.Inputs)
	}

	active := paths(m.Manifest().Files)
	if !active["p/merged"] || active["p/1"] || active["p/2"] {
		t.Fatalf("unexpected active set after conflict: %v", active)
	}
}

func TestConcurrentIntersectingCommitsSingleWinner(t *testing.T) {
	m := NewManager()
	const n = 12
	files := make([]DataFile, 0, n)
	for i := 0; i < n; i++ {
		files = append(files, file("p", fmt.Sprintf("p/%d", i), 1))
	}
	mustAppend(t, m, files...)

	const planCount = 10
	planIDs := make([]string, planCount)
	for i := 0; i < planCount; i++ {
		plan, err := m.PlanCompaction("p", PlanOptions{
			PlanID:  fmt.Sprintf("g-%d", i),
			NoClaim: true,
		})
		if err != nil {
			t.Fatalf("plan %d: %v", i, err)
		}
		planIDs[i] = plan.ID
	}

	var wg sync.WaitGroup
	results := make([]error, planCount)
	for i := 0; i < planCount; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, results[idx] = m.Commit(planIDs[idx], []DataFile{file("p", fmt.Sprintf("p/out-%d", idx), int64(n))})
		}(i)
	}
	wg.Wait()

	winners, conflicts := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, ErrConflict):
			conflicts++
		default:
			t.Fatalf("unexpected commit error: %v", err)
		}
	}
	if winners != 1 || conflicts != planCount-1 {
		t.Fatalf("winners = %d, conflicts = %d, want 1 and %d", winners, conflicts, planCount-1)
	}

	active := m.Manifest().Files
	if len(active) != 1 {
		t.Fatalf("manifest should contain only the winner output, got %+v", active)
	}
}

func TestFailKeepsOutputsOutOfManifestAndRecycles(t *testing.T) {
	m := NewManager()
	mustAppend(t, m, file("p", "p/1", 1), file("p", "p/2", 1))
	plan, err := m.PlanCompaction("p", PlanOptions{PlanID: "f"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}

	partial := []DataFile{file("p", "p/tmp-output", 2)}
	if err := m.Fail(plan.ID, partial); err != nil {
		t.Fatalf("fail: %v", err)
	}

	if active := paths(m.Manifest().Files); active["p/tmp-output"] {
		t.Fatalf("failed output entered the manifest")
	}
	if len(m.Manifest().Files) != 2 {
		t.Fatalf("inputs must remain active after failure")
	}

	list := m.RecycleList()
	if len(list) != 1 {
		t.Fatalf("recycle list = %d entries, want 1", len(list))
	}
	item := list[0]
	if item.Reason != RecycleFailedOutput || !item.Immediately || item.SnapshotID != 0 {
		t.Fatalf("failed-output recycle entry wrong: %+v", item)
	}

	failed, _ := m.GetPlan(plan.ID)
	if failed.Status != PlanFailed {
		t.Fatalf("status = %q, want failed", failed.Status)
	}
	if m.IsClaimed("p/1") {
		t.Fatalf("claims should be released so files can be replanned")
	}
	if _, err := m.PlanCompaction("p", PlanOptions{PlanID: "retry"}); err != nil {
		t.Fatalf("replan after failure: %v", err)
	}
}

func TestAbortReleasesClaims(t *testing.T) {
	m := NewManager()
	mustAppend(t, m, file("p", "p/1", 1), file("p", "p/2", 1))
	plan, _ := m.PlanCompaction("p", PlanOptions{PlanID: "a"})

	if err := m.Abort(plan.ID); err != nil {
		t.Fatalf("abort: %v", err)
	}
	if m.IsClaimed("p/1") {
		t.Fatalf("abort did not release claims")
	}
	aborted, _ := m.GetPlan(plan.ID)
	if aborted.Status != PlanAborted {
		t.Fatalf("status = %q, want aborted", aborted.Status)
	}
	if err := m.Abort(plan.ID); !errors.Is(err, ErrPlanNotOpen) {
		t.Fatalf("second abort error = %v, want ErrPlanNotOpen", err)
	}
}

func TestCommitValidationIsAtomic(t *testing.T) {
	m := NewManager()
	mustAppend(t, m, file("p", "p/1", 1), file("p", "p/2", 1))
	plan, _ := m.PlanCompaction("p", PlanOptions{PlanID: "v"})
	before := m.CurrentSnapshotID()

	cases := []struct {
		name    string
		outputs []DataFile
		want    error
	}{
		{"empty", nil, ErrEmptyOutput},
		{"empty path", []DataFile{{Partition: "p"}}, ErrInvalidPath},
		{"duplicate", []DataFile{file("p", "p/d", 1), file("p", "p/d", 1)}, ErrDuplicatePath},
		{"wrong partition", []DataFile{file("other", "o/x", 1)}, ErrPartitionMismatch},
		{"already exists", []DataFile{file("p", "p/1", 1)}, ErrOutputExists},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := m.Commit(plan.ID, tc.outputs); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if m.CurrentSnapshotID() != before {
				t.Fatalf("invalid commit mutated snapshot history")
			}
			if got := m.Manifest().Files; len(got) != 2 {
				t.Fatalf("invalid commit mutated manifest: %+v", got)
			}
			if plan, _ := m.GetPlan(plan.ID); plan.Status != PlanPlanned {
				t.Fatalf("invalid commit changed plan status to %q", plan.Status)
			}
		})
	}
}

func TestRecycleListLifecycle(t *testing.T) {
	m := NewManager()
	mustAppend(t, m, file("p", "p/1", 1), file("p", "p/2", 1))

	failed, _ := m.PlanCompaction("p", PlanOptions{PlanID: "fail"})
	if err := m.Fail(failed.ID, []DataFile{file("p", "p/bad", 1)}); err != nil {
		t.Fatalf("fail: %v", err)
	}

	next, _ := m.PlanCompaction("p", PlanOptions{PlanID: "ok"})
	if _, err := m.Commit(next.ID, []DataFile{file("p", "p/good", 2)}); err != nil {
		t.Fatalf("commit: %v", err)
	}

	list := m.RecycleList()
	if len(list) != 3 {
		t.Fatalf("recycle list = %d entries, want 3 (1 failed output + 2 replaced)", len(list))
	}

	removed := m.AcknowledgeRecycled("p/bad", "p/1", "missing")
	if removed != 2 {
		t.Fatalf("acknowledged %d entries, want 2", removed)
	}
	if remaining := m.RecycleList(); len(remaining) != 1 || remaining[0].Path != "p/2" {
		t.Fatalf("unexpected remaining recycle list: %+v", remaining)
	}

	// Idempotent retry removes nothing new.
	if again := m.AcknowledgeRecycled("p/bad"); again != 0 {
		t.Fatalf("re-acknowledge removed %d, want 0", again)
	}
}

func TestAppendAndPlanErrors(t *testing.T) {
	m := NewManager()

	if _, err := m.Append(); !errors.Is(err, ErrEmptyOutput) {
		t.Fatalf("empty append error = %v", err)
	}
	if _, err := m.Append(DataFile{Partition: "p"}); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("invalid path error = %v", err)
	}
	if _, err := m.Append(file("p", "p/1", 1), file("p", "p/1", 1)); !errors.Is(err, ErrDuplicatePath) {
		t.Fatalf("duplicate append error = %v", err)
	}

	mustAppend(t, m, file("p", "p/1", 1))
	if _, err := m.Append(file("p", "p/1", 1)); !errors.Is(err, ErrOutputExists) {
		t.Fatalf("re-append error = %v", err)
	}

	if _, err := m.PlanCompaction("p", PlanOptions{PlanID: "x"}); !errors.Is(err, ErrNothingToCompact) {
		t.Fatalf("single-file plan error = %v", err)
	}
	mustAppend(t, m, file("p", "p/2", 1))
	if _, err := m.PlanCompaction("p", PlanOptions{PlanID: "dup"}); err != nil {
		t.Fatalf("first plan: %v", err)
	}
	if _, err := m.GetPlan("missing"); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("missing plan error = %v", err)
	}
	if _, err := m.Commit("missing", []DataFile{file("p", "p/x", 1)}); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("commit missing plan error = %v", err)
	}
	if err := m.Fail("missing", nil); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("fail missing plan error = %v", err)
	}

	idManager := NewManager()
	mustAppend(t, idManager, file("p", "p/1", 1), file("p", "p/2", 1))
	if _, err := idManager.PlanCompaction("p", PlanOptions{PlanID: "same"}); err != nil {
		t.Fatalf("first same-id plan: %v", err)
	}
	if _, err := idManager.PlanCompaction("p", PlanOptions{PlanID: "same", NoClaim: true}); !errors.Is(err, ErrPlanIDExists) {
		t.Fatalf("duplicate plan id error = %v", err)
	}
}
