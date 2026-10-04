package replayfs

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// workload is a deterministic sequence of file-interface calls with
// several persistence points (Sync/Close). It runs unchanged against
// both the Recorder and the Replayer.
func workload(sys System) error {
	a, err := sys.Open("a.log")
	if err != nil {
		return err
	}
	if _, err = a.Write([]byte("alpha")); err != nil {
		return err
	}
	if err = a.Sync(); err != nil { // persistence point 1
		return err
	}
	if _, err = a.Write([]byte("-beta")); err != nil {
		return err
	}
	buf := make([]byte, 5)
	if _, err = a.Read(buf); err != nil {
		return err
	}
	if err = a.Sync(); err != nil { // persistence point 2
		return err
	}
	b, err := sys.Open("b.log")
	if err != nil {
		return err
	}
	if _, err = b.Write([]byte("gamma")); err != nil {
		return err
	}
	if err = b.Sync(); err != nil { // persistence point 3
		return err
	}
	if _, err = a.Write([]byte("-omega")); err != nil {
		return err
	}
	if err = a.Close(); err != nil { // persistence point 4
		return err
	}
	if err = b.Close(); err != nil { // persistence point 5
		return err
	}
	return nil
}

func recordWorkload(t *testing.T, crashAt int) (*Recorder, *Store) {
	t.Helper()
	store := NewStore()
	rec := NewRecorder(NewFS(store))
	rec.CrashAt = crashAt
	err := workload(rec)
	if crashAt == 0 && err != nil {
		t.Fatalf("workload: %v", err)
	}
	return rec, store
}

func persistIndexes(entries []Entry) []int {
	var idx []int
	for i, e := range entries {
		if e.Persist {
			idx = append(idx, i)
		}
	}
	return idx
}

func TestRecordReplayRoundTrip(t *testing.T) {
	rec, recStore := recordWorkload(t, 0)
	if got := persistIndexes(rec.Entries); len(got) != 5 {
		t.Fatalf("want 5 persistence points, got %d", len(got))
	}

	repStore := NewStore()
	rp := NewReplayer(NewFS(repStore), rec.Entries)
	if err := workload(rp); err != nil {
		t.Fatalf("replay workload: %v", err)
	}
	if err := rp.Finish(); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if !recStore.Equal(repStore) {
		t.Fatal("replayed store differs from recorded store")
	}
	if got := string(repStore.load("a.log")); got != "alpha-beta-omega" {
		t.Fatalf("a.log = %q", got)
	}
	if got := string(repStore.load("b.log")); got != "gamma" {
		t.Fatalf("b.log = %q", got)
	}
}

