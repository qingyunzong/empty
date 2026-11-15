package robots

import (
	"container/list"
	"sync"
	"time"
)

// Clock returns the current time. Tests can inject a deterministic clock.
type Clock func() time.Time

// Scope identifies a tenant's policy for one origin.
type Scope struct {
	Tenant string
	Origin Origin
}

// NewScope constructs a Scope.
func NewScope(tenant string, origin Origin) Scope {
	if canonical, err := origin.Canonical(); err == nil {
		origin = canonical
	}
	return Scope{Tenant: tenant, Origin: origin}
}

// Canonical returns a Scope with a canonical origin.
func (s Scope) Canonical() (Scope, error) {
	origin, err := s.Origin.Canonical()
	if err != nil {
		return Scope{}, err
	}
	s.Origin = origin
	return s, nil
}

func (s Scope) canonical() Scope {
	canonical, err := s.Canonical()
	if err != nil {
		return s
	}
	return canonical
}

// CacheConfig configures a policy Cache.
type CacheConfig struct {
	// MaxEntries bounds the number of cached origins. Zero uses the default
	// (4096); a negative value disables eviction.
	MaxEntries int
	Clock      Clock
}

// CacheOption customises NewCache.
type CacheOption func(*CacheConfig)

// WithMaxEntries sets the LRU capacity. A negative capacity disables eviction.
func WithMaxEntries(entries int) CacheOption {
	return func(cfg *CacheConfig) { cfg.MaxEntries = entries }
}

// WithCacheClock injects a clock.
func WithCacheClock(clock Clock) CacheOption {
	return func(cfg *CacheConfig) { cfg.Clock = clock }
}

// WithCacheCapacity is an alias for WithMaxEntries.
func WithCacheCapacity(entries int) CacheOption {
	return WithMaxEntries(entries)
}

type cacheEntry struct {
	snapshot Snapshot
	element  *list.Element
}

// Cache is a concurrency-safe LRU cache of parsed policy snapshots. It is
// keyed by tenant, scheme, host and port.
//
// Cache writes do not know about Manager claims. Applications with active
// leases should publish through Manager.InstallPolicy or Manager.Publish so
// superseded claims are revoked and unsent permits are canceled.
type Cache struct {
	mu          sync.Mutex
	entries     map[Scope]*cacheEntry
	order       *list.List
	generations map[Scope]uint64
	versions    map[Scope]uint64
	clock       Clock
	maxEntries  int
	nextVersion uint64
}

// NewCache creates an empty cache.
func NewCache(options ...CacheOption) *Cache {
	cfg := CacheConfig{MaxEntries: 4096, Clock: time.Now}
	for _, option := range options {
		if option != nil {
			option(&cfg)
		}
	}
	return NewCacheWithConfig(cfg)
}

// NewCacheWithConfig creates an empty cache from a config value.
func NewCacheWithConfig(cfg CacheConfig) *Cache {
	if cfg.MaxEntries == 0 {
		cfg.MaxEntries = 4096
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	return &Cache{
		entries:     make(map[Scope]*cacheEntry),
		order:       list.New(),
		generations: make(map[Scope]uint64),
		versions:    make(map[Scope]uint64),
		clock:       cfg.Clock,
		maxEntries:  cfg.MaxEntries,
	}
}

// Now returns the cache's current time from its configured clock.
func (c *Cache) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.clock()
}

// Get returns a fresh snapshot. Expired entries are not returned.
func (c *Cache) Get(scope Scope) (Snapshot, bool) {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, ok := c.entries[scope]
	if !ok {
		return Snapshot{}, false
	}
	if !entry.snapshot.Fresh(c.clock()) {
		return Snapshot{}, false
	}
	c.touch(entry)
	return entry.snapshot, true
}

// Lookup returns a snapshot regardless of freshness. The boolean reports
// whether an entry exists; inspect Snapshot.Fresh to distinguish expiry.
func (c *Cache) Lookup(scope Scope) (Snapshot, bool) {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, ok := c.entries[scope]
	if !ok {
		return Snapshot{}, false
	}
	c.touch(entry)
	return entry.snapshot, true
}

// Load is an alias for Lookup.
func (c *Cache) Load(scope Scope) (Snapshot, bool) {
	return c.Lookup(scope)
}

// CurrentVersion returns the cache-wide version of the current entry, or zero
// when the scope is absent. Versions are never reused.
func (c *Cache) CurrentVersion(scope Scope) uint64 {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry, ok := c.entries[scope]; ok {
		return entry.snapshot.Version
	}
	return 0
}

// LastVersion returns the most recently installed version for a scope, even
// if the entry has since been evicted or expired. Claims use this value to
// detect supersession without keeping expired rules alive.
func (c *Cache) LastVersion(scope Scope) uint64 {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.versions[scope]
}

// CurrentGeneration returns the latest per-origin generation, including after
// the entry has been evicted.
func (c *Cache) CurrentGeneration(scope Scope) uint64 {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.generations[scope]
}

// Install stores rules with a default empty snapshot. A non-positive TTL means
// the entry never expires.
func (c *Cache) Install(scope Scope, rules *Rules, ttl time.Duration) Snapshot {
	return c.Put(scope, Snapshot{Rules: rules}, ttl)
}

