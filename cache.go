// Package cache implements a byte-budgeted LRU page cache with leasing,
// atomic insertion, and single-flight asynchronous loading.
package cache

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrBudgetExceeded is returned when an insert or load reservation cannot
// fit within the budget even after evicting every evictable page.
var ErrBudgetExceeded = errors.New("cache: budget exceeded")

// ErrInvalidSize is returned for negative sizes.
var ErrInvalidSize = errors.New("cache: invalid size")

type page struct {
	value  any
	size   int64
	seq    uint64
	leases int
}

type load struct {
	version  uint64
	size     int64
	waiters  int
	done     chan struct{}
	cancel   context.CancelFunc
	value    any
	err      error
	finished bool
}

// Cache is a fixed-budget LRU cache. The zero value is not usable; use New.
type Cache struct {
	mu       sync.Mutex
	budget   int64
	used     int64 // cached bytes + in-flight load reservations
	seq      uint64
	pages    map[string]*page
	versions map[string]uint64
	loads    map[string]*load
}

// New returns a Cache with the given total byte budget. The budget is shared
// by cached pages and in-flight load reservations.
func New(budget int64) *Cache {
	return &Cache{
		budget:   budget,
		pages:    make(map[string]*page),
		versions: make(map[string]uint64),
		loads:    make(map[string]*load),
	}
}

// Used reports the bytes currently charged against the budget: cached pages
// plus in-flight load reservations.
func (c *Cache) Used() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.used
}

// Get returns the value for key. On a hit it only advances the page's access
// sequence number.
func (c *Cache) Get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pages[key]
	if !ok {
		return nil, false
	}
	c.seq++
	p.seq = c.seq
	return p.value, true
}

// Has reports whether key is cached, without affecting eviction order.
func (c *Cache) Has(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.pages[key]
	return ok
}

// Lease pins a cached page so it cannot be evicted, and returns a handle.
// Acquiring a lease counts as an access and advances the page's sequence.
func (c *Cache) Lease(key string) (*Lease, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pages[key]
	if !ok {
		return nil, false
	}
	p.leases++
	c.seq++
	p.seq = c.seq
	return &Lease{cache: c, pg: p}, true
}

// Lease is a handle pinning one page. Release is idempotent-safe: a duplicate
// release has no effect and reports false.
type Lease struct {
	cache    *Cache
	pg       *page
	released bool
}

// Release unpins the page. The first call returns true; duplicate releases
// are invalid, have no effect, and return false.
func (l *Lease) Release() bool {
	l.cache.mu.Lock()
	defer l.cache.mu.Unlock()
	if l.released {
		return false
	}
	l.released = true
	l.pg.leases--
	return true
}

// evictableLocked sums bytes of unleased pages, excluding excludeKey.
func (c *Cache) evictableLocked(excludeKey string) int64 {
	var total int64
	for k, p := range c.pages {
		if k != excludeKey && p.leases == 0 {
			total += p.size
		}
	}
	return total
}

// evictUntilLocked evicts oldest unleased pages (excluding excludeKey) until
// used <= target. Callers must guarantee feasibility beforehand so that an
// insert either fully succeeds or changes nothing.
func (c *Cache) evictUntilLocked(target int64, excludeKey string) {
	for c.used > target {
		var victimKey string
		var victim *page
		for k, p := range c.pages {
			if k == excludeKey || p.leases > 0 {
				continue
			}
			if victim == nil || p.seq < victim.seq {
				victim, victimKey = p, k
			}
		}
		if victim == nil {
			panic("cache: eviction infeasible after feasibility check")
		}
		delete(c.pages, victimKey)
		c.used -= victim.size
	}
}

// Put inserts or replaces a page of the given size. If the insert does not
// fit, the oldest unleased pages are evicted. If eviction cannot free enough
// room (pages leased, or size alone exceeds the budget), Put fails and the
// cache is left completely unchanged: no partial eviction ever occurs.
func (c *Cache) Put(key string, value any, size int64) error {
	if size < 0 {
		return ErrInvalidSize
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	var oldSize int64
	if old, ok := c.pages[key]; ok {
		oldSize = old.size
	}
	need := c.used - oldSize + size
	if need > c.budget {
		if need-c.evictableLocked(key) > c.budget {
			return ErrBudgetExceeded
		}
		c.evictUntilLocked(c.budget-size+oldSize, key)
	}
	c.used += size - oldSize
	c.seq++
	c.pages[key] = &page{value: value, size: size, seq: c.seq}
	return nil
}

// Invalidate removes key from the cache and bumps its version, making any
// in-flight load started before this call unpublishable.
func (c *Cache) Invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.versions[key]++
	if p, ok := c.pages[key]; ok {
		c.used -= p.size
		delete(c.pages, key)
	}
}

