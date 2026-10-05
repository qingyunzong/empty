package coverage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

var errInjected = errors.New("injected fault")

// faultFS wraps an FS and fails the failAt-th mutating operation
// (WriteFile, Rename or SyncDir). Reads, List and the best-effort GC
// Remove are never faulted.
type faultFS struct {
	inner  FS
	ops    int
	failAt int // -1 disables injection
}

func (f *faultFS) gate() error {
	op := f.ops
	f.ops++
	if op == f.failAt {
		return errInjected
	}
	return nil
}

func (f *faultFS) ReadFile(name string) ([]byte, error) { return f.inner.ReadFile(name) }

func (f *faultFS) WriteFile(name string, data []byte) error {
	if err := f.gate(); err != nil {
		return err
	}
	return f.inner.WriteFile(name, data)
}

func (f *faultFS) Rename(old, new string) error {
	if err := f.gate(); err != nil {
		return err
	}
	return f.inner.Rename(old, new)
}

func (f *faultFS) Remove(name string) error { return f.inner.Remove(name) }

func (f *faultFS) SyncDir() error {
	if err := f.gate(); err != nil {
		return err
	}
	return f.inner.SyncDir()
}

func (f *faultFS) List() ([]string, error) { return f.inner.List() }

// oldAndNewStores returns the generation-1 store and the generation-2
// candidate produced from it by a batch of adds and removals.
func oldAndNewStores() (oldStore, newStore *Store) {
	oldStore = NewStore()
	oldStore.Add("alpha", Interval{L: 0, R: 5, W: 2}, Interval{L: 10, R: 14, W: -1})
	oldStore.Add("beta", Interval{L: 3, R: 8, W: 4})
	oldStore.Add("gamma", Interval{L: 6, R: 9, W: -2})
	newStore = oldStore.Snapshot()
	newStore.Apply(
		AddOp("alpha", Interval{L: 20, R: 25, W: 7}),
		RemoveOp("beta"),
		AddOp("delta", Interval{L: 4, R: 12, W: 3}),
	)
	return oldStore, newStore
}

func TestRecoverEmptyDir(t *testing.T) {
	st, gen, err := Recover(DirFS{Dir: t.TempDir()})
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if gen != 0 {
		t.Fatalf("gen = %d, want 0", gen)
	}
	checkAgainstScan(t, st)
	if max, _, ok := st.Max(); ok || max != 0 {
		t.Fatalf("empty max = (%d, %v), want (0, false)", max, ok)
	}
}

func TestPublishRecoverRoundTrip(t *testing.T) {
	fsys := DirFS{Dir: t.TempDir()}
	oldStore, newStore := oldAndNewStores()
	gen, err := Publish(fsys, oldStore)
	if err != nil {
		t.Fatalf("Publish gen1: %v", err)
	}
	if gen != 1 {
		t.Fatalf("gen = %d, want 1", gen)
	}
	st, gen, err := Recover(fsys)
	if err != nil {
		t.Fatalf("Recover gen1: %v", err)
	}
	if gen != 1 || !reflect.DeepEqual(st.srcs, oldStore.srcs) {
		t.Fatalf("recovered gen %d %+v, want gen 1 %+v", gen, st.srcs, oldStore.srcs)
	}
	checkAgainstScan(t, st)
	gen, err = Publish(fsys, newStore)
	if err != nil {
		t.Fatalf("Publish gen2: %v", err)
	}
	if gen != 2 {
		t.Fatalf("gen = %d, want 2", gen)
	}
	st, gen, err = Recover(fsys)
	if err != nil {
		t.Fatalf("Recover gen2: %v", err)
	}
	if gen != 2 || !reflect.DeepEqual(st.srcs, newStore.srcs) {
		t.Fatalf("recovered gen %d %+v, want gen 2 %+v", gen, st.srcs, newStore.srcs)
	}
	checkAgainstScan(t, st)
	if _, err := os.Stat(filepath.Join(fsys.Dir, treeName(1))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale tree file still present: %v", err)
	}
}

