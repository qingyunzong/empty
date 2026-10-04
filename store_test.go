package trend

import (
	"errors"
	"testing"
)

func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(newDirFS(dir))
	if err != nil {
		t.Fatal(err)
	}
	batches := []Batch{
		{Corrections: []Correction{
			{From: 0, To: 10, Samples: []Sample{{0, 1}, {3, 9}, {6, 2}, {9, 4}}},
		}},
		{Corrections: []Correction{
			{From: 2, To: 7, Samples: []Sample{{2, 5}, {5, 5}}},
		}},
	}
	for _, b := range batches {
		if _, err := s.Publish(b); err != nil {
			t.Fatal(err)
		}
	}
	if s.Version() != 2 {
		t.Fatalf("version = %d, want 2", s.Version())
	}
	// Reopen and verify the rebuilt index matches the live one.
	re, err := OpenStore(newDirFS(dir))
	if err != nil {
		t.Fatal(err)
	}
	if re.Version() != 2 {
		t.Fatalf("recovered version = %d, want 2", re.Version())
	}
	for v := 0; v <= 2; v++ {
		for from := int64(0); from <= 10; from++ {
			for to := from; to <= 10; to++ {
				got, err := re.Index.Query(v, from, to)
				if err != nil {
					t.Fatal(err)
				}
				want, err := s.Index.Query(v, from, to)
				if err != nil {
					t.Fatal(err)
				}
				if !got.Equal(want) {
					t.Fatalf("v=%d [%d,%d]: recovered %v != live %v", v, from, to, got, want)
				}
			}
		}
	}
}

var errCrash = errors.New("simulated crash")

// crashFS wraps dirFS and dies after a fixed number of mutating operations.
// A write that is interrupted persists only a torn prefix, simulating power
// loss mid-write.
type crashFS struct {
	inner   *dirFS
	limit   int
	ops     int
	crashed bool
}

func (c *crashFS) tick() {
	c.ops++
	if c.ops > c.limit {
		c.crashed = true
	}
}

func (c *crashFS) WriteFile(name string, data []byte) error {
	if c.crashed {
		return errCrash
	}
	c.tick()
	if c.crashed {
		c.inner.WriteFile(name, data[:len(data)/2]) // torn write
		return errCrash
	}
	return c.inner.WriteFile(name, data)
}

func (c *crashFS) Rename(old, new string) error {
	if c.crashed {
		return errCrash
	}
	c.tick()
	if c.crashed {
		return errCrash
	}
	return c.inner.Rename(old, new)
}

func (c *crashFS) ReadFile(name string) ([]byte, error) {
	if c.crashed {
		return nil, errCrash
	}
	return c.inner.ReadFile(name)
}

func (c *crashFS) Remove(name string) error {
	if c.crashed {
		return errCrash
	}
	c.tick()
	if c.crashed {
		return errCrash
	}
	return c.inner.Remove(name)
}

func (c *crashFS) List() ([]string, error) {
	if c.crashed {
		return nil, errCrash
	}
	return c.inner.List()
}

// TestPublishCrashAtomicity crashes a batch publish at every possible step
// and verifies recovery always yields either the old root or the new root,
// never a torn state.
func TestPublishCrashAtomicity(t *testing.T) {
	batchA := Batch{Corrections: []Correction{
		{From: 0, To: 10, Samples: []Sample{{0, 0}, {4, 8}, {9, 3}}},
	}}
	batchB := Batch{Corrections: []Correction{
		{From: 2, To: 8, Samples: []Sample{{2, 100}, {7, -5}}},
		{From: 12, To: 15, Samples: []Sample{{13, 1}}},
	}}

	// Reference models for the only two legal outcomes.
	modelA := NewModel()
	if _, err := modelA.Commit(batchA); err != nil {
		t.Fatal(err)
	}
	modelB := NewModel()
	if _, err := modelB.Commit(batchA); err != nil {
		t.Fatal(err)
	}
	if _, err := modelB.Commit(batchB); err != nil {
		t.Fatal(err)
	}

	for crashAt := 0; crashAt <= 4; crashAt++ {
		t.Run("", func(t *testing.T) {
			dir := t.TempDir()
			s, err := OpenStore(newDirFS(dir))
			if err != nil {
				t.Fatal(err)
			}
			vA, err := s.Publish(batchA)
			if err != nil {
				t.Fatal(err)
			}
			// Arm the crash and attempt the batch-B publish.
			cfs := &crashFS{inner: newDirFS(dir), limit: crashAt}
			s.fs = cfs
			_, pubErr := s.Publish(batchB)
			crashed := cfs.crashed
			if crashAt < 3 && !crashed {
				t.Fatalf("crashAt=%d: expected crash", crashAt)
			}
			if crashAt >= 3 && pubErr != nil {
				t.Fatalf("crashAt=%d: unexpected publish error %v", crashAt, pubErr)
			}

			// Recover from the directory as after a power loss.
			re, err := OpenStore(newDirFS(dir))
			if err != nil {
				t.Fatalf("crashAt=%d: recovery failed: %v", crashAt, err)
			}
			if re.Version() != vA && re.Version() != vA+1 {
				t.Fatalf("crashAt=%d: recovered version %d, want %d or %d", crashAt, re.Version(), vA, vA+1)
			}
			// The whole recovered state must match exactly one model.
			ref := modelA
			if re.Version() == vA+1 {
				ref = modelB
			}
			for v := 0; v <= re.Version(); v++ {
				for from := int64(-1); from <= 16; from++ {
					for to := from; to <= 16; to++ {
						got, err := re.Index.Query(v, from, to)
						if err != nil {
							t.Fatal(err)
						}
						want, err := ref.Query(v, from, to)
						if err != nil {
							t.Fatal(err)
						}
						if !got.Equal(want) {
							t.Fatalf("crashAt=%d: torn state at v=%d [%d,%d]: %v != %v",
								crashAt, v, from, to, got, want)
						}
					}
				}
			}
			// The recovered store must accept further publishes.
			if _, err := re.Publish(Batch{Corrections: []Correction{
				{From: 0, To: 1, Samples: []Sample{{0, 42}}},
			}}); err != nil {
				t.Fatalf("crashAt=%d: publish after recovery: %v", crashAt, err)
			}
			t.Logf("crashAt=%d crashed=%v recoveredVersion=%d", crashAt, crashed, re.Version())
		})
	}
}
