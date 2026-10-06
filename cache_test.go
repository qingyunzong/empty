package cache

import (
	"errors"
	"testing"
)

func TestGetMissAndHit(t *testing.T) {
	c := New[string, int](100)
	if _, ok := c.Get("a"); ok {
		t.Fatal("unexpected hit on empty cache")
	}
	if err := c.Insert("a", 42, 10); err != nil {
		t.Fatal(err)
	}
	v, ok := c.Get("a")
	if !ok || v != 42 {
		t.Fatalf("got (%v, %v), want (42, true)", v, ok)
	}
	if c.Used() != 10 || c.Len() != 1 {
		t.Fatalf("used=%d len=%d, want 10/1", c.Used(), c.Len())
	}
}

func TestInsertEvictsOldestUnpinned(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 40)
	mustInsert(t, c, "b", 2, 40)
	// Hit on "a" makes "b" the oldest unpinned page.
	if _, ok := c.Get("a"); !ok {
		t.Fatal("miss on a")
	}
	mustInsert(t, c, "c", 3, 40) // needs 20, evicts b (40)
	if _, ok := c.Get("b"); ok {
		t.Fatal("b should have been evicted")
	}
	if _, ok := c.Get("a"); !ok {
		t.Fatal("a should survive")
	}
	if _, ok := c.Get("c"); !ok {
		t.Fatal("c should be present")
	}
	if c.Used() != 80 {
		t.Fatalf("used=%d, want 80", c.Used())
	}
}

func TestLeasePinsAgainstEviction(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 40)
	_, lease, ok := c.Lease("a")
	if !ok {
		t.Fatal("lease miss on a")
	}
	mustInsert(t, c, "b", 2, 40)
	// Only b is evictable; inserting c(40) evicts b, not the pinned a.
	mustInsert(t, c, "c", 3, 40)
	if _, ok := c.pages["b"]; ok {
		t.Fatal("b should have been evicted")
	}
	if _, ok := c.pages["a"]; !ok {
		t.Fatal("pinned a must survive eviction")
	}
	// After release, a becomes the oldest unpinned page and is evicted.
	lease.Release()
	mustInsert(t, c, "d", 4, 40)
	if _, ok := c.pages["a"]; ok {
		t.Fatal("released a should have been evicted")
	}
}

func TestInsertFailureDoesNotPartiallyEvict(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 60)
	_, lease, _ := c.Lease("a") // a pinned
	mustInsert(t, c, "b", 2, 30)
	// used=90, need 50: evicting b (30) is not enough and a is pinned.
	if err := c.Insert("c", 3, 50); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("err=%v, want ErrBudgetExhausted", err)
	}
	// No partial eviction: b must still be cached, state unchanged.
	if _, ok := c.Get("b"); !ok {
		t.Fatal("failed insert must not evict b")
	}
	if _, ok := c.Get("c"); ok {
		t.Fatal("failed insert must not cache c")
	}
	if c.Used() != 90 || c.Len() != 2 {
		t.Fatalf("used=%d len=%d, want 90/2", c.Used(), c.Len())
	}
	lease.Release()
}

func TestInsertFailureWhenEverythingPinned(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 60)
	mustInsert(t, c, "b", 2, 30)
	_, l1, _ := c.Lease("a")
	_, l2, _ := c.Lease("b")
	if err := c.Insert("c", 3, 20); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("err=%v, want ErrBudgetExhausted", err)
	}
	if c.Used() != 90 || c.Len() != 2 {
		t.Fatalf("state changed on failed insert")
	}
	l1.Release()
	l2.Release()
}

func TestDoubleReleaseIsNoop(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 10)
	_, l1, _ := c.Lease("a")
	_, l2, _ := c.Lease("a")
	l1.Release()
	l1.Release() // double release must not unpin l2's pin
	if p := c.pages["a"]; p.pins != 1 {
		t.Fatalf("pins=%d, want 1", p.pins)
	}
	l2.Release()
	l2.Release()
	if p := c.pages["a"]; p.pins != 0 {
		t.Fatalf("pins=%d, want 0", p.pins)
	}
}

func TestReleaseAfterInvalidateIsNoop(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 10)
	_, lease, _ := c.Lease("a")
	c.Invalidate("a")
	lease.Release() // page already gone: must be a no-op
	if c.Used() != 0 || c.Len() != 0 {
		t.Fatalf("used=%d len=%d, want 0/0", c.Used(), c.Len())
	}
	// A new page under the same key must not be affected by the stale lease.
	mustInsert(t, c, "a", 2, 10)
	_, lease2, _ := c.Lease("a")
	lease.Release()
	if p := c.pages["a"]; p.pins != 1 {
		t.Fatalf("pins=%d, want 1 (stale lease leaked)", p.pins)
	}
	lease2.Release()
}

func TestInsertReplace(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 30)
	mustInsert(t, c, "a", 2, 50)
	v, ok := c.Get("a")
	if !ok || v != 2 {
		t.Fatalf("got (%v, %v), want (2, true)", v, ok)
	}
	if c.Used() != 50 || c.Len() != 1 {
		t.Fatalf("used=%d len=%d, want 50/1", c.Used(), c.Len())
	}
}

func TestInsertInvalidSize(t *testing.T) {
	c := New[string, int](100)
	for _, size := range []int64{0, -1, -100} {
		if err := c.Insert("a", 1, size); !errors.Is(err, ErrInvalidSize) {
			t.Fatalf("size=%d: err=%v, want ErrInvalidSize", size, err)
		}
	}
	if c.Len() != 0 {
		t.Fatal("invalid inserts must not cache anything")
	}
}

func TestInsertLargerThanBudget(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 60)
	if err := c.Insert("big", 2, 101); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("err=%v, want ErrBudgetExhausted", err)
	}
	// The failed insert must not have evicted a to make room.
	if _, ok := c.Get("a"); !ok {
		t.Fatal("a must survive the failed oversized insert")
	}
}

func TestInvalidateRemovesAndBumpsVersion(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 1, 10)
	v0 := c.versions["a"]
	c.Invalidate("a")
	if _, ok := c.Get("a"); ok {
		t.Fatal("invalidated page must be gone")
	}
	if c.versions["a"] != v0+1 {
		t.Fatalf("version=%d, want %d", c.versions["a"], v0+1)
	}
	if c.Used() != 0 {
		t.Fatalf("used=%d, want 0", c.Used())
	}
}

func mustInsert(t *testing.T, c *Cache[string, int], key string, value int, size int64) {
	t.Helper()
	if err := c.Insert(key, value, size); err != nil {
		t.Fatalf("Insert(%q, %d): %v", key, size, err)
	}
}
