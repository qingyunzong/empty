// Package buildcache implements a content-deduplicating build cache whose
// disk budget is accounted per inode: multiple paths (hard links) pointing
// at the same content are charged only once. Eviction removes only paths
// that hold no lease, and the budget for an inode is released only when its
// last link disappears.
package buildcache

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
)

// tempMarker marks in-flight atomic writes. Recovery scans ignore any file
// whose name contains it, so a crash mid-write never leaks into the index.
const tempMarker = ".tmp-"

// ErrNotFound is returned when an operation names an untracked path.
var ErrNotFound = errors.New("buildcache: path not tracked")

// ErrLeaseBalance is returned when a lease is released more than acquired.
var ErrLeaseBalance = errors.New("buildcache: lease released without acquire")

type entry struct {
	ino        uint64
	hash       [sha256.Size]byte
	size       int64 // disk cost, charged once regardless of link count
	paths      map[string]struct{}
	lastAccess uint64
}

// Cache is a build cache rooted at a directory. It is safe for concurrent
// use; all accounting is protected by a single mutex.
type Cache struct {
	dir    string
	budget int64

	mu      sync.Mutex
	entries map[uint64]*entry // inode -> entry
	byPath  map[string]*entry
	byHash  map[[sha256.Size]byte]*entry
	leases  map[string]int
	usage   int64
	clock   uint64
}

// New creates an empty cache rooted at dir with the given disk budget in
// bytes. Existing on-disk state is not adopted; use Open for recovery.
func New(dir string, budget int64) *Cache {
	return &Cache{
		dir:     dir,
		budget:  budget,
		entries: make(map[uint64]*entry),
		byPath:  make(map[string]*entry),
		byHash:  make(map[[sha256.Size]byte]*entry),
		leases:  make(map[string]int),
	}
}

// Usage reports the current disk charge: each live inode counted once.
func (c *Cache) Usage() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.usage
}

// Budget returns the configured disk budget.
func (c *Cache) Budget() int64 { return c.budget }

// Paths returns the sorted list of tracked paths.
func (c *Cache) Paths() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.byPath))
	for p := range c.byPath {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// Leased reports whether path currently holds at least one lease.
func (c *Cache) Leased(path string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.leases[path] > 0
}

func (c *Cache) abs(path string) string { return filepath.Join(c.dir, path) }

func isTempName(name string) bool { return strings.Contains(name, tempMarker) }

// diskSize reports the allocated disk cost of a file, falling back to the
// logical size when the filesystem reports no blocks (e.g. empty files).
func diskSize(fi os.FileInfo) int64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && st.Blocks > 0 {
		return st.Blocks * 512
	}
	return fi.Size()
}

func inodeOf(fi os.FileInfo) (uint64, error) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("buildcache: cannot determine inode of %s", fi.Name())
	}
	return st.Ino, nil
}

func (c *Cache) touch(e *entry) {
	c.clock++
	e.lastAccess = c.clock
}

// writeTempAtomically writes data to a temp sibling of dst and renames it
// into place. The temp name carries tempMarker so recovery ignores it.
func writeTempAtomically(dir, dst string, data []byte) (string, error) {
	tmp := filepath.Join(dir, fmt.Sprintf("%s%s%d", filepath.Base(dst), tempMarker, rand.Uint64()))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return dst, nil
}

