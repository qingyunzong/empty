// Package tickcache implements a cache whose access statistics are
// accumulated in per-tick generations. At the end of each tick the
// current statistics generation is swapped atomically; accesses that
// are already in flight still land in the generation they started in
// and are guaranteed to complete before the settlement folds the
// counts into the live entries. Eviction picks the entry with the
// lowest access frequency, breaking ties by earliest last-access tick
// and then by the smallest key.
package tickcache

import (
	"sort"
	"sync"
	"sync/atomic"
)

// Entry is a snapshot of the statistics of one cached key.
type Entry struct {
	Key  string
	Freq int
	Last uint64 // tick of the most recent access
}

type entry struct {
	value any
	freq  int
	last  uint64
}

// generation holds the access counts accumulated during one tick.
type generation struct {
	mu   sync.Mutex
	freq map[string]int
}

func newGeneration() *generation {
	return &generation{freq: make(map[string]int)}
}

// Cache accumulates per-tick access counts and evicts by frequency,
// then last-access recency, then key order.
type Cache struct {
	capacity int

	// swapMu serializes generation swaps against in-flight accesses:
	// Access holds a read lock while recording into the generation it
	// observed, Settle takes the write lock to swap the generation, so
	// every late write to the replaced generation has completed before
	// the settlement reads it.
	swapMu sync.RWMutex
	gen    atomic.Pointer[generation]

	mu          sync.Mutex
	tick        uint64
	entries     map[string]*entry
	evictedFreq int
}

// New returns a Cache that keeps at most capacity entries after each
// settlement.
func New(capacity int) *Cache {
	c := &Cache{capacity: capacity, entries: make(map[string]*entry)}
	c.gen.Store(newGeneration())
	return c
}

// Access records one access for key in the current generation.
func (c *Cache) Access(key string) {
	c.swapMu.RLock()
	g := c.gen.Load()
	g.mu.Lock()
	g.freq[key]++
	g.mu.Unlock()
	c.swapMu.RUnlock()
}

// Get records an access and returns the cached value, if any.
func (c *Cache) Get(key string) (any, bool) {
	c.Access(key)
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.entries[key]; ok {
		return e.value, true
	}
	return nil, false
}

// Put stores value under key and records an access.
func (c *Cache) Put(key string, value any) {
	c.Access(key)
	c.mu.Lock()
	e, ok := c.entries[key]
	if !ok {
		e = &entry{}
		c.entries[key] = e
	}
	e.value = value
	c.mu.Unlock()
}

// Settle ends the current tick. It atomically replaces the statistics
// generation, waits for in-flight accesses to the replaced generation
// to complete, folds their counts into the entries, and evicts down
// to capacity.
func (c *Cache) Settle() {
	c.swapMu.Lock()
	old := c.gen.Swap(newGeneration())
	c.swapMu.Unlock()

	old.mu.Lock()
	freq := old.freq
	old.mu.Unlock()

	c.mu.Lock()
	defer c.mu.Unlock()
	c.tick++
	for key, n := range freq {
		e, ok := c.entries[key]
		if !ok {
			e = &entry{}
			c.entries[key] = e
		}
		e.freq += n
		e.last = c.tick
	}
	for len(c.entries) > c.capacity {
		c.evictOneLocked()
	}
}

// evictOneLocked removes the best victim: lowest frequency, then
// earliest last-access tick, then smallest key.
func (c *Cache) evictOneLocked() {
	var victim string
	var ve *entry
	first := true
	for key, e := range c.entries {
		if first || lessVictim(e, key, ve, victim) {
			victim, ve = key, e
			first = false
		}
	}
	c.evictedFreq += ve.freq
	delete(c.entries, victim)
}

func lessVictim(a *entry, aKey string, b *entry, bKey string) bool {
	if a.freq != b.freq {
		return a.freq < b.freq
	}
	if a.last != b.last {
		return a.last < b.last
	}
	return aKey < bKey
}

// Snapshot returns the live entries sorted by key.
func (c *Cache) Snapshot() []Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Entry, 0, len(c.entries))
	for key, e := range c.entries {
		out = append(out, Entry{Key: key, Freq: e.freq, Last: e.last})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// Totals reports the number of accesses accounted for: live in
// entries, discarded by eviction, and still pending in the current
// generation.
func (c *Cache) Totals() (live, evicted, pending int) {
	c.mu.Lock()
	for _, e := range c.entries {
		live += e.freq
	}
	evicted = c.evictedFreq
	c.mu.Unlock()

	c.swapMu.RLock()
	g := c.gen.Load()
	g.mu.Lock()
	for _, n := range g.freq {
		pending += n
	}
	g.mu.Unlock()
	c.swapMu.RUnlock()
	return live, evicted, pending
}

// Tick returns the number of settled ticks.
func (c *Cache) Tick() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.tick
}
