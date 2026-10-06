package cache

import (
	"fmt"
	"math/rand"
	"testing"
)

// modelEntry mirrors one cached page in the reference model.
type modelEntry struct {
	value  int
	size   int64
	seq    uint64
	leases int
}

// model is a deliberately simple reference implementation: every operation
// is a full linear scan over a plain map. The randomized test cross-checks
// the real Cache against it after every single operation.
type model struct {
	budget int64
	used   int64
	seq    uint64
	pages  map[string]*modelEntry
}

func newModel(budget int64) *model {
	return &model{budget: budget, pages: make(map[string]*modelEntry)}
}

func (m *model) get(key string) (int, bool) {
	e, ok := m.pages[key]
	if !ok {
		return 0, false
	}
	m.seq++
	e.seq = m.seq
	return e.value, true
}

// modelLease mirrors Lease: a handle bound to one page instance, so that a
// lease taken before a replacement still pins the old page, never the new one.
type modelLease struct {
	e        *modelEntry
	released bool
}

func (m *model) lease(key string) (*modelLease, bool) {
	e, ok := m.pages[key]
	if !ok {
		return nil, false
	}
	e.leases++
	m.seq++
	e.seq = m.seq
	return &modelLease{e: e}, true
}

func (m *model) release(l *modelLease) bool {
	if l.released {
		return false
	}
	l.released = true
	l.e.leases--
	return true
}

func (m *model) put(key string, value int, size int64) error {
	var oldSize int64
	if old, ok := m.pages[key]; ok {
		oldSize = old.size
	}
	need := m.used - oldSize + size
	if need > m.budget {
		// Full scan: sum every evictable byte.
		var evictable int64
		for k, e := range m.pages {
			if k != key && e.leases == 0 {
				evictable += e.size
			}
		}
		if need-evictable > m.budget {
			return ErrBudgetExceeded
		}
		// Full scan per eviction: find the oldest unleased page.
		for m.used-oldSize+size > m.budget {
			var victimKey string
			var victim *modelEntry
			for k, e := range m.pages {
				if k == key || e.leases > 0 {
					continue
				}
				if victim == nil || e.seq < victim.seq {
					victim, victimKey = e, k
				}
			}
			if victim == nil {
				t := fmt.Sprintf("model: infeasible eviction for key %q", key)
				panic(t)
			}
			delete(m.pages, victimKey)
			m.used -= victim.size
		}
	}
	m.used += size - oldSize
	m.seq++
	m.pages[key] = &modelEntry{value: value, size: size, seq: m.seq}
	return nil
}

func (m *model) invalidate(key string) {
	if e, ok := m.pages[key]; ok {
		m.used -= e.size
		delete(m.pages, key)
	}
}

// checkEqual compares every observable bit of cache state against the model.
func checkEqual(t *testing.T, c *Cache, m *model, op string) {
	t.Helper()
	if c.Used() != m.used {
		t.Fatalf("after %s: used = %d, model = %d", op, c.Used(), m.used)
	}
	snap := c.snapshot()
	if len(snap) != len(m.pages) {
		t.Fatalf("after %s: %d pages, model has %d", op, len(snap), len(m.pages))
	}
	for k, e := range m.pages {
		pi, ok := snap[k]
		if !ok {
			t.Fatalf("after %s: key %q missing from cache", op, k)
		}
		if pi.Size != e.size || pi.Seq != e.seq || pi.Leases != e.leases || pi.Value != e.value {
			t.Fatalf("after %s: key %q = %+v, model = %+v", op, k, pi, *e)
		}
	}
}