// linkTempAtomically hard-links src onto a temp sibling of dst and renames
// it into place, so dst never appears half-linked.
func linkTempAtomically(dir, src, dst string) error {
	tmp := filepath.Join(dir, fmt.Sprintf("%s%s%d", filepath.Base(dst), tempMarker, rand.Uint64()))
	if err := os.Link(src, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// register adds path to the index under the given inode, charging the inode
// size the first time it is seen. Must be called with c.mu held.
func (c *Cache) register(path string, hash [sha256.Size]byte, fi os.FileInfo) error {
	ino, err := inodeOf(fi)
	if err != nil {
		return err
	}
	e, ok := c.entries[ino]
	if !ok {
		e = &entry{ino: ino, hash: hash, size: diskSize(fi), paths: make(map[string]struct{})}
		c.entries[ino] = e
		c.byHash[hash] = e
		c.usage += e.size
	}
	e.paths[path] = struct{}{}
	c.byPath[path] = e
	c.touch(e)
	return nil
}

// deregister removes path from the index, releasing the inode's budget when
// its last link disappears. Must be called with c.mu held.
func (c *Cache) deregister(path string) {
	e, ok := c.byPath[path]
	if !ok {
		return
	}
	delete(e.paths, path)
	delete(c.byPath, path)
	if len(e.paths) == 0 {
		delete(c.entries, e.ino)
		delete(c.byHash, e.hash)
		c.usage -= e.size
	}
}

// Put stores data at path. If identical content is already cached, path
// becomes a hard link to the existing inode and costs no extra budget.
// Writing to an already-tracked path replaces it.
func (c *Cache) Put(path string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, ok := c.byPath[path]; ok {
		if err := c.removeLocked(path); err != nil {
			return err
		}
	}

	hash := sha256.Sum256(data)
	dst := c.abs(path)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}

	if e, ok := c.byHash[hash]; ok {
		var src string
		for p := range e.paths {
			src = p
			break
		}
		if err := linkTempAtomically(filepath.Dir(dst), c.abs(src), dst); err != nil {
			return err
		}
	} else if _, err := writeTempAtomically(filepath.Dir(dst), dst, data); err != nil {
		return err
	}

	fi, err := os.Stat(dst)
	if err != nil {
		return err
	}
	return c.register(path, hash, fi)
}

// Link adds dst as an additional hard link to the inode behind src, which
// must already be tracked. No extra budget is charged.
func (c *Cache) Link(src, dst string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	e, ok := c.byPath[src]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, src)
	}
	if _, ok := c.byPath[dst]; ok {
		if err := c.removeLocked(dst); err != nil {
			return err
		}
	}
	absDst := c.abs(dst)
	if err := os.MkdirAll(filepath.Dir(absDst), 0o755); err != nil {
		return err
	}
	if err := linkTempAtomically(filepath.Dir(absDst), c.abs(src), absDst); err != nil {
		return err
	}
	e.paths[dst] = struct{}{}
	c.byPath[dst] = e
	c.touch(e)
	return nil
}

// removeLocked unlinks path on disk and deregisters it. Must be called with
// c.mu held.
func (c *Cache) removeLocked(path string) error {
	if _, ok := c.byPath[path]; !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, path)
	}
	if err := os.Remove(c.abs(path)); err != nil {
		return err
	}
	c.deregister(path)
	return nil
}

// Remove deletes path from disk and the index. The inode's budget is
// released only if this was its last link.
func (c *Cache) Remove(path string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.removeLocked(path)
}

// Acquire takes a lease on path, protecting it from eviction. Path must be
// tracked. Leases nest; each Acquire needs a matching Release.
func (c *Cache) Acquire(path string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.byPath[path]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, path)
	}
	c.leases[path]++
	c.touch(e)
	return nil
}

// Release drops one lease on path.
func (c *Cache) Release(path string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.leases[path] <= 0 {
		return fmt.Errorf("%w: %s", ErrLeaseBalance, path)
	}
	c.leases[path]--
	if c.leases[path] == 0 {
		delete(c.leases, path)
	}
	return nil
}

// Evict deletes unleased paths, coldest (least recently accessed) inode
// first, until usage fits the budget or nothing evictable remains. For each
// victim inode only its unleased paths are removed; the inode's budget is
// released only when its last link disappears. It returns the evicted paths
// in deletion order.
func (c *Cache) Evict() ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var evicted []string
	for c.usage > c.budget {
		victim := c.coldestEvictableLocked()
		if victim == nil {
			break
		}
		paths := make([]string, 0, len(victim.paths))
		for p := range victim.paths {
			if c.leases[p] == 0 {
				paths = append(paths, p)
			}
		}
		sort.Strings(paths)
		for _, p := range paths {
			if err := os.Remove(c.abs(p)); err != nil {
				return evicted, err
			}
			c.deregister(p)
			evicted = append(evicted, p)
		}
	}
	return evicted, nil
}

// coldestEvictableLocked returns the least recently accessed entry that has
// at least one unleased path, or nil. Must be called with c.mu held.
func (c *Cache) coldestEvictableLocked() *entry {
	var best *entry
	for _, e := range c.entries {
		evictable := false
		for p := range e.paths {
			if c.leases[p] == 0 {
				evictable = true
				break
			}
		}
		if !evictable {
			continue
		}
		if best == nil || e.lastAccess < best.lastAccess {
			best = e
		}
	}
	return best
}
