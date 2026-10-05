package buildcache

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func writeFile(t *testing.T, path string, size int) {
	t.Helper()
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestInodeChargedOnceForManyPaths(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	a := filepath.Join(dir, "a")
	writeFile(t, a, 100)
	if err := c.Add(a); err != nil {
		t.Fatal(err)
	}
	if got := c.Used(); got != 100 {
		t.Fatalf("Used after first add = %d, want 100", got)
	}
	// Hard links to the same inode must not be charged again.
	b := filepath.Join(dir, "b")
	d := filepath.Join(dir, "sub", "d")
	if err := os.MkdirAll(filepath.Dir(d), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{b, d} {
		if err := os.Link(a, p); err != nil {
			t.Fatal(err)
		}
		if err := c.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if got := c.Used(); got != 100 {
		t.Fatalf("Used after links = %d, want 100", got)
	}
	if got := c.Entries(); got != 1 {
		t.Fatalf("Entries = %d, want 1", got)
	}
}

func TestBudgetReleasedOnlyWhenLastLinkDisappears(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	writeFile(t, a, 100)
	if err := os.Link(a, b); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{a, b} {
		if err := c.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Unlink(a); err != nil {
		t.Fatal(err)
	}
	if got := c.Used(); got != 100 {
		t.Fatalf("Used with one link left = %d, want 100", got)
	}
	if err := c.Unlink(b); err != nil {
		t.Fatal(err)
	}
	if got := c.Used(); got != 0 {
		t.Fatalf("Used after last link gone = %d, want 0", got)
	}
	if got := c.Entries(); got != 0 {
		t.Fatalf("Entries = %d, want 0", got)
	}
}

func TestEvictionOrderAndLeases(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir, 100)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{"a", "b", "c"}
	for _, n := range names {
		p := filepath.Join(dir, n)
		writeFile(t, p, 100)
		if err := c.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	// Lease the oldest entry: eviction must skip it and take b, c instead.
	if err := c.AcquireLease(filepath.Join(dir, "a")); err != nil {
		t.Fatal(err)
	}
	got := c.Evict()
	want := []string{filepath.Join(dir, "b"), filepath.Join(dir, "c")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("eviction order = %v, want %v", got, want)
	}
	if !c.Tracked(filepath.Join(dir, "a")) {
		t.Fatal("leased path was evicted")
	}
	if got := c.Used(); got != 100 {
		t.Fatalf("Used after eviction = %d, want 100", got)
	}
}

func TestEvictionKeepsLeasedLinkOfSharedInode(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir, 0) // everything is over budget
	if err != nil {
		t.Fatal(err)
	}
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	writeFile(t, a, 100)
	if err := os.Link(a, b); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{a, b} {
		if err := c.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.AcquireLease(b); err != nil {
		t.Fatal(err)
	}
	got := c.Evict()
	want := []string{a} // only the lease-free path is removed
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("eviction order = %v, want %v", got, want)
	}
	// Budget is not released: the leased link keeps the inode alive.
	if got := c.Used(); got != 100 {
		t.Fatalf("Used = %d, want 100 (inode still linked)", got)
	}
	if _, err := os.Stat(b); err != nil {
		t.Fatalf("leased path missing: %v", err)
	}
}

func TestRecoverIgnoresIncompleteTempFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "done"), 100)
	writeFile(t, filepath.Join(dir, "partial.tmp"), 50)
	writeFile(t, filepath.Join(dir, "other.tmp"), 50)
	c, err := New(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Recover(); err != nil {
		t.Fatal(err)
	}
	if got := c.Used(); got != 100 {
		t.Fatalf("Used after recover = %d, want 100 (temp files ignored)", got)
	}
	if c.Tracked(filepath.Join(dir, "partial.tmp")) {
		t.Fatal("temp file tracked after recover")
	}
}

func TestRandomLinkLeaseHistoryMatchesFullScan(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(42))
	var live []string
	counter := 0

	existing := func() []string {
		var out []string
		for _, p := range live {
			if _, err := os.Stat(p); err == nil {
				out = append(out, p)
			}
		}
		live = out
		return out
	}

	for step := 0; step < 2000; step++ {
		paths := existing()
		switch rng.Intn(6) {
		case 0: // create a fresh file
			p := filepath.Join(dir, fmt.Sprintf("f%04d", counter))
			counter++
			writeFile(t, p, 1+rng.Intn(512))
			if err := c.Add(p); err != nil {
				t.Fatal(err)
			}
			live = append(live, p)
		case 1: // hard-link an existing file under a new path
			if len(paths) > 0 {
				src := paths[rng.Intn(len(paths))]
				p := filepath.Join(dir, fmt.Sprintf("f%04d", counter))
				counter++
				if err := os.Link(src, p); err != nil {
					t.Fatal(err)
				}
				if err := c.Add(p); err != nil {
					t.Fatal(err)
				}
				live = append(live, p)
			}
		case 2: // acquire a lease
			if len(paths) > 0 {
				_ = c.AcquireLease(paths[rng.Intn(len(paths))])
			}
		case 3: // release a lease
			if len(paths) > 0 {
				_ = c.ReleaseLease(paths[rng.Intn(len(paths))])
			}
		case 4: // evict down to a random budget
			c.budget = int64(rng.Intn(4096))
			c.Evict()
		case 5: // unlink a random path
			if len(paths) > 0 {
				_ = c.Unlink(paths[rng.Intn(len(paths))])
			}
		}
		if used, full := c.Used(), c.FullScan(); used != full {
			t.Fatalf("step %d: incremental Used = %d, full scan = %d", step, used, full)
		}
	}

	// Recovery after the random history must reproduce the same state.
	if err := c.Recover(); err != nil {
		t.Fatal(err)
	}
	if used, full := c.Used(), c.FullScan(); used != full {
		t.Fatalf("after recover: Used = %d, full scan = %d", used, full)
	}
}

func TestEvictionOrderIsDeterministicLRU(t *testing.T) {
	dir := t.TempDir()
	c, err := New(dir, 100)
	if err != nil {
		t.Fatal(err)
	}
	var added []string
	for _, n := range []string{"a", "b", "c"} {
		p := filepath.Join(dir, n)
		writeFile(t, p, 100)
		if err := c.Add(p); err != nil {
			t.Fatal(err)
		}
		added = append(added, p)
	}
	// Touch "a" so "b" becomes the LRU entry.
	if err := c.Add(added[0]); err != nil {
		t.Fatal(err)
	}
	got := c.Evict()
	want := []string{added[1], added[2]}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("eviction order = %v, want %v", got, want)
	}
}

func TestFullScanCountsSharedInodeOnce(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a")
	writeFile(t, a, 100)
	links := []string{"b", "c", "d"}
	for _, n := range links {
		if err := os.Link(a, filepath.Join(dir, n)); err != nil {
			t.Fatal(err)
		}
	}
	c, err := New(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.FullScan(); got != 100 {
		t.Fatalf("FullScan = %d, want 100", got)
	}
	if err := c.Recover(); err != nil {
		t.Fatal(err)
	}
	var paths []string
	for p := range c.paths {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	if len(paths) != 4 {
		t.Fatalf("tracked paths after recover = %v, want 4 links", paths)
	}
}
