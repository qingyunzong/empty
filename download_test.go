package leasequota

import (
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

var errInjected = errors.New("injected commit failure")

func newTempStore(t *testing.T, total int64) (*Store, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "store")
	s, err := NewStore(dir, NewQuota(total))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s, dir
}

func writeAll(t *testing.T, d *Download, n int64) {
	t.Helper()
	written, err := d.Write(make([]byte, n))
	if err != nil {
		t.Fatalf("Write(%d): %v", n, err)
	}
	if int64(written) != n {
		t.Fatalf("Write(%d) wrote %d bytes", n, written)
	}
}

func dirEntries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestDownloadCommitShortWrite(t *testing.T) {
	s, dir := newTempStore(t, 1<<20)

	d, err := s.Start("a.bin", 4096)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Short write: only 1000 of the declared 4096 bytes arrive.
	writeAll(t, d, 1000)
	if err := d.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	assertCounters(t, s.Quota(), 1000, 0)
	fi, err := os.Stat(filepath.Join(dir, "a.bin"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if fi.Size() != 1000 {
		t.Fatalf("file size = %d, want 1000", fi.Size())
	}
	if size, ok := s.Size("a.bin"); !ok || size != 1000 {
		t.Fatalf("store.Size = %d, %v; want 1000, true", size, ok)
	}
}

func TestDownloadCancelReturnsReservation(t *testing.T) {
	s, dir := newTempStore(t, 1<<20)

	d, err := s.Start("b.bin", 4096)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	writeAll(t, d, 1000)
	assertCounters(t, s.Quota(), 0, 4096)

	if err := d.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	assertCounters(t, s.Quota(), 0, 0)
	if names := dirEntries(t, dir); len(names) != 0 {
		t.Fatalf("store dir not empty after cancel: %v", names)
	}
}

func TestDownloadCommitFailureReturnsReservation(t *testing.T) {
	s, dir := newTempStore(t, 1<<20)

	hooks := &Hooks{BeforeCommit: func(name string) error { return errInjected }}
	d, err := s.Start("c.bin", 4096, hooks)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	writeAll(t, d, 500)

	err = d.Commit()
	if !errors.Is(err, errInjected) {
		t.Fatalf("Commit error = %v, want injected failure", err)
	}
	// The full reservation (not just the written part) is returned.
	assertCounters(t, s.Quota(), 0, 0)
	if names := dirEntries(t, dir); len(names) != 0 {
		t.Fatalf("store dir not empty after failed commit: %v", names)
	}
	// A failed commit finishes the download; cancel is no longer possible.
	if err := d.Cancel(); err == nil {
		t.Fatal("Cancel after failed Commit succeeded, want error")
	}
	assertCounters(t, s.Quota(), 0, 0)
}

func TestDownloadCancelAfterCommitFails(t *testing.T) {
	s, dir := newTempStore(t, 1<<20)

	d, err := s.Start("d.bin", 2000)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	writeAll(t, d, 2000)
	if err := d.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	assertCounters(t, s.Quota(), 2000, 0)

	// Committed quota became used and cannot be cancelled any more.
	if err := d.Cancel(); err == nil {
		t.Fatal("Cancel after Commit succeeded, want error")
	}
	if err := d.Commit(); err == nil {
		t.Fatal("second Commit succeeded, want error")
	}
	assertCounters(t, s.Quota(), 2000, 0)
	if _, err := os.Stat(filepath.Join(dir, "d.bin")); err != nil {
		t.Fatalf("committed file missing: %v", err)
	}
}

func TestDownloadLengthGrowsWithinQuota(t *testing.T) {
	s, dir := newTempStore(t, 1000)

	d, err := s.Start("g.bin", 100)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// The source delivers 300 bytes although it declared 100.
	writeAll(t, d, 300)
	if err := d.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	assertCounters(t, s.Quota(), 300, 0)
	fi, err := os.Stat(filepath.Join(dir, "g.bin"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if fi.Size() != 300 {
		t.Fatalf("file size = %d, want 300", fi.Size())
	}
}

func TestDownloadLengthGrowsBeyondQuota(t *testing.T) {
	s, dir := newTempStore(t, 150)

	d, err := s.Start("h.bin", 100)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	_, err = d.Write(make([]byte, 300))
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("Write error = %v, want ErrQuotaExceeded", err)
	}
	// Nothing was written; cancelling returns the whole reservation.
	if err := d.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	assertCounters(t, s.Quota(), 0, 0)
	if names := dirEntries(t, dir); len(names) != 0 {
		t.Fatalf("store dir not empty: %v", names)
	}
}

func TestDownloadReservationExceedsQuota(t *testing.T) {
	s, _ := newTempStore(t, 100)
	if _, err := s.Start("big.bin", 101); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("Start error = %v, want ErrQuotaExceeded", err)
	}
	assertCounters(t, s.Quota(), 0, 0)
}

func TestDeleteFreesUsed(t *testing.T) {
	s, dir := newTempStore(t, 1<<20)

	for _, tc := range []struct {
		name string
		size int64
	}{{"x.bin", 1000}, {"y.bin", 2000}} {
		d, err := s.Start(tc.name, tc.size)
		if err != nil {
			t.Fatalf("Start(%s): %v", tc.name, err)
		}
		writeAll(t, d, tc.size)
		if err := d.Commit(); err != nil {
			t.Fatalf("Commit(%s): %v", tc.name, err)
		}
	}
	assertCounters(t, s.Quota(), 3000, 0)

	if err := s.Delete("x.bin"); err != nil {
		t.Fatalf("Delete(x.bin): %v", err)
	}
	assertCounters(t, s.Quota(), 2000, 0)
	if _, err := os.Stat(filepath.Join(dir, "x.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("x.bin still on disk: %v", err)
	}

	// Deleting again fails and changes nothing.
	if err := s.Delete("x.bin"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("second Delete error = %v, want ErrNotExist", err)
	}
	assertCounters(t, s.Quota(), 2000, 0)

	if err := s.Delete("y.bin"); err != nil {
		t.Fatalf("Delete(y.bin): %v", err)
	}
	assertCounters(t, s.Quota(), 0, 0)
}

// TestInterleavedDownloadsAndDeletes runs concurrent downloads (with random
// short writes, length growth, cancels and injected commit failures) and
// deletes against one shared quota, verifying that used+reserved <= total at
// all times and that the final accounting matches the files on disk exactly.
func TestInterleavedDownloadsAndDeletes(t *testing.T) {
	const total = 256 * 1024
	s, dir := newTempStore(t, total)

	// The test's own model of committed files.
	var mu sync.Mutex
	model := make(map[string]int64)
	var modelUsed int64

	var samplerWG, workerWG sync.WaitGroup
	stop := make(chan struct{})

	// Invariant sampler: used+reserved must never exceed the total.
	samplerWG.Add(1)
	go func() {
		defer samplerWG.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			used, reserved, tot := s.Quota().Snapshot()
			if used < 0 || reserved < 0 || used+reserved > tot {
				t.Errorf("invariant violated: used=%d reserved=%d total=%d", used, reserved, tot)
				return
			}
		}
	}()

	for w := 0; w < 8; w++ {
		workerWG.Add(1)
		go func(seed int64) {
			defer workerWG.Done()
			rng := rand.New(rand.NewSource(seed))
			for i := 0; i < 60; i++ {
				if rng.Intn(4) == 3 {
					// Delete a random committed file (if any).
					mu.Lock()
					var victim string
					for name := range model {
						victim = name
						if rng.Intn(2) == 0 {
							break
						}
					}
					if victim == "" {
						mu.Unlock()
						continue
					}
					modelUsed -= model[victim]
					delete(model, victim)
					mu.Unlock()
					if err := s.Delete(victim); err != nil {
						t.Errorf("Delete(%q): %v", victim, err)
						return
					}
					continue
				}

				// Start a download with a random declared length.
				name := fmt.Sprintf("f-%d-%d.bin", seed, i)
				expected := int64(rng.Intn(16 * 1024))
				var hooks *Hooks
				if rng.Intn(4) == 0 {
					hooks = &Hooks{BeforeCommit: func(string) error { return errInjected }}
				}
				d, err := s.Start(name, expected, hooks)
				if errors.Is(err, ErrQuotaExceeded) {
					continue
				}
				if err != nil {
					t.Errorf("Start(%q): %v", name, err)
					return
				}

				// The source delivers a short, exact or grown length.
				actual := expected
				switch rng.Intn(3) {
				case 0:
					actual = int64(rng.Intn(int(expected) + 1)) // short (or exact)
				case 2:
					actual = expected + int64(rng.Intn(8*1024)) // grown
				}
				if _, err := d.Write(make([]byte, actual)); err != nil {
					// Growth beyond quota: cancel must return everything.
					if !errors.Is(err, ErrQuotaExceeded) {
						t.Errorf("Write(%q): %v", name, err)
						return
					}
					if err := d.Cancel(); err != nil {
						t.Errorf("Cancel(%q): %v", name, err)
						return
					}
					continue
				}

				if rng.Intn(3) == 0 {
					if err := d.Cancel(); err != nil {
						t.Errorf("Cancel(%q): %v", name, err)
						return
					}
					continue
				}

				err = d.Commit()
				if hooks != nil {
					if !errors.Is(err, errInjected) {
						t.Errorf("Commit(%q) = %v, want injected failure", name, err)
						return
					}
					continue
				}
				if err != nil {
					t.Errorf("Commit(%q): %v", name, err)
					return
				}
				mu.Lock()
				model[name] = actual
				modelUsed += actual
				mu.Unlock()
			}
		}(int64(w) + 1)
	}

	workerWG.Wait()
	close(stop)
	samplerWG.Wait()

	// Final accounting: no reservations left, used matches the model.
	used, reserved, tot := s.Quota().Snapshot()
	if reserved != 0 {
		t.Fatalf("reserved = %d after all downloads finished, want 0", reserved)
	}
	mu.Lock()
	wantUsed := modelUsed
	wantFiles := make(map[string]int64, len(model))
	for name, size := range model {
		wantFiles[name] = size
	}
	mu.Unlock()
	if used != wantUsed {
		t.Fatalf("used = %d, want %d (model)", used, wantUsed)
	}
	if used+reserved > tot {
		t.Fatalf("invariant violated at end: used=%d reserved=%d total=%d", used, reserved, tot)
	}

	// The store's view matches the model.
	for _, name := range s.Files() {
		size, ok := s.Size(name)
		if !ok {
			t.Fatalf("store lost track of %q", name)
		}
		if want, ok := wantFiles[name]; !ok {
			t.Fatalf("store has unexpected file %q", name)
		} else if want != size {
			t.Fatalf("store size of %q = %d, want %d", name, size, want)
		}
		delete(wantFiles, name)
	}
	for name := range wantFiles {
		t.Fatalf("store is missing committed file %q", name)
	}

	// The disk matches the model: every committed file exists with the right
	// size and no temp files are left behind.
	onDisk := make(map[string]int64)
	for _, name := range dirEntries(t, dir) {
		if strings.HasPrefix(name, ".tmp-") {
			t.Fatalf("leftover temp file %q", name)
		}
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("Stat(%q): %v", name, err)
		}
		onDisk[name] = fi.Size()
	}
	mu.Lock()
	if len(onDisk) != len(model) {
		t.Fatalf("disk has %d files, model has %d", len(onDisk), len(model))
	}
	for name, size := range model {
		if got, ok := onDisk[name]; !ok || got != size {
			t.Fatalf("disk file %q = %d, %v; want %d", name, got, ok, size)
		}
	}
	mu.Unlock()
}