func TestReplayArgumentMismatch(t *testing.T) {
	rec, _ := recordWorkload(t, 0)

	rp := NewReplayer(NewFS(NewStore()), rec.Entries)
	h, err := rp.Open("a.log")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err = h.Write([]byte("ALPHA")); err == nil {
		t.Fatal("want argument mismatch error, got nil")
	} else if !strings.Contains(err.Error(), "mismatch") && !strings.Contains(err.Error(), "recorded") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReplayOperationMismatch(t *testing.T) {
	rec, _ := recordWorkload(t, 0)

	rp := NewReplayer(NewFS(NewStore()), rec.Entries)
	if _, err := rp.Open("b.log"); err == nil {
		t.Fatal("want operation/path mismatch error, got nil")
	}
}

func TestUnconsumedTraceFails(t *testing.T) {
	rec, _ := recordWorkload(t, 0)

	// Replay only the first call, then finish: entries remain.
	rp := NewReplayer(NewFS(NewStore()), rec.Entries)
	if _, err := rp.Open("a.log"); err != nil {
		t.Fatalf("open: %v", err)
	}
	err := rp.Finish()
	if err == nil {
		t.Fatal("want unconsumed-trace error, got nil")
	}
	if !strings.Contains(err.Error(), "unconsumed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExhaustedTraceFails(t *testing.T) {
	rec, _ := recordWorkload(t, 0)

	// Consume the whole trace, then issue one extra call.
	rp := NewReplayer(NewFS(NewStore()), rec.Entries)
	if err := workload(rp); err != nil {
		t.Fatalf("replay workload: %v", err)
	}
	if err := rp.Finish(); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if _, err := rp.Open("extra.log"); err == nil {
		t.Fatal("want trace-exhausted error, got nil")
	} else if !strings.Contains(err.Error(), "exhausted") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCrashInjectionAtPersistencePoint(t *testing.T) {
	const crashAt = 2
	rec, store := recordWorkload(t, crashAt)

	// The workload must observe the injected interruption.
	last := rec.Entries[len(rec.Entries)-1]
	if last.Op != "Sync" || last.Err != ErrCrash.Error() || !last.Persist {
		t.Fatalf("last entry = %+v, want crashing Sync persistence point", last)
	}

	// Already-written bytes are unchanged: everything committed up to
	// and including the 2nd persistence point survives; nothing more.
	if got := string(store.load("a.log")); got != "alpha-beta" {
		t.Fatalf("a.log after crash = %q, want %q", got, "alpha-beta")
	}
	if got := store.load("b.log"); len(got) != 0 {
		t.Fatalf("b.log after crash = %q, want empty", got)
	}

	// The crash trace replays cleanly and reproduces the same state.
	repStore := NewStore()
	rp := NewReplayer(NewFS(repStore), rec.Entries)
	err := workload(rp)
	if !errors.Is(err, ErrCrash) {
		t.Fatalf("replay workload err = %v, want ErrCrash", err)
	}
	if err := rp.Finish(); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if !store.Equal(repStore) {
		t.Fatal("replayed crash state differs from recorded crash state")
	}
}

func TestSegmentedReplayEqualsFullRun(t *testing.T) {
	rec, _ := recordWorkload(t, 0)
	persists := persistIndexes(rec.Entries)

	// Full run: replay the entire trace in one go.
	fullStore := NewStore()
	full := NewReplayer(NewFS(fullStore), rec.Entries)
	if err := workload(full); err != nil {
		t.Fatalf("full replay: %v", err)
	}
	if err := full.Finish(); err != nil {
		t.Fatalf("full finish: %v", err)
	}
	fullSnap, err := fullStore.Snapshot()
	if err != nil {
		t.Fatalf("full snapshot: %v", err)
	}

	// Segmented run: for every persistence point k, replay the prefix
	// up to and including it, snapshot, restore into a fresh FS, and
	// replay the remainder. The final state must equal the full run.
	for k, idx := range persists {
		headStore := NewStore()
		head := NewReplayer(NewFS(headStore), rec.Entries[:idx+1])
		if err := workloadPrefix(head, idx+1); err != nil {
			t.Fatalf("segment %d prefix: %v", k+1, err)
		}
		if err := head.Finish(); err != nil {
			t.Fatalf("segment %d prefix finish: %v", k+1, err)
		}
		snap, err := headStore.Snapshot()
		if err != nil {
			t.Fatalf("segment %d snapshot: %v", k+1, err)
		}

		restored, err := RestoreStore(snap)
		if err != nil {
			t.Fatalf("segment %d restore: %v", k+1, err)
		}
		tail := NewReplayer(NewFS(restored), rec.Entries[idx+1:])
		if err := workloadSuffix(tail, tail.Attach, rec.Entries, idx+1); err != nil {
			t.Fatalf("segment %d suffix: %v", k+1, err)
		}
		if err := tail.Finish(); err != nil {
			t.Fatalf("segment %d suffix finish: %v", k+1, err)
		}
		segSnap, err := restored.Snapshot()
		if err != nil {
			t.Fatalf("segment %d final snapshot: %v", k+1, err)
		}
		if !bytes.Equal(fullSnap, segSnap) {
			t.Fatalf("segmented replay at persistence point %d differs from full run", k+1)
		}
	}
}

// workloadPrefix drives exactly the first n trace entries through sys,
// mirroring the workload's call sequence.
func workloadPrefix(sys System, n int) error {
	return driveEntries(sys, nil, workloadEntries, n)
}

// workloadSuffix drives trace entries [from:] through sys. Handles that
// were opened in the prefix are re-established via attach, so their
// calls are still verified against the trace without consuming an Open
// entry.
func workloadSuffix(sys System, attach func(string) (Handle, error), entries []Entry, from int) error {
	return driveEntries(sys, attach, entries[from:], len(entries)-from)
}

// workloadEntries is the canonical call sequence of workload, used to
// drive segmented replays with the exact same operations.
var workloadEntries = []Entry{
	{Op: "Open", Path: "a.log"},
	{Op: "Write", Path: "a.log", Data: []byte("alpha")},
	{Op: "Sync", Path: "a.log"},
	{Op: "Write", Path: "a.log", Data: []byte("-beta")},
	{Op: "Read", Path: "a.log", N: 5},
	{Op: "Sync", Path: "a.log"},
	{Op: "Open", Path: "b.log"},
	{Op: "Write", Path: "b.log", Data: []byte("gamma")},
	{Op: "Sync", Path: "b.log"},
	{Op: "Write", Path: "a.log", Data: []byte("-omega")},
	{Op: "Close", Path: "a.log"},
	{Op: "Close", Path: "b.log"},
}

// driveEntries issues the first n calls of plan against sys, keeping
// handles open across calls like the real workload does. If a call
// references a path with no open handle and fallback is non-nil, the
// handle is opened directly on fallback.
func driveEntries(sys System, attach func(string) (Handle, error), plan []Entry, n int) error {
	handles := map[string]Handle{}
	get := func(path string) (Handle, error) {
		if h, ok := handles[path]; ok {
			return h, nil
		}
		if attach == nil {
			return nil, errors.New("replayfs: no open handle for " + path)
		}
		h, err := attach(path)
		if err != nil {
			return nil, err
		}
		handles[path] = h
		return h, nil
	}
	for i := 0; i < n && i < len(plan); i++ {
		e := plan[i]
		switch e.Op {
		case "Open":
			h, err := sys.Open(e.Path)
			if err != nil {
				return err
			}
			handles[e.Path] = h
		case "Write":
			h, err := get(e.Path)
			if err != nil {
				return err
			}
			if _, err := h.Write(e.Data); err != nil {
				return err
			}
		case "Read":
			h, err := get(e.Path)
			if err != nil {
				return err
			}
			if _, err := h.Read(make([]byte, e.N)); err != nil {
				return err
			}
		case "Sync":
			h, err := get(e.Path)
			if err != nil {
				return err
			}
			if err := h.Sync(); err != nil {
				return err
			}
		case "Close":
			h, err := get(e.Path)
			if err != nil {
				return err
			}
			if err := h.Close(); err != nil {
				return err
			}
		}
	}
	return nil
}

func TestSnapshotRoundTrip(t *testing.T) {
	store := NewStore()
	fs := NewFS(store)
	f, _ := fs.Open("x")
	f.Write([]byte("data"))
	f.Sync()

	snap, err := store.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	restored, err := RestoreStore(snap)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if !store.Equal(restored) {
		t.Fatal("restored store differs from original")
	}
	// Independence: mutating the original must not affect the copy.
	f.Write([]byte("more"))
	f.Sync()
	if store.Equal(restored) {
		t.Fatal("restored store is not independent of original")
	}
}