// Load returns the cached value for key if present. Otherwise it starts (or
// joins) a single asynchronous load for key: concurrent loads of the same
// key execute fn exactly once. The load reserves size bytes against the same
// budget as cached pages for its whole duration.
//
// If the page version changes (Invalidate) before fn completes, the stale
// result is delivered to current waiters but never published. Cancelling one
// waiter's context does not stop the load; the load is abandoned and its
// reservation released only when every waiter has cancelled.
func (c *Cache) Load(ctx context.Context, key string, size int64, fn func(context.Context) (any, error)) (any, error) {
	if size < 0 {
		return nil, ErrInvalidSize
	}
	c.mu.Lock()
	if p, ok := c.pages[key]; ok {
		c.seq++
		p.seq = c.seq
		v := p.value
		c.mu.Unlock()
		return v, nil
	}
	if l, ok := c.loads[key]; ok {
		l.waiters++
		c.mu.Unlock()
		return c.wait(ctx, key, l)
	}
	need := c.used + size
	if need > c.budget {
		if need-c.evictableLocked("") > c.budget {
			c.mu.Unlock()
			return nil, ErrBudgetExceeded
		}
		c.evictUntilLocked(c.budget-size, "")
	}
	c.used += size
	lctx, cancel := context.WithCancel(context.Background())
	l := &load{
		version: c.versions[key],
		size:    size,
		waiters: 1,
		done:    make(chan struct{}),
		cancel:  cancel,
	}
	c.loads[key] = l
	c.mu.Unlock()

	go c.run(lctx, key, l, fn)
	return c.wait(ctx, key, l)
}

func (c *Cache) wait(ctx context.Context, key string, l *load) (any, error) {
	select {
	case <-l.done:
		return l.value, l.err
	case <-ctx.Done():
		c.mu.Lock()
		l.waiters--
		if l.waiters == 0 && !l.finished {
			// Last waiter gone: stop the load and free the reservation.
			l.finished = true
			delete(c.loads, key)
			c.used -= l.size
			l.cancel()
			close(l.done)
		}
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (c *Cache) run(ctx context.Context, key string, l *load, fn func(context.Context) (any, error)) {
	v, err := fn(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	if l.finished {
		// All waiters cancelled; reservation already released.
		return
	}
	l.finished = true
	delete(c.loads, key)
	l.value, l.err = v, err
	if err != nil {
		c.used -= l.size
		close(l.done)
		return
	}
	if c.versions[key] != l.version {
		// Stale result: deliver to waiters but never publish.
		c.used -= l.size
		close(l.done)
		return
	}
	// Publish: the reservation converts into cached bytes.
	if old, ok := c.pages[key]; ok {
		c.used -= old.size
	}
	c.seq++
	c.pages[key] = &page{value: v, size: l.size, seq: c.seq}
	close(l.done)
}

// pageInfo is a snapshot of one cached page, for tests and diagnostics.
type pageInfo struct {
	Size   int64
	Seq    uint64
	Leases int
	Value  any
}

// snapshot returns a copy of the current page table.
func (c *Cache) snapshot() map[string]pageInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]pageInfo, len(c.pages))
	for k, p := range c.pages {
		out[k] = pageInfo{Size: p.size, Seq: p.seq, Leases: p.leases, Value: p.value}
	}
	return out
}

// inflight reports the reserved bytes and waiter count of an in-flight load.
func (c *Cache) inflight(key string) (reserved int64, waiters int, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	l, ok := c.loads[key]
	if !ok {
		return 0, 0, false
	}
	return l.size, l.waiters, true
}

func (c *Cache) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return fmt.Sprintf("Cache{used: %d, budget: %d, pages: %d, loads: %d}",
		c.used, c.budget, len(c.pages), len(c.loads))
}
