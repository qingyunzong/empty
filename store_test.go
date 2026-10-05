package trendlib

import (
	"os"
	"path/filepath"
	"testing"
)

// compareIndexes recomputes a grid of queries on both indexes and requires
// identical results for every version and range.
func compareIndexes(t *testing.T, got, want *Index) {
	t.Helper()
	if got.Version() != want.Version() {
		t.Fatalf("version = %d, want %d", got.Version(), want.Version())
	}
	for v := 0; v <= want.Version(); v++ {
		for lo := int64(-5); lo < 35; lo += 3 {
			for hi := lo + 1; hi < 38; hi += 4 {
				gs, gr, err := got.Query(lo, hi, v)
				if err != nil {
					t.Fatalf("got.Query(%d,%d,%d): %v", lo, hi, v, err)
				}
				ws, wr, err := want.Query(lo, hi, v)
				if err != nil {
					t.Fatalf("want.Query(%d,%d,%d): %v", lo, hi, v, err)
				}
				if (gs == nil) != (ws == nil) {
					t.Fatalf("v%d [%d,%d): slope nil mismatch %v vs %v", v, lo, hi, gs, ws)
				}
				if gs != nil && gs.Cmp(ws) != 0 {
					t.Fatalf("v%d [%d,%d): slope %v vs %v", v, lo, hi, gs, ws)
				}
				if gr.Cmp(wr) != 0 {
					t.Fatalf("v%d [%d,%d): rss %v vs %v", v, lo, hi, gr, wr)
				}
			}
		}
	}
}

func readRootFile(t *testing.T, dir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, rootFileName))
	if err != nil {
		t.Fatalf("read ROOT: %v", err)
	}
	return string(data)
}

func TestAtomicPublishAndRecovery(t *testing.T) {
	dir := t.TempDir()
	base := []Sample{{0, 0}, {5, 7}, {10, 3}, {20, 20}, {30, 1}}
	b1 := Batch{Corrections: []Correction{{Start: 8, End: 22, Samples: []Sample{{9, 9}, {15, 15}}}}}
	b2 := Batch{Corrections: []Correction{{Start: 0, End: 6, Samples: []Sample{{1, 2}, {2, 4}}}}}

	// Reference index kept purely in memory.
	ref := NewIndex(base)

	st, err := CreateStore(dir, base)
	if err != nil {
		t.Fatalf("CreateStore: %v", err)
	}
	if readRootFile(t, dir) != "0" {
		t.Fatalf("ROOT = %q, want 0", readRootFile(t, dir))
	}

	// Commit batch 1 fully and recover: new root must be visible with
	// complete data.
	if v, err := st.PublishBatch(b1); err != nil || v != 1 {
		t.Fatalf("PublishBatch(b1) = %d, %v; want 1, nil", v, err)
	}
	ref.Publish(b1)
	if readRootFile(t, dir) != "1" {
		t.Fatalf("ROOT = %q, want 1", readRootFile(t, dir))
	}
	rec, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	compareIndexes(t, rec.Index(), ref)

	// Crash after the batch data file is durable but before the root
	// publish: recovery must find the old root and ignore the orphan.
	st2, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	st2.Failpoint = "data"
	if _, err := st2.PublishBatch(b2); err != ErrCrash {
		t.Fatalf("PublishBatch with data failpoint = %v, want ErrCrash", err)
	}
	if _, err := os.Stat(filepath.Join(dir, batchFileName(2))); err != nil {
		t.Fatalf("orphan batch file should exist: %v", err)
	}
	if readRootFile(t, dir) != "1" {
		t.Fatalf("ROOT after crash = %q, want 1", readRootFile(t, dir))
	}
	rec2, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("OpenStore after crash: %v", err)
	}
	compareIndexes(t, rec2.Index(), ref) // still version 1, fully consistent

	// The recovered store stays usable: re-publishing the crashed batch
	// succeeds and overwrites the orphan.
	if v, err := rec2.PublishBatch(b2); err != nil || v != 2 {
		t.Fatalf("re-PublishBatch(b2) = %d, %v; want 2, nil", v, err)
	}
	ref.Publish(b2)
	rec3, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	compareIndexes(t, rec3.Index(), ref)

	// Crash before any write leaves no trace at all.
	st3, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	st3.Failpoint = "start"
	if _, err := st3.PublishBatch(Batch{Corrections: []Correction{{Start: 25, End: 28, Samples: []Sample{{26, 1}}}}}); err != ErrCrash {
		t.Fatalf("PublishBatch with start failpoint = %v, want ErrCrash", err)
	}
	if _, err := os.Stat(filepath.Join(dir, batchFileName(3))); !os.IsNotExist(err) {
		t.Fatalf("no batch-3 file should exist, stat err = %v", err)
	}
	rec4, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	compareIndexes(t, rec4.Index(), ref)
}

// TestRecoveryMatchesNaiveModel re-opens a store after several batches and
// cross-checks every recovered version against the direct rational
// summation model.
func TestRecoveryMatchesNaiveModel(t *testing.T) {
	dir := t.TempDir()
	base, batches := randomScenario(7)

	st, err := CreateStore(dir, base)
	if err != nil {
		t.Fatalf("CreateStore: %v", err)
	}
	for _, b := range batches {
		if _, err := st.PublishBatch(b); err != nil {
			t.Fatalf("PublishBatch: %v", err)
		}
	}
	rec, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	if rec.Index().Version() != len(batches) {
		t.Fatalf("recovered version = %d, want %d", rec.Index().Version(), len(batches))
	}
	for version := 0; version <= len(batches); version++ {
		samples := naiveEffectiveSamples(base, batches, version)
		for lo := int64(0); lo < 100; lo += 7 {
			for hi := lo + 3; hi < 105; hi += 11 {
				checkQueryEqual(t, rec.Index(), samples, lo, hi, version)
			}
		}
	}
}