// TestRandomOpsAgainstModel hammers the cache with random gets, puts, leases,
// releases (including duplicate releases) and invalidations, checking the
// full state against the simple full-scan model after every operation.
func TestRandomOpsAgainstModel(t *testing.T) {
	for _, seed := range []int64{1, 7, 42, 1999, 20261006} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			budget := int64(1 + rng.Intn(200))
			c := New(budget)
			m := newModel(budget)

			keys := make([]string, 8)
			for i := range keys {
				keys[i] = fmt.Sprintf("k%d", i)
			}
			// Outstanding leases held by the "client", per key.
			type heldLease struct {
				cl *Lease
				ml *modelLease
			}
			held := make(map[string][]heldLease)

			for step := 0; step < 20000; step++ {
				key := keys[rng.Intn(len(keys))]
				var op string
				switch rng.Intn(6) {
				case 0, 1: // Get
					op = fmt.Sprintf("get(%s)", key)
					gotV, gotOK := c.Get(key)
					wantV, wantOK := m.get(key)
					if gotOK != wantOK || (gotOK && gotV != wantV) {
						t.Fatalf("step %d %s: got (%v,%v), want (%v,%v)",
							step, op, gotV, gotOK, wantV, wantOK)
					}
				case 2, 3: // Put
					value := rng.Intn(1000)
					size := int64(rng.Intn(int(budget) + 40))
					op = fmt.Sprintf("put(%s,%d,%d)", key, value, size)
					gotErr := c.Put(key, value, size)
					wantErr := m.put(key, value, size)
					if (gotErr == nil) != (wantErr == nil) {
						t.Fatalf("step %d %s: err %v, model err %v", step, op, gotErr, wantErr)
					}
				case 4: // Lease / Release / duplicate Release
					if leases := held[key]; len(leases) > 0 && rng.Intn(2) == 0 {
						i := rng.Intn(len(leases))
						h := leases[i]
						held[key] = append(leases[:i], leases[i+1:]...)
						op = fmt.Sprintf("release(%s)", key)
						if !h.cl.Release() {
							t.Fatalf("step %d %s: first release rejected", step, op)
						}
						if !m.release(h.ml) {
							t.Fatalf("step %d %s: model first release rejected", step, op)
						}
						// Duplicate release must be invalid and a no-op.
						if h.cl.Release() {
							t.Fatalf("step %d %s: duplicate release accepted", step, op)
						}
						if h.cl.Release() {
							t.Fatalf("step %d %s: triple release accepted", step, op)
						}
						if m.release(h.ml) || m.release(h.ml) {
							t.Fatalf("step %d %s: model duplicate release accepted", step, op)
						}
					} else {
						op = fmt.Sprintf("lease(%s)", key)
						cl, gotOK := c.Lease(key)
						ml, wantOK := m.lease(key)
						if gotOK != wantOK {
							t.Fatalf("step %d %s: ok=%v, model ok=%v", step, op, gotOK, wantOK)
						}
						if gotOK {
							held[key] = append(held[key], heldLease{cl: cl, ml: ml})
						}
					}
				case 5: // Invalidate
					op = fmt.Sprintf("invalidate(%s)", key)
					c.Invalidate(key)
					m.invalidate(key)
				}
				checkEqual(t, c, m, fmt.Sprintf("step %d %s", step, op))
				if c.Used() > budget {
					t.Fatalf("step %d %s: used %d exceeds budget %d", step, op, c.Used(), budget)
				}
			}
		})
	}
}

// TestPutFailureLeavesCacheUntouched pins the atomicity rule directly:
// a failing insert must not evict anything.
func TestPutFailureLeavesCacheUntouched(t *testing.T) {
	c := New(100)
	if err := c.Put("a", "A", 60); err != nil {
		t.Fatal(err)
	}
	if err := c.Put("b", "B", 40); err != nil {
		t.Fatal(err)
	}
	la, _ := c.Lease("a")
	lb, _ := c.Lease("b")
	defer la.Release()
	defer lb.Release()

	before := c.snapshot()
	// Both pages leased: nothing is evictable, so this must fail cleanly.
	if err := c.Put("c", "C", 50); err != ErrBudgetExceeded {
		t.Fatalf("expected ErrBudgetExceeded, got %v", err)
	}
	after := c.snapshot()
	if len(before) != len(after) {
		t.Fatalf("failed put changed page set: %v -> %v", before, after)
	}
	for k, v := range before {
		if after[k] != v {
			t.Fatalf("failed put changed key %q: %v -> %v", k, v, after[k])
		}
	}
	if c.Used() != 100 {
		t.Fatalf("used = %d, want 100", c.Used())
	}
}

// TestEvictsOldestUnleasedOnly checks victim selection order.
func TestEvictsOldestUnleasedOnly(t *testing.T) {
	c := New(100)
	mustPut := func(k string, size int64) {
		t.Helper()
		if err := c.Put(k, k, size); err != nil {
			t.Fatalf("put %s: %v", k, err)
		}
	}
	mustPut("old", 30)
	mustPut("mid", 30)
	mustPut("new", 40)

	// Refresh "new" so "old" is the oldest unleased page; lease "mid" so it
	// is skipped despite being older than "new".
	if _, ok := c.Get("new"); !ok {
		t.Fatal("new missing")
	}
	l, ok := c.Lease("mid")
	if !ok {
		t.Fatal("mid missing")
	}
	defer l.Release()

	mustPut("big", 30) // needs 30: must evict "old" (oldest unleased), not leased "mid"
	if c.Has("old") {
		t.Fatal("old should have been evicted")
	}
	if !c.Has("mid") || !c.Has("new") || !c.Has("big") {
		t.Fatalf("unexpected page set: %v", c.snapshot())
	}
}

// TestDuplicateRelease verifies a double release does not over-decrement.
func TestDuplicateRelease(t *testing.T) {
	c := New(100)
	if err := c.Put("p", 1, 90); err != nil {
		t.Fatal(err)
	}
	l1, _ := c.Lease("p")
	l2, _ := c.Lease("p")
	if !l1.Release() || l1.Release() {
		t.Fatal("duplicate release must be invalid")
	}
	// One lease remains: the page must still be unevictable.
	if err := c.Put("q", 2, 50); err != ErrBudgetExceeded {
		t.Fatalf("expected ErrBudgetExceeded, got %v", err)
	}
	if !l2.Release() {
		t.Fatal("second distinct lease must release")
	}
	if err := c.Put("q", 2, 50); err != nil {
		t.Fatalf("after full release put should succeed: %v", err)
	}
	if c.Has("p") {
		t.Fatal("p should have been evicted once unleased")
	}
}