// TestRecoveryAtAllFailurePoints injects a fault at every mutating step
// of a publish and checks that recovery always yields either the complete
// old generation or the complete new one, with segments, totals and
// per-segment max evidence matching the brute-force scan.
func TestRecoveryAtAllFailurePoints(t *testing.T) {
	oldStore, newStore := oldAndNewStores()
	totalOps := 0
	{
		fsys := DirFS{Dir: t.TempDir()}
		if _, err := Publish(fsys, oldStore); err != nil {
			t.Fatalf("setup publish: %v", err)
		}
		counter := &faultFS{inner: fsys, failAt: -1}
		if _, err := Publish(counter, newStore); err != nil {
			t.Fatalf("counting publish: %v", err)
		}
		totalOps = counter.ops
	}
	if totalOps == 0 {
		t.Fatal("publish performed no mutating operations")
	}
	for k := 0; k < totalOps; k++ {
		t.Run(fmt.Sprintf("fail-at-%d", k), func(t *testing.T) {
			fsys := DirFS{Dir: t.TempDir()}
			if _, err := Publish(fsys, oldStore); err != nil {
				t.Fatalf("setup publish: %v", err)
			}
			faulty := &faultFS{inner: fsys, failAt: k}
			if _, err := Publish(faulty, newStore); !errors.Is(err, errInjected) {
				t.Fatalf("Publish error = %v, want %v", err, errInjected)
			}
			st, gen, err := Recover(fsys)
			if err != nil {
				t.Fatalf("Recover: %v", err)
			}
			var want *Store
			switch gen {
			case 1:
				want = oldStore
			case 2:
				want = newStore
			default:
				t.Fatalf("recovered unexpected generation %d", gen)
			}
			if !reflect.DeepEqual(st.srcs, want.srcs) {
				t.Fatalf("recovered mixed tree at gen %d:\n got %+v\nwant %+v", gen, st.srcs, want.srcs)
			}
			checkAgainstScan(t, st)
		})
	}
	t.Run("no-fault", func(t *testing.T) {
		fsys := DirFS{Dir: t.TempDir()}
		if _, err := Publish(fsys, oldStore); err != nil {
			t.Fatalf("setup publish: %v", err)
		}
		counter := &faultFS{inner: fsys, failAt: -1}
		if _, err := Publish(counter, newStore); err != nil {
			t.Fatalf("Publish: %v", err)
		}
		st, gen, err := Recover(fsys)
		if err != nil {
			t.Fatalf("Recover: %v", err)
		}
		if gen != 2 || !reflect.DeepEqual(st.srcs, newStore.srcs) {
			t.Fatalf("recovered gen %d, want gen 2 new store", gen)
		}
		checkAgainstScan(t, st)
	})
}

func TestRecoverRejectsCorruption(t *testing.T) {
	t.Run("corrupt-root", func(t *testing.T) {
		fsys := DirFS{Dir: t.TempDir()}
		if err := os.WriteFile(filepath.Join(fsys.Dir, rootFile), []byte("{not json"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Recover(fsys); err == nil {
			t.Fatal("Recover succeeded on corrupt root")
		}
	})
	t.Run("corrupt-tree", func(t *testing.T) {
		fsys := DirFS{Dir: t.TempDir()}
		st := NewStore()
		st.Add("a", Interval{L: 0, R: 3, W: 1})
		if _, err := Publish(fsys, st); err != nil {
			t.Fatalf("Publish: %v", err)
		}
		if err := os.WriteFile(filepath.Join(fsys.Dir, treeName(1)), []byte("tampered"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Recover(fsys); err == nil {
			t.Fatal("Recover succeeded on checksum mismatch")
		}
	})
	t.Run("missing-tree", func(t *testing.T) {
		fsys := DirFS{Dir: t.TempDir()}
		st := NewStore()
		st.Add("a", Interval{L: 0, R: 3, W: 1})
		if _, err := Publish(fsys, st); err != nil {
			t.Fatalf("Publish: %v", err)
		}
		if err := os.Remove(filepath.Join(fsys.Dir, treeName(1))); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Recover(fsys); err == nil {
			t.Fatal("Recover succeeded with missing tree")
		}
	})
}
