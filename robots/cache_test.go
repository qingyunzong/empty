package robots

import (
	"sync"
	"testing"
	"time"
)

type q216Clock struct {
	mu  sync.Mutex
	now time.Time
}

func newQ216Clock() *q216Clock {
	return &q216Clock{now: time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)}
}

func (c *q216Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *q216Clock) Advance(duration time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(duration)
	c.mu.Unlock()
}

func TestQ216CacheTenantAndOriginIsolation(t *testing.T) {
	cache := NewCache()
	a := Scope{Tenant: "a", Origin: q216Origin(t, "https://example.com")}
	b := Scope{Tenant: "b", Origin: q216Origin(t, "https://example.com")}
	c := Scope{Tenant: "a", Origin: q216Origin(t, "https://other.example")}

	first := cache.Install(a, q216Rules(t, "User-agent: *\nDisallow: /a\n"), time.Minute)
	second := cache.Install(b, q216Rules(t, "User-agent: *\nDisallow: /b\n"), time.Minute)
	third := cache.Install(c, q216Rules(t, "User-agent: *\nDisallow: /c\n"), time.Minute)

	if first.Version != 1 || first.Generation != 1 {
		t.Fatalf("first = %+v", first)
	}
	if second.Version != 2 || second.Generation != 1 {
		t.Fatalf("second = %+v", second)
	}
	if third.Version != 3 || third.Generation != 1 {
		t.Fatalf("third = %+v", third)
	}
	if q216Snapshot(t, cache, a).Allowed("*", "/b") != true {
		t.Fatal("tenant a should see tenant a rules")
	}
	if q216Snapshot(t, cache, b).Allowed("*", "/b") {
		t.Fatal("tenant b rules missing")
	}
}

func q216Snapshot(t *testing.T, cache *Cache, scope Scope) Snapshot {
	t.Helper()
	snapshot, ok := cache.Get(scope)
	if !ok {
		t.Fatal("missing snapshot")
	}
	return snapshot
}

func q216Origin(t *testing.T, value string) Origin {
	t.Helper()
	origin, err := ParseOrigin(value)
	if err != nil {
		t.Fatal(err)
	}
	return origin
}

func q216Rules(t *testing.T, document string) *Rules {
	t.Helper()
	rules, err := ParseBytes([]byte(document))
	if err != nil {
		t.Fatal(err)
	}
	return rules
}

func TestQ216CacheExpiryLookupAndSweep(t *testing.T) {
	clock := newQ216Clock()
	cache := NewCache(WithCacheClock(clock.Now))
	scope := Scope{Tenant: "t", Origin: q216Origin(t, "https://example.com")}
	cache.Install(scope, AllowAllRules(), time.Minute)

	if _, ok := cache.Get(scope); !ok {
		t.Fatal("fresh entry missing")
	}
	clock.Advance(59 * time.Second)
	if _, ok := cache.Get(scope); !ok {
		t.Fatal("entry expired too early")
	}
	clock.Advance(2 * time.Second)
	if _, ok := cache.Get(scope); ok {
		t.Fatal("expired entry returned by Get")
	}
	if snapshot, ok := cache.Lookup(scope); !ok || snapshot.Fresh(clock.Now()) {
		t.Fatalf("Lookup = %+v, %v", snapshot, ok)
	}
	if cache.CurrentVersion(scope) != 1 || cache.LastVersion(scope) != 1 {
		t.Fatal("version bookkeeping lost on expiry")
	}
	if removed := cache.Sweep(); removed != 1 {
		t.Fatalf("Sweep removed %d", removed)
	}
	if _, ok := cache.Lookup(scope); ok {
		t.Fatal("Sweep left entry behind")
	}
	if cache.LastVersion(scope) != 1 {
		t.Fatal("LastVersion must survive eviction")
	}
}

func TestQ216CacheRejectsStaleVersion(t *testing.T) {
	cache := NewCache()
	scope := Scope{Tenant: "t", Origin: q216Origin(t, "https://example.com")}
	cache.Install(scope, q216Rules(t, "User-agent: *\nDisallow: /old\n"), time.Minute)
	expected := cache.CurrentVersion(scope)

	cache.Install(scope, q216Rules(t, "User-agent: *\nDisallow: /new\n"), time.Minute)
	stale := Snapshot{Rules: q216Rules(t, "User-agent: *\nDisallow: /stale\n")}
	current, ok := cache.PutIfVersion(scope, expected, stale, time.Minute)
	if ok {
		t.Fatal("stale write was accepted")
	}
	if current.Version != 2 {
		t.Fatalf("current version = %d", current.Version)
	}
	if q216Snapshot(t, cache, scope).Allowed("*", "/new") {
		t.Fatal("/new should remain disallowed")
	}
	if !q216Snapshot(t, cache, scope).Allowed("*", "/stale") {
		t.Fatal("stale rules were installed")
	}
}

func TestQ216CacheGenerationSurvivesEviction(t *testing.T) {
	cache := NewCache(WithMaxEntries(1))
	a := Scope{Tenant: "t", Origin: q216Origin(t, "https://a.example")}
	b := Scope{Tenant: "t", Origin: q216Origin(t, "https://b.example")}
	cache.Install(a, AllowAllRules(), time.Minute)
	cache.Install(b, AllowAllRules(), time.Minute)
	if cache.CurrentVersion(a) != 0 {
		t.Fatal("a should have been evicted")
	}
	if cache.LastVersion(a) != 1 || cache.CurrentGeneration(a) != 1 {
		t.Fatalf("evicted generation lost: version=%d generation=%d", cache.LastVersion(a), cache.CurrentGeneration(a))
	}

	expected := cache.LastVersion(a)
	installed, ok := cache.PutIfVersion(a, expected, Snapshot{Rules: DisallowAllRules()}, time.Minute)
	if !ok || installed.Generation != 2 {
		t.Fatalf("conditional install after eviction = %+v, %v", installed, ok)
	}
}

func TestQ216CacheClonesRules(t *testing.T) {
	cache := NewCache()
	scope := Scope{Tenant: "t", Origin: q216Origin(t, "https://example.com")}
	rules := q216Rules(t, "User-agent: *\nDisallow: /original\n")
	cache.Install(scope, rules, time.Minute)
	rules.Groups[0].Rules[0].Pattern = "/mutated"
	snapshot := q216Snapshot(t, cache, scope)
	if snapshot.Allowed("*", "/original") {
		t.Fatal("cache rules were mutated through the caller's slice")
	}
}
