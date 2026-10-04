package filetrace

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

type fileIface interface {
	Write([]byte) (int, error)
	Read([]byte) (int, error)
	Seek(int64, int) (int64, error)
	Sync() error
	Close() error
}

// workload is a deterministic client producing 3 persistence points plus a
// tail of events after the last Sync.
func workload(f fileIface) error {
	steps := []func() error{
		func() error { _, err := f.Write([]byte("hello ")); return err },
		func() error { _, err := f.Write([]byte("world")); return err },
		func() error { return f.Sync() }, // persistence point 0
		func() error { _, err := f.Seek(0, io.SeekStart); return err },
		func() error { _, err := f.Read(make([]byte, 5)); return err },
		func() error { _, err := f.Write([]byte("WORLD")); return err },
		func() error { return f.Sync() }, // persistence point 1
		func() error { _, err := f.Seek(-3, io.SeekEnd); return err },
		func() error { _, err := f.Read(make([]byte, 10)); return err },
		func() error { _, err := f.Write([]byte("!!")); return err },
		func() error { return f.Sync() }, // persistence point 2
		func() error { _, err := f.Seek(0, io.SeekStart); return err },
		func() error { _, err := f.Read(make([]byte, 4)); return err },
		func() error { _, err := f.Write([]byte("?")); return err },
		func() error { return f.Close() },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

func recordWorkload(t *testing.T) (*MemFile, *Trace) {
	t.Helper()
	f := NewMemFile()
	rec := NewRecorder(f)
	if err := workload(rec); err != nil {
		t.Fatalf("workload: %v", err)
	}
	return f, rec.Trace
}

func assertState(t *testing.T, f *MemFile, want Snapshot, ctx string) {
	t.Helper()
	if !bytes.Equal(f.Data(), want.Data) {
		t.Errorf("%s: data = %q, want %q", ctx, f.Data(), want.Data)
	}
	if !bytes.Equal(f.Durable(), want.Durable) {
		t.Errorf("%s: durable = %q, want %q", ctx, f.Durable(), want.Durable)
	}
	if f.Offset() != want.Off {
		t.Errorf("%s: offset = %d, want %d", ctx, f.Offset(), want.Off)
	}
}

func TestRecordAndFullReplay(t *testing.T) {
	recorded, tr := recordWorkload(t)
	if len(tr.Snapshots) != 3 {
		t.Fatalf("snapshots = %d, want 3", len(tr.Snapshots))
	}
	replayed := NewMemFile()
	if err := ReplayAll(replayed, tr); err != nil {
		t.Fatalf("ReplayAll: %v", err)
	}
	assertState(t, replayed, Snapshot{
		Data:    recorded.Data(),
		Durable: recorded.Durable(),
		Off:     recorded.Offset(),
	}, "full replay vs record")
}

func TestReplayArgumentMismatch(t *testing.T) {
	_, tr := recordWorkload(t)

	r := NewReplayer(NewMemFile(), tr)
	if _, err := r.Write([]byte("WRONG")); err == nil ||
		!strings.Contains(err.Error(), "event 0") || !strings.Contains(err.Error(), "argument mismatch") {
		t.Errorf("wrong Write args: got %v, want event-0 argument mismatch", err)
	}

	r = NewReplayer(NewMemFile(), tr)
	if _, err := r.Read(make([]byte, 5)); err == nil || !strings.Contains(err.Error(), "expects Write, got Read") {
		t.Errorf("wrong op order: got %v, want Write/Read mismatch", err)
	}

	r = NewReplayer(NewMemFile(), tr)
	if _, err := r.Seek(0, io.SeekStart); err == nil || !strings.Contains(err.Error(), "expects Write, got Seek") {
		t.Errorf("wrong op: got %v, want Write/Seek mismatch", err)
	}
}

func TestReplayResultMismatch(t *testing.T) {
	_, tr := recordWorkload(t)
	tr.Events[0].N = 999 // tamper with the recorded return value
	if err := ReplayAll(NewMemFile(), tr); err == nil || !strings.Contains(err.Error(), "result mismatch") {
		t.Errorf("got %v, want result mismatch", err)
	}
}

func TestUnconsumedTrace(t *testing.T) {
	_, tr := recordWorkload(t)
	r := NewReplayer(NewMemFile(), tr)
	if err := Drive(r, tr, 0, 3); err != nil {
		t.Fatalf("Drive: %v", err)
	}
	err := r.Finish()
	if err == nil || !strings.Contains(err.Error(), "unconsumed") {
		t.Fatalf("Finish: got %v, want unconsumed-trace error", err)
	}
	if !strings.Contains(err.Error(), "next is event 3 (Seek)") {
		t.Errorf("error should name the next unconsumed event, got %v", err)
	}
}

func TestCrashInjectionAtPersistencePoint(t *testing.T) {
	_, tr := recordWorkload(t)

	full := NewMemFile()
	if err := ReplayAll(full, tr); err != nil {
		t.Fatalf("ReplayAll: %v", err)
	}
	fullState := Snapshot{Data: full.Data(), Durable: full.Durable(), Off: full.Offset()}

	for k := 0; k < len(tr.Snapshots); k++ {
		f := NewMemFile()
		r := NewReplayer(f, tr)
		r.CrashAt = k
		err := Drive(r, tr, 0, len(tr.Events))
		if !errors.Is(err, ErrInjectedCrash) {
			t.Fatalf("k=%d: got %v, want ErrInjectedCrash", k, err)
		}
		// The interruption must not change already-written bytes.
		snap := tr.Snapshots[k]
		if !bytes.Equal(f.Durable(), snap.Durable) {
			t.Errorf("k=%d: durable bytes changed by crash: %q, want %q", k, f.Durable(), snap.Durable)
		}
		if !bytes.Equal(f.Data(), snap.Data) {
			t.Errorf("k=%d: written bytes changed by crash: %q, want %q", k, f.Data(), snap.Data)
		}
		// Every later call reports the crash.
		if _, err := r.Write([]byte("x")); !errors.Is(err, ErrInjectedCrash) {
			t.Errorf("k=%d: post-crash Write: got %v, want ErrInjectedCrash", k, err)
		}
		// Recovery: restore the snapshot taken at the crash point and
		// replay the remaining events; the result equals the full run.
		g := NewMemFile()
		g.Restore(snap)
		r2 := NewReplayerAt(g, tr, r.Pos())
		if err := Drive(r2, tr, r.Pos(), len(tr.Events)); err != nil {
			t.Fatalf("k=%d: recovery Drive: %v", k, err)
		}
		if err := r2.Finish(); err != nil {
			t.Fatalf("k=%d: recovery Finish: %v", k, err)
		}
		assertState(t, g, fullState, "recovery after crash")
	}
}

func TestSegmentedReplayEqualsFullRun(t *testing.T) {
	_, tr := recordWorkload(t)

	full := NewMemFile()
	if err := ReplayAll(full, tr); err != nil {
		t.Fatalf("ReplayAll: %v", err)
	}
	fullState := Snapshot{Data: full.Data(), Durable: full.Durable(), Off: full.Offset()}

	bounds := tr.SegmentBounds()
	if len(bounds) != 4 { // 3 persistence points + tail
		t.Fatalf("segments = %d, want 4", len(bounds))
	}

	seg := NewMemFile()
	for i, b := range bounds {
		if i > 0 {
			// Resume from the snapshot saved at the previous persistence point.
			seg.Restore(tr.Snapshots[i-1])
		}
		r := NewReplayerAt(seg, tr, b[0])
		if err := Drive(r, tr, b[0], b[1]); err != nil {
			t.Fatalf("segment %d: %v", i, err)
		}
		if i < len(tr.Snapshots) {
			// Each segment ends at a persistence point; the state must
			// match the snapshot saved there during recording.
			assertState(t, seg, tr.Snapshots[i], "segment boundary")
		}
	}
	assertState(t, seg, fullState, "segmented replay vs full run")
}

func TestSnapshotRestore(t *testing.T) {
	f := NewMemFile()
	if _, err := f.Write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := f.Sync(); err != nil {
		t.Fatal(err)
	}
	snap := f.Snapshot(0)
	if _, err := f.Write([]byte("def")); err != nil {
		t.Fatal(err)
	}
	f.Restore(snap)
	assertState(t, f, snap, "restore")
	if got := f.Data(); !bytes.Equal(got, []byte("abc")) {
		t.Errorf("data after restore = %q, want %q", got, "abc")
	}
}