// InstallIfVersion conditionally installs rules. expectedVersion is the
// LastVersion observed before the fetch began.
func (c *Cache) InstallIfVersion(scope Scope, expectedVersion uint64, rules *Rules, ttl time.Duration) (Snapshot, bool) {
	return c.PutIfVersion(scope, expectedVersion, Snapshot{Rules: rules}, ttl)
}

// Put stores a snapshot unconditionally and assigns its Version, Generation,
// FetchedAt and ExpiresAt fields.
func (c *Cache) Put(scope Scope, snapshot Snapshot, ttl time.Duration) Snapshot {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()

	stored, _ := c.putLocked(scope, snapshot, ttl)
	return stored
}

// PutIfVersion performs a compare-and-swap on the last installed cache-wide
// version. It returns false without modifying the cache when another writer
// has advanced the scope since expectedVersion was observed, even if the entry
// has meanwhile been evicted. Stale writes are therefore harmless when a slow
// network fetch finishes late.
func (c *Cache) PutIfVersion(scope Scope, expectedVersion uint64, snapshot Snapshot, ttl time.Duration) (Snapshot, bool) {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.versions[scope] != expectedVersion {
		if entry, ok := c.entries[scope]; ok {
			return entry.snapshot, false
		}
		return Snapshot{}, false
	}
	return c.putLocked(scope, snapshot, ttl)
}

// PutIfGeneration is a per-origin generation variant of PutIfVersion.
func (c *Cache) PutIfGeneration(scope Scope, expectedGeneration uint64, snapshot Snapshot, ttl time.Duration) (Snapshot, bool) {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.generations[scope] != expectedGeneration {
		if entry, ok := c.entries[scope]; ok {
			return entry.snapshot, false
		}
		return Snapshot{}, false
	}
	return c.putLocked(scope, snapshot, ttl)
}

// Store is an alias for Put.
func (c *Cache) Store(scope Scope, snapshot Snapshot, ttl time.Duration) Snapshot {
	return c.Put(scope, snapshot, ttl)
}

// StoreIfVersion is an alias for PutIfVersion.
func (c *Cache) StoreIfVersion(scope Scope, expectedVersion uint64, snapshot Snapshot, ttl time.Duration) (Snapshot, bool) {
	return c.PutIfVersion(scope, expectedVersion, snapshot, ttl)
}

func (c *Cache) putLocked(scope Scope, snapshot Snapshot, ttl time.Duration) (Snapshot, bool) {
	now := c.clock()
	c.nextVersion++
	snapshot.Version = c.nextVersion
	snapshot.Tenant = scope.Tenant
	snapshot.Origin = scope.Origin
	snapshot.FetchedAt = now
	if ttl > 0 {
		snapshot.ExpiresAt = now.Add(ttl)
	} else {
		snapshot.ExpiresAt = time.Time{}
	}
	snapshot.Rules = snapshot.Rules.Clone()
	if snapshot.Rules == nil {
		snapshot.Rules = AllowAllRules()
	}

	c.generations[scope]++
	snapshot.Generation = c.generations[scope]
	c.versions[scope] = snapshot.Version

	if entry, ok := c.entries[scope]; ok {
		entry.snapshot = snapshot
		c.touch(entry)
		return snapshot, true
	}

	entry := &cacheEntry{snapshot: snapshot}
	entry.element = c.order.PushFront(scope)
	c.entries[scope] = entry
	c.evictLocked()
	return snapshot, true
}

func (c *Cache) touch(entry *cacheEntry) {
	if entry.element != nil {
		c.order.MoveToFront(entry.element)
	}
}

func (c *Cache) evictLocked() {
	if c.maxEntries < 0 {
		return
	}
	for len(c.entries) > c.maxEntries {
		back := c.order.Back()
		if back == nil {
			return
		}
		scope, ok := back.Value.(Scope)
		c.order.Remove(back)
		if ok {
			delete(c.entries, scope)
		}
	}
}

// Forget removes one scope.
func (c *Cache) Forget(scope Scope) {
	scope = scope.canonical()
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry, ok := c.entries[scope]; ok {
		if entry.element != nil {
			c.order.Remove(entry.element)
		}
		delete(c.entries, scope)
	}
}

// Delete is an alias for Forget.
func (c *Cache) Delete(scope Scope) {
	c.Forget(scope)
}

// Sweep removes expired entries and returns the number removed.
func (c *Cache) Sweep() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.clock()
	removed := 0
	for scope, entry := range c.entries {
		if !entry.snapshot.Fresh(now) {
			if entry.element != nil {
				c.order.Remove(entry.element)
			}
			delete(c.entries, scope)
			removed++
		}
	}
	return removed
}

// Len returns the number of cached entries, including expired ones.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// Scopes returns the cached scopes in most-recently-used order.
func (c *Cache) Scopes() []Scope {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]Scope, 0, c.order.Len())
	for element := c.order.Front(); element != nil; element = element.Next() {
		if scope, ok := element.Value.(Scope); ok {
			out = append(out, scope)
		}
	}
	return out
}

// PolicyCache is an explicit name for Cache.
type PolicyCache = Cache

// PolicyStore is an alias for Cache.
type PolicyStore = Cache
