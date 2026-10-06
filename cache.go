// Package cache implements a byte-budgeted page cache with LRU-style
// eviction, leases that pin pages against eviction, and singleflight
// asynchronous loading with byte reservations.
package cache

import (
	"cmp"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
)

var (
	// ErrBudgetExhausted is returned when an insert or load reservation
	// cannot fit even after evicting every evictable (unpinned) page.
	// Failed inserts never evict anything.
	ErrBudgetExhausted = errors.New("cache: insufficient budget")
	// ErrInvalidSize is returned for non-positive page sizes or negative
	// reservations.
	ErrInvalidSize = errors.New("cache: invalid size")
)

// page is a single cached object. seq is the last access sequence number;
// pages with pins > 0 are leased and cannot be evicted.
type page[V any] struct {
	value   V
	size    int64
	seq     uint64
	pins    int
	version uint64
}

// Cache is a fixed-budget page cache. The byte budget is shared between
// cached pages and in-flight load reservations: used + reserved <= budget.
type Cache[K comparable, V any] struct {
	mu       sync.Mutex
	budget   int64
	used     int64 // bytes held by cached pages
	reserved int64 // bytes reserved by in-flight loads
	seq      uint64
	pages    map[K]*page[V]
	versions map[K]uint64
	loads    map[K]*loadCall[V]
}

// New returns an empty cache with the given total byte budget.
func New[K comparable, V any](budget int64) *Cache[K, V] {
	return &Cache[K, V]{
		budget:   budget,
		pages:    make(map[K]*page[V]),
		versions: make(map[K]uint64),
		loads:    make(map[K]*loadCall[V]),
	}
}

// Used returns the number of bytes currently held by cached pages.
func (c *Cache[K, V]) Used() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.used
}

// Reserved returns the number of bytes currently reserved by in-flight loads.
func (c *Cache[K, V]) Reserved() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.reserved
}

// Len returns the number of cached pages.
func (c *Cache[K, V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pages)
}

// Get looks up a page. A hit only updates the page's access sequence number.
func (c *Cache[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pages[key]
	if !ok {
		var zero V
		return zero, false
	}
	c.seq++
	p.seq = c.seq
	return p.value, true
}

// Lease looks up a page and pins it against eviction until the returned
// lease is released. A hit updates the page's access sequence number.
func (c *Cache[K, V]) Lease(key K) (V, *Lease[K, V], bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pages[key]
	if !ok {
		var zero V
		return zero, nil, false
	}
	c.seq++
	p.seq = c.seq
	p.pins++
	return p.value, &Lease[K, V]{cache: c, key: key, page: p}, true
}

// Lease pins a cached page. Release is idempotent: releasing twice, or
// releasing after the page was invalidated, is a no-op.
type Lease[K comparable, V any] struct {
	cache    *Cache[K, V]
	key      K
	page     *page[V]
	released atomic.Bool
}

// Release unpins the page. It is safe to call multiple times; only the
// first call has an effect.
func (l *Lease[K, V]) Release() {
	if l == nil || l.released.Swap(true) {
		return
	}
	c := l.cache
	c.mu.Lock()
	defer c.mu.Unlock()
	// The page may have been invalidated or replaced meanwhile; only unpin
	// if the exact same page object is still cached.
	if p, ok := c.pages[l.key]; ok && p == l.page && p.pins > 0 {
		p.pins--
	}
}

// Insert adds or replaces a page, evicting oldest unpinned pages as needed
// to satisfy used + reserved + size <= budget. If the page cannot fit even
// after evicting every unpinned page, Insert returns ErrBudgetExhausted
// without evicting or changing anything.
func (c *Cache[K, V]) Insert(key K, value V, size int64) error {
	if size <= 0 {
		return ErrInvalidSize
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.insertLocked(key, value, size)
}

// insertLocked performs an atomic insert: the full eviction set is computed
// and validated before any state is mutated, so failure evicts nothing.
func (c *Cache[K, V]) insertLocked(key K, value V, size int64) error {
	usedAfter := c.used
	if old, ok := c.pages[key]; ok {
		usedAfter -= old.size
	}
	need := usedAfter + size + c.reserved - c.budget
	var evict []K
	if need > 0 {
		type candidate struct {
			key K
			p   *page[V]
		}
		var cands []candidate
		for k, p := range c.pages {
			if k == key || p.pins > 0 {
				continue
			}
			cands = append(cands, candidate{k, p})
		}
		slices.SortFunc(cands, func(a, b candidate) int {
			return cmp.Compare(a.p.seq, b.p.seq)
		})
		var freed int64
		for _, cd := range cands {
			if freed >= need {
				break
			}
			evict = append(evict, cd.key)
			freed += cd.p.size
		}
		if freed < need {
			return ErrBudgetExhausted
		}
	}
	// Commit: only now mutate state.
	if old, ok := c.pages[key]; ok {
		c.used -= old.size
		delete(c.pages, key)
	}
	for _, k := range evict {
		c.used -= c.pages[k].size
		delete(c.pages, k)
	}
	c.versions[key]++
	c.seq++
	c.pages[key] = &page[V]{value: value, size: size, seq: c.seq, version: c.versions[key]}
	c.used += size
	return nil
}

// Invalidate removes a page (even if leased) and bumps the page version so
// that results of in-flight loads for the key can no longer be published.
func (c *Cache[K, V]) Invalidate(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.versions[key]++
	if p, ok := c.pages[key]; ok {
		c.used -= p.size
		delete(c.pages, key)
	}
}
