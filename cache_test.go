package tickcache

import (
	"fmt"
	"math/rand"
	"sync"
	"testing"
)

// Eviction prefers the lowest frequency.
func TestEvictLowestFrequency(t *testing.T) {
	c := New(2)
	c.Access("a")
	c.Access("a")
	c.Tick() // a: freq 2
	c.Access("b")
	c.Tick() // b: freq 1
	c.Access("c")
	if c.Contains("b") {
		t.Fatal("expected b (lowest freq) to be evicted")
	}
	if !c.Contains("a") || !c.Contains("c") {
		t.Fatal("expected a and c to remain")
	}
}

// On frequency tie, the earliest last access is evicted.
func TestEvictEarliestLastAccess(t *testing.T) {
	c := New(2)
	c.Access("a")
	c.Tick() // a: freq 1, lastAccess 0
	c.Access("b")
	c.Tick() // b: freq 1, lastAccess 1
	c.Access("c")
	if c.Contains("a") {
		t.Fatal("expected a (earliest last access) to be evicted")
	}
	if !c.Contains("b") || !c.Contains("c") {
		t.Fatal("expected b and c to remain")
	}
}

// On frequency and last-access tie, the smallest key is evicted.
func TestEvictSmallestKey(t *testing.T) {
	c := New(2)
	c.Access("b")
	c.Access("a") // same tick: identical freq and lastAccess
	c.Tick()
	c.Access("c")
	if c.Contains("a") {
		t.Fatal("expected a (smallest key) to be evicted")
	}
	if !c.Contains("b") || !c.Contains("c") {
		t.Fatal("expected b and c to remain")
	}
}

// Counts accumulate across ticks and late writes join the original generation.
func TestFixedTickAccumulation(t *testing.T) {
	c := New(0)
	for i := 0; i < 3; i++ {
		c.Access("x")
	}
	c.Tick()
	c.Access("x")
	c.Access("y")
	c.Tick()
	got := c.Snapshot()
	if got["x"] != 4 || got["y"] != 1 {
		t.Fatalf("unexpected snapshot: %v", got)
	}
}

// A barrier releases accessors and the ticker simultaneously, racing
// settlement against access. Settled statistics must match the complete
// event log exactly: every access is counted once, in exactly one
// generation, and no generation is settled twice.
func TestBarrierRaceAgainstEventLog(t *testing.T) {
	const (
		accessors       = 32
		accessesEach    = 500
		ticks           = 300
		numKeys         = 16
		settleHookLimit = ticks + 1
	)

	c := New(0) // unbounded: no eviction, stats must cover every event

	var hookMu sync.Mutex
	settled := make(map[string]uint64)
	settledGens := make(map[uint64]int)
	c.SetSettleHook(func(genID uint64, counts map[string]uint64) {
		hookMu.Lock()
		defer hookMu.Unlock()
		settledGens[genID]++
		for k, n := range counts {
			settled[k] += n
		}
	})

	// Reference: complete event log, one slice per accessor (no sharing).
	logs := make([][]string, accessors)

	var ready, done sync.WaitGroup
	ready.Add(accessors + 1)
	done.Add(accessors + 1)
	start := make(chan struct{})

	for w := 0; w < accessors; w++ {
		go func(w int) {
			defer done.Done()
			rng := rand.New(rand.NewSource(int64(w)))
			log := make([]string, 0, accessesEach)
			ready.Done()
			<-start // barrier: race settlement vs access
			for i := 0; i < accessesEach; i++ {
				key := fmt.Sprintf("k%02d", rng.Intn(numKeys))
				c.Access(key)
				log = append(log, key)
			}
			logs[w] = log
		}(w)
	}
	go func() {
		defer done.Done()
		ready.Done()
		<-start
		for i := 0; i < ticks; i++ {
			c.Tick()
		}
	}()

	ready.Wait()
	close(start) // release the barrier
	done.Wait()

	c.Tick() // settle the final open generation

	want := make(map[string]uint64)
	total := uint64(0)
	for _, log := range logs {
		if len(log) != accessesEach {
			t.Fatalf("event log lost entries: got %d, want %d", len(log), accessesEach)
		}
		for _, k := range log {
			want[k]++
			total++
		}
	}

	hookMu.Lock()
	defer hookMu.Unlock()

	if len(settledGens) > settleHookLimit {
		t.Fatalf("more settled generations than ticks: %d", len(settledGens))
	}
	for id, n := range settledGens {
		if n != 1 {
			t.Fatalf("generation %d settled %d times", id, n)
		}
	}

	var settledTotal uint64
	for k, n := range settled {
		settledTotal += n
		if want[k] != n {
			t.Errorf("key %s: settled %d, event log %d", k, n, want[k])
		}
	}
	if settledTotal != total {
		t.Errorf("settled total %d, event log total %d", settledTotal, total)
	}

	snap := c.Snapshot()
	if len(snap) != len(want) {
		t.Errorf("snapshot has %d keys, event log has %d", len(snap), len(want))
	}
	for k, n := range want {
		if snap[k] != n {
			t.Errorf("snapshot[%s] = %d, want %d", k, snap[k], n)
		}
	}
}
