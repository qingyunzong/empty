// Package fileindex implements a file index cache whose entries are
// identified by a (path, generation) pair. A scan captures a baseline
// of generations at start; its results are published only while every
// baseline generation is still valid, so results computed before a
// delete/recreate of the same path are always rejected.
package fileindex

import "sync"

// Entry is a single indexed file. The (Path, Generation) pair uniquely
// identifies the entry: Generation changes whenever the path is deleted
// or (re)created, so an entry captured before such an event can never
// be mistaken for the current one.
type Entry struct {
	Path        string
	Generation  uint64
	Size        int64
	ModTimeUnix int64
}

// Baseline records the generation of every path observed at the start
// of a scan. It is valid only while all of its generations still match
// the cache.
type Baseline map[string]uint64

// Cache is a concurrency-safe file index. Generations are retained as
// tombstones after deletion so that stale scans are still rejected.
type Cache struct {
	mu      sync.Mutex
	gen     map[string]uint64 // path -> current generation
	entries map[string]Entry  // path -> last published entry
}

// NewCache returns an empty cache.
func NewCache() *Cache {
	return &Cache{
		gen:     make(map[string]uint64),
		entries: make(map[string]Entry),
	}
}

// Create records the (re)creation of path and bumps its generation.
// Any previously published data is dropped: it belongs to an older
// generation and must not survive under the new one.
func (c *Cache) Create(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen[path]++
	delete(c.entries, path)
}

// Delete records the removal of path and bumps its generation. The
// generation tombstone is retained so in-flight scans holding the old
// generation in their baseline are rejected on publish.
func (c *Cache) Delete(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen[path]++
	delete(c.entries, path)
}

// Generation returns the current generation of path (0 if never seen).
func (c *Cache) Generation(path string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen[path]
}

// Entry returns the published entry for path.
func (c *Cache) Entry(path string) (Entry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[path]
	return e, ok
}

// snapshot captures the current generation of every path as a baseline.
func (c *Cache) snapshot(paths []string) Baseline {
	c.mu.Lock()
	defer c.mu.Unlock()
	b := make(Baseline, len(paths))
	for _, p := range paths {
		b[p] = c.gen[p]
	}
	return b
}

// publish stores entries only if every baseline generation still
// matches the cache. It reports whether publication happened.
func (c *Cache) publish(b Baseline, entries []Entry) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for p, g := range b {
		if c.gen[p] != g {
			return false
		}
	}
	for _, e := range entries {
		c.entries[e.Path] = e
	}
	return true
}
