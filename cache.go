// Package tickcache implements a cache whose access statistics are
// accumulated into per-tick generations. At the end of each tick the
// statistics generation is swapped atomically; writers that joined the
// old generation before the swap ("late writers") still record into the
// old generation and are guaranteed to finish before settlement merges
// that generation's counts.
//
// Eviction order: lowest settled frequency, then earliest last-access
// tick, then smallest key.
package tickcache

import (
	"sync"
	"sync/atomic"
)

// generation holds the access counts of one tick.
type generation struct {
	id     uint64
	mu     sync.Mutex
	closed bool // no new writers may join
	counts map[string]uint64
	wg     sync.WaitGroup // in-flight writers that joined this generation
}

func newGeneration(id uint64) *generation {
	return &generation{id: id, counts: make(map[string]uint64)}
}

type entry struct {
	freq       uint64 // settled frequency (completed generations only)
	lastAccess uint64 // tick in which the key was last accessed
}

// Cache is a concurrency-safe cache with tick-based frequency statistics.
type Cache struct {
	capacity int

	gen   atomic.Pointer[generation] // current open generation
	tickN atomic.Uint64              // id of the current open generation

	tickMu sync.Mutex // serializes Tick
	mu     sync.Mutex // guards data
	data   map[string]*entry

	settleHook func(genID uint64, counts map[string]uint64)
}

// New creates a Cache holding at most capacity keys (<=0 means unbounded).
func New(capacity int) *Cache {
	c := &Cache{capacity: capacity, data: make(map[string]*entry)}
	c.gen.Store(newGeneration(0))
	return c
}

// SetSettleHook registers a callback invoked during Tick after the closed
// generation has been merged. It receives a copy of the generation counts.
// Must be set before concurrent use.
func (c *Cache) SetSettleHook(h func(genID uint64, counts map[string]uint64)) {
	c.settleHook = h
}

// join returns the current open generation after registering as a writer.
func (c *Cache) join() *generation {
	for {
		g := c.gen.Load()
		g.mu.Lock()
		if !g.closed {
			g.wg.Add(1)
			g.mu.Unlock()
			return g
		}
		g.mu.Unlock()
		// Generation was closed by a concurrent Tick; retry with the new one.
	}
}

// Access records one access to key, admitting it to the cache if absent.
// The count lands in the generation that was open when the access joined,
// even if a tick boundary is crossed before the write completes.
func (c *Cache) Access(key string) {
	g := c.join()
	defer g.wg.Done()

	g.mu.Lock()
	g.counts[key]++
	g.mu.Unlock()

	tick := c.tickN.Load()
	c.mu.Lock()
	e, ok := c.data[key]
	if !ok {
		if c.capacity > 0 && len(c.data) >= c.capacity {
			c.evictLocked()
		}
		e = &entry{}
		c.data[key] = e
	}
	e.lastAccess = tick
	c.mu.Unlock()
}

// Tick ends the current tick: it atomically swaps in a fresh generation,
// closes the old one, waits for its late writers to finish, and settles
// (merges) the old generation's counts into the entries' frequencies.
func (c *Cache) Tick() {
	c.tickMu.Lock()
	defer c.tickMu.Unlock()

	old := c.gen.Swap(newGeneration(c.tickN.Add(1)))

	old.mu.Lock()
	old.closed = true
	old.mu.Unlock()

	old.wg.Wait() // late writes complete before settlement

	c.mu.Lock()
	for key, n := range old.counts {
		if e, ok := c.data[key]; ok {
			e.freq += n
		}
	}
	hook := c.settleHook
	c.mu.Unlock()

	if hook != nil {
		counts := make(map[string]uint64, len(old.counts))
		for k, n := range old.counts {
			counts[k] = n
		}
		hook(old.id, counts)
	}
}

// evictLocked removes the entry ordered first by (freq asc, lastAccess
// asc, key asc). Caller must hold c.mu.
func (c *Cache) evictLocked() {
	victim := ""
	var ve *entry
	first := true
	for k, e := range c.data {
		if first || e.freq < ve.freq ||
			(e.freq == ve.freq && e.lastAccess < ve.lastAccess) ||
			(e.freq == ve.freq && e.lastAccess == ve.lastAccess && k < victim) {
			victim, ve = k, e
			first = false
		}
	}
	delete(c.data, victim)
}

// Snapshot returns the settled frequencies of all resident keys.
func (c *Cache) Snapshot() map[string]uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]uint64, len(c.data))
	for k, e := range c.data {
		out[k] = e.freq
	}
	return out
}

// Contains reports whether key is currently cached.
func (c *Cache) Contains(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.data[key]
	return ok
}

// Len returns the number of resident keys.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.data)
}
