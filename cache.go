// Package buildcache implements a disk-budgeted build cache.
//
// Disk usage is accounted per inode: several paths hard-linked to the same
// content are charged only once. Eviction removes only paths that carry no
// lease, and the budget for an inode is released only when its last link
// disappears. Recovery rescans the cache directory, ignoring incomplete
// temporary files.
package buildcache

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// TempSuffix marks incomplete temporary files. Recovery and full scans
// ignore any file whose name ends with it.
const TempSuffix = ".tmp"

type fileID struct {
	dev uint64
	ino uint64
}

// entry tracks one inode and every cache path linked to it.
type entry struct {
	id    fileID
	size  int64
	links map[string]struct{}
	last  uint64 // LRU clock of last Add/Touch
}

// Cache is a disk-budgeted store keyed by inode.
type Cache struct {
	dir     string
	budget  int64
	used    int64
	clock   uint64
	entries map[fileID]*entry
	paths   map[string]*entry
	leases  map[string]int
}

// New creates a cache rooted at dir with the given byte budget.
func New(dir string, budget int64) (*Cache, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Cache{
		dir:     dir,
		budget:  budget,
		entries: make(map[fileID]*entry),
		paths:   make(map[string]*entry),
		leases:  make(map[string]int),
	}, nil
}

func statID(info os.FileInfo) (fileID, error) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileID{}, fmt.Errorf("buildcache: unsupported file info %T", info.Sys())
	}
	return fileID{dev: uint64(st.Dev), ino: uint64(st.Ino)}, nil
}

// Budget returns the configured disk budget in bytes.
func (c *Cache) Budget() int64 { return c.budget }

// Used returns the bytes currently charged against the budget.
func (c *Cache) Used() int64 { return c.used }

// Entries returns the number of distinct inodes tracked.
func (c *Cache) Entries() int { return len(c.entries) }

// Tracked reports whether path is currently in the cache.
func (c *Cache) Tracked(path string) bool {
	_, ok := c.paths[path]
	return ok
}

// Leased reports whether path currently holds at least one lease.
func (c *Cache) Leased(path string) bool { return c.leases[path] > 0 }

// Add registers path with the cache. If the path's inode is already known
// (a hard link to cached content), only the new link is recorded and no
// additional budget is charged.
func (c *Cache) Add(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("buildcache: %s is not a regular file", path)
	}
	c.clock++
	if e, ok := c.paths[path]; ok {
		e.last = c.clock
		return nil
	}
	id, err := statID(info)
	if err != nil {
		return err
	}
	e, ok := c.entries[id]
	if !ok {
		e = &entry{id: id, size: info.Size(), links: make(map[string]struct{})}
		c.entries[id] = e
		c.used += e.size
	}
	e.links[path] = struct{}{}
	e.last = c.clock
	c.paths[path] = e
	return nil
}

// AcquireLease takes a lease on a tracked path. Leased paths are never
// removed by eviction.
func (c *Cache) AcquireLease(path string) error {
	if !c.Tracked(path) {
		return fmt.Errorf("buildcache: cannot lease untracked path %s", path)
	}
	c.leases[path]++
	return nil
}

// ReleaseLease releases one lease on path.
func (c *Cache) ReleaseLease(path string) error {
	if c.leases[path] <= 0 {
		return fmt.Errorf("buildcache: no lease held on %s", path)
	}
	c.leases[path]--
	if c.leases[path] == 0 {
		delete(c.leases, path)
	}
	return nil
}

// Unlink deletes path from disk and from the cache. The inode's budget is
// released only when its last link disappears. Unlink refuses leased paths.
func (c *Cache) Unlink(path string) error {
	if c.Leased(path) {
		return fmt.Errorf("buildcache: cannot unlink leased path %s", path)
	}
	e, ok := c.paths[path]
	if !ok {
		return fmt.Errorf("buildcache: untracked path %s", path)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	c.dropLink(e, path)
	return nil
}

// dropLink removes path from its entry, releasing the entry's budget when
// the last link disappears.
func (c *Cache) dropLink(e *entry, path string) {
	delete(e.links, path)
	delete(c.paths, path)
	if len(e.links) == 0 {
		delete(c.entries, e.id)
		c.used -= e.size
	}
}

// evictable reports whether the entry has at least one lease-free path.
func (c *Cache) evictable(e *entry) bool {
	for p := range e.links {
		if !c.Leased(p) {
			return true
		}
	}
	return false
}

// Evict removes lease-free paths, least-recently-used entries first, until
// usage fits the budget or only fully leased entries remain. It returns the
// removed paths in eviction order. An inode's budget is released only when
// its last link is removed.
func (c *Cache) Evict() []string {
	var order []string
	for c.used > c.budget {
		var victim *entry
		for _, e := range c.entries {
			if !c.evictable(e) {
				continue
			}
			if victim == nil || e.last < victim.last {
				victim = e
			}
		}
		if victim == nil {
			break
		}
		var free []string
		for p := range victim.links {
			if !c.Leased(p) {
				free = append(free, p)
			}
		}
		sort.Strings(free)
		for _, p := range free {
			if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
				continue
			}
			c.dropLink(victim, p)
			order = append(order, p)
		}
	}
	return order
}

// Recover rebuilds cache state by scanning the cache directory. Incomplete
// temporary files (TempSuffix) are ignored. In-memory leases do not survive
// recovery.
func (c *Cache) Recover() error {
	c.used = 0
	c.clock = 0
	c.entries = make(map[fileID]*entry)
	c.paths = make(map[string]*entry)
	c.leases = make(map[string]int)
	return c.scan(func(path string, info os.FileInfo, id fileID) {
		c.clock++
		e, ok := c.entries[id]
		if !ok {
			e = &entry{id: id, size: info.Size(), links: make(map[string]struct{})}
			c.entries[id] = e
			c.used += e.size
		}
		e.links[path] = struct{}{}
		e.last = c.clock
		c.paths[path] = e
	})
}

// FullScan walks the cache directory and recomputes chargeable bytes from
// scratch, counting each inode once and ignoring temporary files. It is the
// ground truth against which incremental accounting can be checked.
func (c *Cache) FullScan() int64 {
	var total int64
	seen := make(map[fileID]struct{})
	_ = c.scan(func(_ string, info os.FileInfo, id fileID) {
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		total += info.Size()
	})
	return total
}

func (c *Cache) scan(fn func(path string, info os.FileInfo, id fileID)) error {
	var paths []string
	err := filepath.WalkDir(c.dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		if strings.HasSuffix(d.Name(), TempSuffix) {
			return nil
		}
		paths = append(paths, path)
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(paths)
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		id, err := statID(info)
		if err != nil {
			continue
		}
		fn(p, info, id)
	}
	return nil
}
