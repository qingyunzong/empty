package buildcache

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// putSized writes a deterministic blob of n bytes and returns its on-disk cost.
func putSized(t *testing.T, c *Cache, path string, n int, seed byte) []byte {
	t.Helper()
	data := bytes.Repeat([]byte{seed}, n)
	if err := c.Put(path, data); err != nil {
		t.Fatalf("Put(%s): %v", path, err)
	}
	return data
}

func onDiskSize(t *testing.T, dir, path string) int64 {
	t.Helper()
	fi, err := os.Stat(filepath.Join(dir, path))
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return diskSize(fi)
}

func TestDedupCountsInodeOnce(t *testing.T) {
	dir := t.TempDir()
	c := New(dir, 1<<30)

	data := putSized(t, c, "a/out.bin", 5000, 0xAA)
	one := c.Usage()
	if want := onDiskSize(t, dir, "a/out.bin"); one != want {
		t.Fatalf("usage after first put = %d, want %d", one, want)
	}

	// Same content at a second path: hard-linked, charged zero extra.
	if err := c.Put("b/copy.bin", data); err != nil {
		t.Fatalf("Put copy: %v", err)
	}
	if got := c.Usage(); got != one {
		t.Fatalf("usage after dedup put = %d, want unchanged %d", got, one)
	}

	// Explicit link of a tracked path is also free.
	if err := c.Link("a/out.bin", "c/link.bin"); err != nil {
		t.Fatalf("Link: %v", err)
	}
	if got := c.Usage(); got != one {
		t.Fatalf("usage after link = %d, want unchanged %d", got, one)
	}

	// Distinct content adds its own inode cost.
	putSized(t, c, "d/other.bin", 5000, 0xBB)
	if got, want := c.Usage(), one+onDiskSize(t, dir, "d/other.bin"); got != want {
		t.Fatalf("usage after distinct put = %d, want %d", got, want)
	}
}

func TestBudgetReleasedOnlyWhenLastLinkRemoved(t *testing.T) {
	dir := t.TempDir()
	c := New(dir, 1<<30)

	putSized(t, c, "x", 9000, 0x01)
	if err := c.Link("x", "y"); err != nil {
		t.Fatalf("Link: %v", err)
	}
	before := c.Usage()

	if err := c.Remove("x"); err != nil {
		t.Fatalf("Remove x: %v", err)
	}
	if got := c.Usage(); got != before {
		t.Fatalf("usage after removing one of two links = %d, want %d", got, before)
	}
	if _, err := os.Stat(filepath.Join(dir, "y")); err != nil {
		t.Fatalf("remaining link y should survive: %v", err)
	}

	if err := c.Remove("y"); err != nil {
		t.Fatalf("Remove y: %v", err)
	}
	if got := c.Usage(); got != 0 {
		t.Fatalf("usage after last link removed = %d, want 0", got)
	}
}

func TestEvictionOrderAndLeaseProtection(t *testing.T) {
	dir := t.TempDir()
	c := New(dir, 0) // zero budget: everything evictable must go

	putSized(t, c, "first", 100, 0x01)
	putSized(t, c, "second", 100, 0x02)
	putSized(t, c, "third", 100, 0x03)

	// Lease the coldest path; eviction must skip it and take the next.
	if err := c.Acquire("first"); err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	evicted, err := c.Evict()
	if err != nil {
		t.Fatalf("Evict: %v", err)
	}
	want := []string{"second", "third"}
	if !reflect.DeepEqual(evicted, want) {
		t.Fatalf("eviction order = %v, want %v", evicted, want)
	}
	if _, err := os.Stat(filepath.Join(dir, "first")); err != nil {
		t.Fatalf("leased path must survive eviction: %v", err)
	}
	if got := c.Usage(); got == 0 {
		t.Fatalf("leased inode must remain charged")
	}

	// After release, the survivor becomes evictable.
	if err := c.Release("first"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	evicted, err = c.Evict()
	if err != nil {
		t.Fatalf("Evict: %v", err)
	}
	if !reflect.DeepEqual(evicted, []string{"first"}) {
		t.Fatalf("second eviction = %v, want [first]", evicted)
	}
	if got := c.Usage(); got != 0 {
		t.Fatalf("usage after full eviction = %d, want 0", got)
	}
}

func TestEvictionPartialLinksReleaseOrder(t *testing.T) {
	dir := t.TempDir()
	c := New(dir, 0)

	putSized(t, c, "hot", 8000, 0x07)
	if err := c.Link("hot", "hot-alias"); err != nil {
		t.Fatalf("Link: %v", err)
	}
	putSized(t, c, "cold", 8000, 0x08)
	full := c.Usage()

	// Lease one alias of "hot": eviction deletes only the unleased alias,
	// and the inode budget stays charged until the leased link goes away.
	if err := c.Acquire("hot"); err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	evicted, err := c.Evict()
	if err != nil {
		t.Fatalf("Evict: %v", err)
	}
	if !reflect.DeepEqual(evicted, []string{"cold", "hot-alias"}) {
		t.Fatalf("evicted = %v, want [cold hot-alias]", evicted)
	}
	hotCost := onDiskSize(t, dir, "hot")
	if got := c.Usage(); got != hotCost {
		t.Fatalf("usage = %d, want %d (leased hot inode still charged, was %d)", got, hotCost, full)
	}
}

func TestRecoverIgnoresTempAndFoldsInodes(t *testing.T) {
	dir := t.TempDir()
	c := New(dir, 1<<30)

	data := putSized(t, c, "obj/one", 6000, 0x0A)
	if err := c.Put("obj/two", data); err != nil { // dedup hard link
		t.Fatalf("Put two: %v", err)
	}
	putSized(t, c, "obj/three", 6000, 0x0B)
	wantUsage := c.Usage()
	wantPaths := c.Paths()

	// Plant an interrupted write; recovery must ignore it.
	if err := os.WriteFile(filepath.Join(dir, "obj", "partial"+tempMarker+"999"), []byte("junk"), 0o644); err != nil {
		t.Fatalf("plant temp: %v", err)
	}

	got, err := Open(dir, 1<<30)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got.Usage() != wantUsage {
		t.Fatalf("recovered usage = %d, want %d", got.Usage(), wantUsage)
	}
	if !reflect.DeepEqual(got.Paths(), wantPaths) {
		t.Fatalf("recovered paths = %v, want %v", got.Paths(), wantPaths)
	}

	// Recovered cache still dedups against the folded inode.
	if err := got.Put("obj/four", data); err != nil {
		t.Fatalf("Put four: %v", err)
	}
	if got.Usage() != wantUsage {
		t.Fatalf("usage after dedup on recovered cache = %d, want %d", got.Usage(), wantUsage)
	}
}

func TestLeaseBalanceErrors(t *testing.T) {
	c := New(t.TempDir(), 1<<30)
	putSized(t, c, "p", 10, 0x01)
	if err := c.Release("p"); err == nil {
		t.Fatal("Release without Acquire must fail")
	}
	if err := c.Acquire("missing"); err == nil {
		t.Fatal("Acquire on untracked path must fail")
	}
	if err := c.Remove("missing"); err == nil {
		t.Fatal("Remove on untracked path must fail")
	}
}
