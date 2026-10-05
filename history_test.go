package buildcache

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"
)

// fullScan walks the cache directory, ignores temp files, and returns the
// set of real paths plus the per-inode disk cost charged exactly once.
func fullScan(t *testing.T, dir string) (map[string]uint64, int64) {
	t.Helper()
	paths := make(map[string]uint64)
	seen := make(map[uint64]bool)
	var usage int64
	err := filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.IsDir() || !fi.Mode().IsRegular() || isTempName(fi.Name()) {
			return nil
		}
		ino, err := inodeOf(fi)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		paths[filepath.ToSlash(rel)] = ino
		if !seen[ino] {
			seen[ino] = true
			usage += diskSize(fi)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("full scan: %v", err)
	}
	return paths, usage
}

// crossCheck asserts the cache's in-memory accounting matches a full scan
// of the directory, and that every leased path is still on disk.
func crossCheck(t *testing.T, c *Cache, dir string) {
	t.Helper()
	diskPaths, diskUsage := fullScan(t, dir)

	if got := c.Usage(); got != diskUsage {
		t.Fatalf("cache usage %d != full-scan usage %d", got, diskUsage)
	}

	indexPaths := c.Paths()
	if len(indexPaths) != len(diskPaths) {
		t.Fatalf("index tracks %d paths, disk has %d", len(indexPaths), len(diskPaths))
	}
	for _, p := range indexPaths {
		if _, ok := diskPaths[p]; !ok {
			t.Fatalf("indexed path %q missing on disk", p)
		}
	}
	for p := range diskPaths {
		if !contains(indexPaths, p) {
			t.Fatalf("disk path %q missing from index", p)
		}
	}

	// Every indexed path must resolve to the inode of its entry's siblings:
	// all paths of one entry share one inode on disk.
	c.mu.Lock()
	leased := make(map[string]bool, len(c.leases))
	for p, n := range c.leases {
		if n > 0 {
			leased[p] = true
		}
	}
	entries := make([]*entry, 0, len(c.entries))
	for _, e := range c.entries {
		entries = append(entries, e)
	}
	c.mu.Unlock()

	for _, e := range entries {
		for p := range e.paths {
			if diskPaths[p] != e.ino {
				t.Fatalf("path %q has inode %d on disk, entry says %d", p, diskPaths[p], e.ino)
			}
		}
	}
	for p := range leased {
		if _, ok := diskPaths[p]; !ok {
			t.Fatalf("leased path %q vanished from disk", p)
		}
	}
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// TestRandomHistoryCrossCheck replays randomized put/link/remove/lease/
// evict histories and cross-checks in-memory accounting against full disk
// scans, including across a recovery boundary.
func TestRandomHistoryCrossCheck(t *testing.T) {
	seeds := []int64{1, 7, 42, 20261005}
	for _, seed := range seeds {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runRandomHistory(t, seed)
		})
	}
}

func runRandomHistory(t *testing.T, seed int64) {
	dir := t.TempDir()
	rng := rand.New(rand.NewSource(seed))

	// Small content pool forces frequent dedup; sizes cross block boundaries.
	var contents [][]byte
	for i := 0; i < 6; i++ {
		n := 1 + rng.Intn(12000)
		b := make([]byte, n)
		rng.Read(b)
		contents = append(contents, b)
	}
	pathPool := make([]string, 0, 24)
	for i := 0; i < 24; i++ {
		pathPool = append(pathPool, fmt.Sprintf("d%d/f%d.bin", i%4, i))
	}

	// Tight budget so eviction fires regularly.
	c := New(dir, 4*4096)
	heldLeases := make(map[string]int)

	// livePaths mirrors the index to pick valid operation targets.
	livePaths := func() []string { return c.Paths() }

	for step := 0; step < 400; step++ {
		paths := livePaths()
		op := rng.Intn(100)
		switch {
		case op < 35: // put, sometimes duplicate content
			p := pathPool[rng.Intn(len(pathPool))]
			data := contents[rng.Intn(len(contents))]
			if heldLeases[p] > 0 {
				continue // replacing a leased path would surprise callers
			}
			if err := c.Put(p, data); err != nil {
				t.Fatalf("step %d Put(%s): %v", step, p, err)
			}
		case op < 50 && len(paths) > 0: // hard link
			src := paths[rng.Intn(len(paths))]
			dst := pathPool[rng.Intn(len(pathPool))]
			if dst == src || heldLeases[dst] > 0 {
				continue
			}
			if err := c.Link(src, dst); err != nil {
				t.Fatalf("step %d Link(%s,%s): %v", step, src, dst, err)
			}
		case op < 60 && len(paths) > 0: // remove
			p := paths[rng.Intn(len(paths))]
			if heldLeases[p] > 0 {
				continue
			}
			if err := c.Remove(p); err != nil {
				t.Fatalf("step %d Remove(%s): %v", step, p, err)
			}
		case op < 75 && len(paths) > 0: // acquire
			p := paths[rng.Intn(len(paths))]
			if err := c.Acquire(p); err != nil {
				t.Fatalf("step %d Acquire(%s): %v", step, p, err)
			}
			heldLeases[p]++
		case op < 85: // release
			var held []string
			for p, n := range heldLeases {
				if n > 0 {
					held = append(held, p)
				}
			}
			if len(held) == 0 {
				continue
			}
			sort.Strings(held)
			p := held[rng.Intn(len(held))]
			if err := c.Release(p); err != nil {
				t.Fatalf("step %d Release(%s): %v", step, p, err)
			}
			heldLeases[p]--
		default: // evict, then verify no leased path was touched
			evicted, err := c.Evict()
			if err != nil {
				t.Fatalf("step %d Evict: %v", step, err)
			}
			for _, p := range evicted {
				if heldLeases[p] > 0 {
					t.Fatalf("step %d: evicted leased path %q", step, p)
				}
			}
			// Eviction may stall only when every live path is leased.
			if len(evicted) == 0 && c.Usage() > c.Budget() {
				for _, p := range c.Paths() {
					if heldLeases[p] == 0 {
						t.Fatalf("step %d: unleased path %q survived stalled eviction", step, p)
					}
				}
			}
		}

		if step%40 == 0 {
			crossCheck(t, c, dir)
		}
	}
	crossCheck(t, c, dir)

	// Recovery boundary: a full rescan must reproduce identical accounting.
	if err := os.WriteFile(filepath.Join(dir, "stale"+tempMarker+"1"), []byte("partial"), 0o644); err != nil {
		t.Fatalf("plant temp: %v", err)
	}
	recovered, err := Open(dir, c.Budget())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if recovered.Usage() != c.Usage() {
		t.Fatalf("recovered usage %d != pre-recovery %d", recovered.Usage(), c.Usage())
	}
	if !slices.Equal(recovered.Paths(), c.Paths()) {
		t.Fatalf("recovered paths %v != %v", recovered.Paths(), c.Paths())
	}
	crossCheck(t, recovered, dir)
}
