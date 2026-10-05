package tickcache_test

import (
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"

	"tickcache"
)

func snapshotMap(c *tickcache.Cache) map[string]tickcache.Entry {
	m := make(map[string]tickcache.Entry)
	for _, e := range c.Snapshot() {
		m[e.Key] = e
	}
	return m
}

func requireKeys(t *testing.T, c *tickcache.Cache, want ...string) {
	t.Helper()
	got := snapshotMap(c)
	if len(got) != len(want) {
		t.Fatalf("live keys = %v, want %v", got, want)
	}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Fatalf("missing key %q in %v", k, got)
		}
	}
}

func TestEvictionPolicy(t *testing.T) {
	t.Run("lowest frequency", func(t *testing.T) {
		c := tickcache.New(2)
		c.Access("a")
		c.Access("b")
		c.Access("b")
		c.Access("c")
		c.Access("c")
		c.Settle()
		requireKeys(t, c, "b", "c")
	})

	t.Run("earliest last access", func(t *testing.T) {
		c := tickcache.New(2)
		// a and b tie on frequency 2; a was last touched in tick 1,
		// b in tick 2, so a is evicted. c has a higher frequency.
		c.Access("a")
		c.Access("a")
		c.Access("b")
		c.Settle()
		c.Access("b")
		c.Settle()
		c.Access("c")
		c.Access("c")
		c.Access("c")
		c.Settle()
		requireKeys(t, c, "b", "c")
	})

	t.Run("smallest key", func(t *testing.T) {
		c := tickcache.New(2)
		// a and b tie on frequency and last-access tick; the smaller
		// key a is evicted.
		c.Access("b")
		c.Access("a")
		c.Access("c")
		c.Access("c")
		c.Settle()
		requireKeys(t, c, "b", "c")
	})
}

func TestGetPut(t *testing.T) {
	c := tickcache.New(4)
	c.Put("k", 42)
	if v, ok := c.Get("k"); !ok || v != 42 {
		t.Fatalf("Get(k) = %v, %v; want 42, true", v, ok)
	}
	if _, ok := c.Get("missing"); ok {
		t.Fatal("Get(missing) reported a hit")
	}
	c.Settle()
	got := snapshotMap(c)
	// k: Put + Get = 2 accesses; missing: 1 access.
	if got["k"].Freq != 2 || got["missing"].Freq != 1 {
		t.Fatalf("unexpected stats: %v", got)
	}
}

// refModel is an independent reference implementation used to replay
// the complete event log and cross-check the cache.
type refModel struct {
	cap  int
	tick uint64
	cur  map[string]int
	live map[string]tickcache.Entry
}

func newRefModel(capacity int) *refModel {
	return &refModel{
		cap:  capacity,
		cur:  make(map[string]int),
		live: make(map[string]tickcache.Entry),
	}
}

func (m *refModel) access(key string) { m.cur[key]++ }

func (m *refModel) settle() {
	m.tick++
	for key, n := range m.cur {
		e := m.live[key]
		e.Key = key
		e.Freq += n
		e.Last = m.tick
		m.live[key] = e
	}
	m.cur = make(map[string]int)
	for len(m.live) > m.cap {
		victim := ""
		var ve tickcache.Entry
		first := true
		for key, e := range m.live {
			if first || e.Freq < ve.Freq ||
				(e.Freq == ve.Freq && (e.Last < ve.Last ||
					(e.Last == ve.Last && key < victim))) {
				victim, ve = key, e
				first = false
			}
		}
		delete(m.live, victim)
	}
}

func TestReferenceReplay(t *testing.T) {
	const (
		capacity = 3
		ops      = 500
	)
	keys := []string{"a", "b", "c", "d", "e", "f"}
	rng := rand.New(rand.NewSource(1))

	c := tickcache.New(capacity)
	ref := newRefModel(capacity)

	for i := 0; i < ops; i++ {
		// ~1 in 5 operations settles the tick.
		if rng.Intn(5) == 0 {
			c.Settle()
			ref.settle()
			got := snapshotMap(c)
			if len(got) != len(ref.live) {
				t.Fatalf("op %d: live keys = %v, want %v", i, got, ref.live)
			}
			for key, want := range ref.live {
				if got[key] != want {
					t.Fatalf("op %d: key %q = %+v, want %+v", i, key, got[key], want)
				}
			}
			if c.Tick() != ref.tick {
				t.Fatalf("op %d: tick = %d, want %d", i, c.Tick(), ref.tick)
			}
			continue
		}
		key := keys[rng.Intn(len(keys))]
		c.Access(key)
		ref.access(key)
	}
}

// TestSettleAccessRace uses a barrier to release one settler and many
// accessors simultaneously each round, then compares the per-key
// statistics against the complete count of issued accesses. Capacity
// covers all keys, so no access may be lost or misattributed.
func TestSettleAccessRace(t *testing.T) {
	const (
		workers = 8
		rounds  = 300
	)
	keys := []string{"a", "b", "c", "d", "e", "f", "g", "h"}
	c := tickcache.New(len(keys))

	var mu sync.Mutex
	want := make(map[string]int)

	for r := 0; r < rounds; r++ {
		start := make(chan struct{})
		var wg sync.WaitGroup
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func(w int) {
				defer wg.Done()
				<-start
				if w == 0 {
					c.Settle()
					return
				}
				key := keys[(r+w)%len(keys)]
				c.Access(key)
				mu.Lock()
				want[key]++
				mu.Unlock()
			}(w)
		}
		close(start)
		wg.Wait()
	}
	c.Settle() // flush the pending generation

	if got, wantTick := c.Tick(), uint64(rounds+1); got != wantTick {
		t.Fatalf("tick = %d, want %d", got, wantTick)
	}
	got := snapshotMap(c)
	if len(got) != len(want) {
		t.Fatalf("live keys = %v, want counts %v", got, want)
	}
	for key, n := range want {
		if got[key].Freq != n {
			t.Errorf("key %q: freq = %d, want %d", key, got[key].Freq, n)
		}
	}
}

// TestEvictionAccountingUnderRace races accesses against settlements
// with a capacity smaller than the key set, and verifies that every
// issued access is accounted for: live + evicted == issued, with
// nothing left pending once quiescent.
func TestEvictionAccountingUnderRace(t *testing.T) {
	const (
		workers = 8
		rounds  = 300
		keys    = 10
	)
	c := tickcache.New(3)
	var issued atomic.Int64

	for r := 0; r < rounds; r++ {
		start := make(chan struct{})
		var wg sync.WaitGroup
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func(w int) {
				defer wg.Done()
				<-start
				if w == 0 {
					c.Settle()
					return
				}
				c.Access(fmt.Sprintf("k%d", (r+w)%keys))
				issued.Add(1)
			}(w)
		}
		close(start)
		wg.Wait()
	}
	c.Settle()

	live, evicted, pending := c.Totals()
	if pending != 0 {
		t.Errorf("pending = %d after final settle, want 0", pending)
	}
	if total := live + evicted; total != int(issued.Load()) {
		t.Errorf("live+evicted = %d, want %d issued accesses", total, issued.Load())
	}
	if n := len(c.Snapshot()); n > 3 {
		t.Errorf("live entries = %d, want at most capacity 3", n)
	}
}
