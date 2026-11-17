package formal

import (
	"errors"
	"fmt"
	"net/netip"
	"runtime"
	"sync"
	"testing"
	"time"
)

var testDst = netip.MustParseAddr("203.0.113.10")

func flowKey(i int) FiveTuple {
	return FiveTuple{
		SrcAddr: netip.AddrFrom4([4]byte{
			10,
			byte(i >> 16),
			byte(i >> 8),
			byte(i),
		}),
		SrcPort:  uint16(1024 + i%50000),
		DstAddr:  testDst,
		DstPort:  443,
		Protocol: 6,
	}
}

func testBackends() []Backend {
	return []Backend{
		{ID: "a", Addr: "10.0.0.1:80", Weight: 1},
		{ID: "b", Addr: "10.0.0.2:80", Weight: 2},
		{ID: "c", Addr: "10.0.0.3:80", Weight: 3},
	}
}

func mustTable(t *testing.T, cfg Config) *Table {
	t.Helper()
	tbl, err := NewTable(cfg)
	if err != nil {
		t.Fatalf("NewTable: %v", err)
	}
	return tbl
}

func TestWeightedDistribution(t *testing.T) {
	tbl := mustTable(t, Config{Backends: testBackends()})

	const n = 120000
	counts := make(map[string]int)
	for i := 0; i < n; i++ {
		c, err := tbl.Open(flowKey(i))
		if err != nil {
			t.Fatalf("Open(%d): %v", i, err)
		}
		counts[c.Backend.ID]++
	}

	totalWeight := 6.0
	for _, b := range testBackends() {
		want := float64(b.Weight) / totalWeight
		got := float64(counts[b.ID]) / n
		t.Logf("%s weight=%d share=%.4f want=%.4f error=%+.4f",
			b.ID, b.Weight, got, want, got-want)
		if diff := got - want; diff < -0.02 || diff > 0.02 {
			t.Errorf("%s share %.4f differs from %.4f by %+.4f (limit 0.02)",
				b.ID, got, want, diff)
		}
	}
	if got := len(counts); got != 3 {
		t.Fatalf("used %d backends, want 3", got)
	}
}

func TestWeightedDistributionAfterNodeChurn(t *testing.T) {
	tbl := mustTable(t, Config{Backends: []Backend{
		{ID: "a", Addr: "10.0.0.1:80", Weight: 1},
		{ID: "b", Addr: "10.0.0.2:80", Weight: 1},
		{ID: "c", Addr: "10.0.0.3:80", Weight: 1},
	}})

	// Keep some pre-churn flows active to ensure the churn does not disturb
	// them while new flows see the new weights.
	var old []Conn
	for i := 0; i < 300; i++ {
		c, err := tbl.Open(flowKey(i))
		if err != nil {
			t.Fatalf("pre-churn Open: %v", err)
		}
		old = append(old, c)
	}
	if err := tbl.SetBackends([]Backend{
		{ID: "b", Addr: "10.0.0.2:80", Weight: 1},
		{ID: "c", Addr: "10.0.0.3:80", Weight: 1},
		{ID: "d", Addr: "10.0.0.4:80", Weight: 2},
	}); err != nil {
		t.Fatalf("SetBackends: %v", err)
	}
	for _, c := range old {
		got, ok := tbl.Lookup(c.Key)
		if !ok || got.Generation != c.Generation || got.Backend != c.Backend || !got.IsActive() {
			t.Fatalf("pre-churn active flow crossed: %+v -> %+v", c, got)
		}
	}

	const n = 120000
	weights := map[string]int{"b": 1, "c": 1, "d": 2}
	counts := make(map[string]int)
	for i := 0; i < n; i++ {
		c, err := tbl.Open(flowKey(1_000_000 + i))
		if err != nil {
			t.Fatalf("post-churn Open: %v", err)
		}
		counts[c.Backend.ID]++
	}
	for id, weight := range weights {
		want := float64(weight) / 4
		got := float64(counts[id]) / n
		t.Logf("%s post-churn share=%.4f want=%.4f error=%+.4f", id, got, want, got-want)
		if diff := got - want; diff < -0.025 || diff > 0.025 {
			t.Errorf("%s post-churn share %.4f differs from %.4f by %+.4f",
				id, got, want, diff)
		}
	}
	if counts["a"] != 0 {
		t.Fatalf("removed backend got %d new flows", counts["a"])
	}
}

func TestActiveBindingsSurviveBackendChanges(t *testing.T) {
	tbl := mustTable(t, Config{Backends: testBackends()})

	active := make([]Conn, 0, 600)
	for i := 0; i < 600; i++ {
		c, err := tbl.Open(flowKey(i))
		if err != nil {
			t.Fatalf("Open(%d): %v", i, err)
		}
		active = append(active, c)
	}

	changed := []Backend{
		{ID: "b", Addr: "10.0.0.2:80", Weight: 1},
		{ID: "c", Addr: "10.0.0.3:80", Weight: 1},
		{ID: "d", Addr: "10.0.0.4:80", Weight: 1},
	}
	if err := tbl.SetBackends(changed); err != nil {
		t.Fatalf("SetBackends: %v", err)
	}

	for i, before := range active {
		after, ok := tbl.Lookup(before.Key)
		if !ok {
			t.Fatalf("flow %d disappeared during backend change", i)
		}
		if after.Generation != before.Generation {
			t.Fatalf("flow %d generation changed: %d -> %d", i, before.Generation, after.Generation)
		}
		if after.Backend != before.Backend {
			t.Fatalf("flow %d backend crossed: %+v -> %+v", i, before.Backend, after.Backend)
		}
		if !after.IsActive() {
			t.Fatalf("flow %d is no longer active", i)
		}
	}

	// Reopening a closed tuple whose backend is still eligible keeps its
	// affinity; one whose backend disappeared must be assigned afresh.
	for _, before := range active {
		if _, err := tbl.Close(before.Key, before.Generation); err != nil {
			t.Fatalf("Close: %v", err)
		}
		after, err := tbl.Open(before.Key)
		if err != nil {
			t.Fatalf("reopen: %v", err)
		}
		if after.Backend.ID == "a" {
			t.Fatalf("removed backend selected for reopen: %+v", after.Backend)
		}
		if before.Backend.ID != "a" && after.Backend.ID != before.Backend.ID {
			t.Fatalf("eligible backend affinity lost: %s -> %s", before.Backend.ID, after.Backend.ID)
		}
	}
}

func TestNATPortReuseGenerationIsolation(t *testing.T) {
	tbl := mustTable(t, Config{Backends: testBackends()})
	key := flowKey(7)

	first, err := tbl.Open(key)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := tbl.Open(key); !errors.Is(err, ErrFlowActive) {
		t.Fatalf("second active Open error = %v, want ErrFlowActive", err)
	}
	firstResult, err := tbl.Close(key, first.Generation)
	if err != nil {
		t.Fatalf("Close first: %v", err)
	}
	if !firstResult.Closed {
		t.Fatal("first Close did not close the connection")
	}

	second, err := tbl.Open(key)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if second.Generation <= first.Generation {
		t.Fatalf("generation did not advance: %d -> %d", first.Generation, second.Generation)
	}
	if second.Backend != first.Backend {
		t.Fatalf("closed-tuple affinity lost: %+v -> %+v", first.Backend, second.Backend)
	}
	if stats := tbl.Stats(); stats.Active != 1 || stats.Closed != 0 {
		t.Fatalf("stats after reopen: %+v", stats)
	}

	if _, err := tbl.Close(key, first.Generation); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale Close error = %v, want ErrStaleGeneration", err)
	}
	if _, err := tbl.Touch(key, first.Generation); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale Touch error = %v, want ErrStaleGeneration", err)
	}
	got, ok := tbl.Lookup(key)
	if !ok || !got.IsActive() || got.Generation != second.Generation {
		t.Fatalf("stale release disturbed replacement: %+v, ok=%v", got, ok)
	}

	if _, err := tbl.Touch(key, second.Generation); err != nil {
		t.Fatalf("current Touch: %v", err)
	}
	if _, err := tbl.Close(key, second.Generation); err != nil {
		t.Fatalf("Close second: %v", err)
	}
	if stats := tbl.Stats(); stats.Active != 0 || stats.Closed != 1 {
		t.Fatalf("stats after second close: %+v", stats)
	}

	// Stale releases for a closed entry are rejected as well.
	if _, err := tbl.Close(key, first.Generation); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale Close after second release = %v", err)
	}
	if stats := tbl.Stats(); stats.StaleReleases < 3 {
		t.Fatalf("StaleReleases = %d, want at least 3", stats.StaleReleases)
	}
}

func TestDrainMigratesOnlyClosedConnections(t *testing.T) {
	tbl := mustTable(t, Config{Backends: []Backend{
		{ID: "a", Addr: "10.0.0.1:80", Weight: 1},
		{ID: "b", Addr: "10.0.0.2:80", Weight: 1},
	}})

	const n = 600
	conns := make([]Conn, 0, n)
	for i := 0; i < n; i++ {
		c, err := tbl.Open(flowKey(i))
		if err != nil {
			t.Fatalf("Open(%d): %v", i, err)
		}
		conns = append(conns, c)
	}

	var activeA, closedA []Conn
	for _, c := range conns {
		if c.Backend.ID != "a" {
			continue
		}
		if len(activeA) < 60 {
			activeA = append(activeA, c)
		} else if len(closedA) < 20 {
			if _, err := tbl.Close(c.Key, c.Generation); err != nil {
				t.Fatalf("Close: %v", err)
			}
			closedA = append(closedA, c)
		}
	}
	if len(activeA) < 30 || len(closedA) < 10 {
		t.Fatalf("test setup found too few A flows: active=%d closed=%d", len(activeA), len(closedA))
	}

	// Reopen a closed A flow so it is active again; drain must leave it alone.
	reopenedA, err := tbl.Open(closedA[0].Key)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if reopenedA.Backend.ID != "a" {
		t.Fatalf("reopen affinity lost: %+v", reopenedA.Backend)
	}

	before := tbl.Stats()
	res, err := tbl.Drain("a")
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if res.Active < len(activeA) {
		t.Fatalf("Drain.Active = %d, want at least %d", res.Active, len(activeA))
	}
	if res.Migrated < len(closedA)-1 {
		t.Fatalf("Drain.Migrated = %d, want at least %d", res.Migrated, len(closedA)-1)
	}
	if got := tbl.Stats().Migrations; got <= before.Migrations {
		t.Fatalf("migration counter did not advance: %d -> %d", before.Migrations, got)
	}

	for _, c := range activeA {
		got, ok := tbl.Lookup(c.Key)
		if !ok || !got.IsActive() {
			t.Fatalf("active flow missing after drain: %+v", got)
		}
		if got.Backend.ID != "a" || got.Generation != c.Generation {
			t.Fatalf("active flow migrated during drain: %+v -> %+v", c, got)
		}
	}
	for _, c := range closedA[1:] {
		got, ok := tbl.Lookup(c.Key)
		if !ok || got.IsActive() {
			t.Fatalf("closed tombstone state wrong after drain: %+v", got)
		}
		if got.Backend.ID == "a" {
			t.Fatalf("closed tombstone stayed on drained backend: %+v", got)
		}
	}

	// New flows must avoid the drained backend.
	for i := n; i < n+200; i++ {
		c, err := tbl.Open(flowKey(i))
		if err != nil {
			t.Fatalf("new Open: %v", err)
		}
		if c.Backend.ID == "a" {
			t.Fatalf("drained backend accepted new flow: %+v", c)
		}
	}

	// Closing an active A flow migrates only that now-closed tombstone.
	closing := activeA[0]
	result, err := tbl.Close(closing.Key, closing.Generation)
	if err != nil {
		t.Fatalf("Close active A: %v", err)
	}
	if !result.Closed || !result.Migrated || result.Backend.ID == "a" {
		t.Fatalf("close during drain = %+v, want closed+migrated off a", result)
	}
	got, _ := tbl.Lookup(closing.Key)
	if got.IsActive() || got.Backend.ID == "a" {
		t.Fatalf("closed flow not migrated: %+v", got)
	}
}

func TestDrainThenSetBackendsKeepsDrainingFlag(t *testing.T) {
	tbl := mustTable(t, Config{Backends: testBackends()})
	if _, err := tbl.Drain("b"); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if err := tbl.SetBackends(testBackends()); err != nil {
		t.Fatalf("SetBackends: %v", err)
	}
	for _, b := range tbl.Backends() {
		if b.Backend.ID == "b" && !b.Draining {
			t.Fatal("SetBackends cleared the draining flag")
		}
	}
	for i := 0; i < 200; i++ {
		c, err := tbl.Open(flowKey(i))
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		if c.Backend.ID == "b" {
			t.Fatalf("draining backend accepted new flow: %+v", c)
		}
	}
	if err := tbl.Undrain("b"); err != nil {
		t.Fatalf("Undrain: %v", err)
	}
	seenB := false
	for i := 200; i < 2000; i++ {
		c, err := tbl.Open(flowKey(i))
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		seenB = seenB || c.Backend.ID == "b"
	}
	if !seenB {
		t.Fatal("undrained backend never received a new flow")
	}
}

type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func TestIdleTimeoutAndDrainMigration(t *testing.T) {
	clock := &manualClock{now: time.Unix(1_700_000_000, 0)}
	tbl := mustTable(t, Config{
		Backends: []Backend{
			{ID: "a", Addr: "10.0.0.1:80", Weight: 1},
			{ID: "b", Addr: "10.0.0.2:80", Weight: 1},
		},
		IdleTimeout: 10 * time.Second,
		Now:         clock.Now,
	})

	var onA, others []Conn
	for i := 0; len(onA) < 20; i++ {
		c, err := tbl.Open(flowKey(i))
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		if c.Backend.ID == "a" {
			onA = append(onA, c)
		} else {
			others = append(others, c)
		}
	}
	for _, c := range others {
		if _, err := tbl.Close(c.Key, c.Generation); err != nil {
			t.Fatalf("close non-drained flow: %v", err)
		}
	}
	if _, err := tbl.Drain("a"); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	for _, c := range onA {
		got, _ := tbl.Lookup(c.Key)
		if !got.IsActive() || got.Backend.ID != "a" {
			t.Fatalf("active flow changed at drain: %+v", got)
		}
	}

	clock.Advance(9 * time.Second)
	if n := tbl.Sweep(); n != 0 {
		t.Fatalf("Sweep before timeout closed %d flows", n)
	}
	if _, err := tbl.Touch(onA[0].Key, onA[0].Generation); err != nil {
		t.Fatalf("Touch: %v", err)
	}

	clock.Advance(2 * time.Second)
	if n := tbl.Sweep(); n != len(onA)-1 {
		t.Fatalf("Sweep closed %d flows, want %d", n, len(onA)-1)
	}
	for i, c := range onA {
		got, ok := tbl.Lookup(c.Key)
		if i == 0 {
			if !ok || !got.IsActive() {
				t.Fatalf("touched flow %d expired early: %+v", i, got)
			}
			continue
		}
		if !ok || got.IsActive() {
			t.Fatalf("flow %d not expired: %+v", i, got)
		}
		if got.Backend.ID == "a" {
			t.Fatalf("expired flow %d stayed on drained backend: %+v", i, got)
		}
	}
	if stats := tbl.Stats(); stats.Active != 1 || stats.Expired != uint64(len(onA)-1) {
		t.Fatalf("stats after expiry: %+v", stats)
	}

	// The touched connection must survive until its refreshed deadline.
	clock.Advance(8 * time.Second)
	if n := tbl.Sweep(); n != 1 {
		t.Fatalf("touched flow expiry sweep=%d, want 1", n)
	}
	if stats := tbl.Stats(); stats.Active != 0 || stats.Expired != uint64(len(onA)) {
		t.Fatalf("stats after final expiry: %+v", stats)
	}
}

func TestConcurrentPortReuseHasSingleActiveGeneration(t *testing.T) {
	tbl := mustTable(t, Config{Backends: testBackends()})
	key := flowKey(12345)

	for round := 0; round < 200; round++ {
		start := make(chan struct{})
		var wg sync.WaitGroup
		results := make(chan Conn, 32)
		errs := make(chan error, 32)
		for i := 0; i < 32; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				c, err := tbl.Open(key)
				if err != nil {
					errs <- err
					return
				}
				results <- c
			}()
		}
		close(start)
		wg.Wait()
		close(results)
		close(errs)

		var winner Conn
		winners := 0
		for c := range results {
			winner = c
			winners++
		}
		if winners != 1 {
			t.Fatalf("round %d: %d concurrent opens succeeded, want 1", round, winners)
		}
		for err := range errs {
			if !errors.Is(err, ErrFlowActive) {
				t.Fatalf("round %d: loser error = %v, want ErrFlowActive", round, err)
			}
		}
		got, ok := tbl.Lookup(key)
		if !ok || !got.IsActive() || got.Generation != winner.Generation {
			t.Fatalf("round %d: winner not in table: %+v", round, got)
		}
		if _, err := tbl.Close(key, winner.Generation); err != nil {
			t.Fatalf("round %d: close: %v", round, err)
		}
	}
}

func TestNodeChurnUnderConcurrentConnections(t *testing.T) {
	tbl := mustTable(t, Config{
		Backends:              testBackends(),
		IdleTimeout:           time.Hour,
		VirtualNodesPerWeight: 256,
	})

	const (
		workers    = 12
		iterations = 800
	)

	var wg sync.WaitGroup
	stop := make(chan struct{})
	errCh := make(chan error, workers+2)

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				key := flowKey(worker*iterations + i)
				conn, err := tbl.Open(key)
				if err != nil {
					errCh <- fmt.Errorf("worker %d open: %w", worker, err)
					return
				}
				for j := 0; j < 4; j++ {
					got, ok := tbl.Lookup(key)
					if !ok {
						errCh <- fmt.Errorf("worker %d lost flow %s", worker, key)
						return
					}
					if got.Generation != conn.Generation || got.Backend != conn.Backend || !got.IsActive() {
						errCh <- fmt.Errorf("worker %d active flow crossed: %+v -> %+v", worker, conn, got)
						return
					}
					if _, err := tbl.Touch(key, conn.Generation); err != nil {
						errCh <- fmt.Errorf("worker %d touch: %w", worker, err)
						return
					}
				}
				if _, err := tbl.Close(key, conn.Generation); err != nil {
					errCh <- fmt.Errorf("worker %d close: %w", worker, err)
					return
				}
			}
		}(w)
	}

	churnSets := [][]Backend{
		{
			{ID: "a", Addr: "10.0.0.1:80", Weight: 1},
			{ID: "b", Addr: "10.0.0.2:80", Weight: 1},
			{ID: "c", Addr: "10.0.0.3:80", Weight: 1},
		},
		{
			{ID: "b", Addr: "10.0.0.2:80", Weight: 2},
			{ID: "c", Addr: "10.0.0.3:80", Weight: 1},
			{ID: "d", Addr: "10.0.0.4:80", Weight: 1},
		},
		{
			{ID: "a", Addr: "10.0.0.1:80", Weight: 2},
			{ID: "c", Addr: "10.0.0.3:80", Weight: 2},
			{ID: "d", Addr: "10.0.0.4:80", Weight: 1},
			{ID: "e", Addr: "10.0.0.5:80", Weight: 1},
		},
	}
	var churnWG sync.WaitGroup
	churnWG.Add(1)
	go func() {
		defer churnWG.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			if err := tbl.SetBackends(churnSets[i%len(churnSets)]); err != nil {
				errCh <- fmt.Errorf("churn SetBackends: %w", err)
				return
			}
			id := []string{"a", "b", "c", "d", "e"}[i%5]
			_, _ = tbl.Drain(id)
			_ = tbl.Undrain(id)
			runtime.Gosched()
		}
	}()

	wg.Wait()
	close(stop)
	churnWG.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}

	stats := tbl.Stats()
	if stats.Active != 0 {
		t.Fatalf("Active = %d after all workers closed", stats.Active)
	}
	if stats.Generations != workers*iterations {
		t.Fatalf("Generations = %d, want %d", stats.Generations, workers*iterations)
	}
}

func TestConcurrentTimeoutChurnNeverCrossesActiveBinding(t *testing.T) {
	clock := &manualClock{now: time.Unix(1_700_000_000, 0)}
	tbl := mustTable(t, Config{
		Backends:              testBackends(),
		IdleTimeout:           40 * time.Millisecond,
		Now:                   clock.Now,
		VirtualNodesPerWeight: 256,
	})

	const (
		workers    = 8
		iterations = 120
	)

	type binding struct {
		generation uint64
		backend    Backend
	}
	active := make(map[uint64]binding)
	var activeMu sync.Mutex

	var workersWG sync.WaitGroup
	stop := make(chan struct{})
	errCh := make(chan error, workers+2)

	for w := 0; w < workers; w++ {
		workersWG.Add(1)
		go func(worker int) {
			defer workersWG.Done()
			for i := 0; i < iterations; i++ {
				key := flowKey(1_000_000 + worker*iterations + i)
				conn, err := tbl.Open(key)
				if err != nil {
					errCh <- fmt.Errorf("worker %d open: %w", worker, err)
					return
				}
				activeMu.Lock()
				active[conn.Generation] = binding{conn.Generation, conn.Backend}
				activeMu.Unlock()

				closed := false
				for spin := 0; spin < 20; spin++ {
					if worker%2 == 1 && spin == 1 {
						// Deterministically exercise concurrent timeout
						// expiry instead of relying on scheduler timing.
						clock.Advance(50 * time.Millisecond)
						tbl.Sweep()
					}
					got, ok := tbl.Lookup(key)
					if !ok {
						errCh <- fmt.Errorf("worker %d lost tombstone for %s", worker, key)
						return
					}
					if got.Generation != conn.Generation {
						errCh <- fmt.Errorf("worker %d generation crossed: %d -> %d",
							worker, conn.Generation, got.Generation)
						return
					}
					if got.IsActive() {
						activeMu.Lock()
						orig := active[conn.Generation]
						activeMu.Unlock()
						if got.Backend != orig.backend {
							errCh <- fmt.Errorf("worker %d active binding crossed while churning: %+v -> %+v",
								worker, orig.backend, got.Backend)
							return
						}
					} else {
						closed = true
						break
					}
					if worker%3 == 0 && spin%10 == 0 {
						_, err := tbl.Touch(key, conn.Generation)
						if errors.Is(err, ErrFlowClosed) {
							closed = true
							break
						}
						if err != nil {
							errCh <- fmt.Errorf("worker %d touch: %w", worker, err)
							return
						}
					}
					time.Sleep(500 * time.Microsecond)
				}
				if !closed {
					if _, err := tbl.Close(key, conn.Generation); err != nil {
						errCh <- fmt.Errorf("worker %d close: %w", worker, err)
						return
					}
				}
			}
		}(w)
	}

	var auxWG sync.WaitGroup
	auxWG.Add(2)
	go func() {
		defer auxWG.Done()
		sets := [][]Backend{
			{
				{ID: "a", Addr: "10.0.0.1:80", Weight: 1},
				{ID: "b", Addr: "10.0.0.2:80", Weight: 1},
				{ID: "c", Addr: "10.0.0.3:80", Weight: 1},
			},
			{
				{ID: "b", Addr: "10.0.0.2:80", Weight: 2},
				{ID: "c", Addr: "10.0.0.3:80", Weight: 1},
				{ID: "d", Addr: "10.0.0.4:80", Weight: 1},
			},
		}
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			if err := tbl.SetBackends(sets[i%len(sets)]); err != nil {
				errCh <- fmt.Errorf("churn: %w", err)
				return
			}
			_, _ = tbl.Drain("a")
			_ = tbl.Undrain("a")
			runtime.Gosched()
		}
	}()
	go func() {
		defer auxWG.Done()
		for {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				clock.Advance(5 * time.Millisecond)
				tbl.Sweep()
			}
		}
	}()

	workersWG.Wait()
	close(stop)
	auxWG.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}

	if stats := tbl.Stats(); stats.Active != 0 {
		t.Fatalf("Active = %d after workers finished", stats.Active)
	}
	if stats := tbl.Stats(); stats.Expired == 0 {
		t.Fatal("timeout path was not exercised")
	}
}

func TestGenerationUniquenessUnderConcurrentOpen(t *testing.T) {
	tbl := mustTable(t, Config{Backends: testBackends()})

	const n = 2000
	conns := make(chan Conn, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, err := tbl.Open(flowKey(i))
			if err != nil {
				t.Errorf("Open(%d): %v", i, err)
				return
			}
			conns <- c
		}(i)
	}
	wg.Wait()
	close(conns)

	seen := make(map[uint64]FiveTuple, n)
	for c := range conns {
		if prev, ok := seen[c.Generation]; ok {
			t.Fatalf("generation %d reused by %s and %s", c.Generation, prev, c.Key)
		}
		seen[c.Generation] = c.Key
	}
	if len(seen) != n {
		t.Fatalf("saw %d generations, want %d", len(seen), n)
	}
}

func TestBackendValidation(t *testing.T) {
	tbl := mustTable(t, Config{})
	cases := [][]Backend{
		{{ID: "", Weight: 1}},
		{{ID: "a", Weight: 0}},
		{{ID: "a", Weight: -1}},
		{{ID: "a", Weight: 1}, {ID: "a", Weight: 2}},
	}
	for _, backends := range cases {
		if err := tbl.SetBackends(backends); !errors.Is(err, ErrInvalidBackend) {
			t.Errorf("SetBackends(%+v) error = %v, want ErrInvalidBackend", backends, err)
		}
	}
}

func TestEmptyPoolKeepsActiveFlow(t *testing.T) {
	tbl := mustTable(t, Config{Backends: []Backend{{ID: "a", Weight: 1}}})
	conn, err := tbl.Open(flowKey(1))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := tbl.SetBackends(nil); err != nil {
		t.Fatalf("SetBackends: %v", err)
	}
	got, ok := tbl.Lookup(conn.Key)
	if !ok || !got.IsActive() || got.Backend != conn.Backend {
		t.Fatalf("active flow lost with empty pool: %+v", got)
	}
	if _, err := tbl.Open(flowKey(2)); !errors.Is(err, ErrNoBackends) {
		t.Fatalf("Open with empty pool error = %v, want ErrNoBackends", err)
	}
	if _, err := tbl.Close(conn.Key, conn.Generation); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got, _ = tbl.Lookup(conn.Key)
	if got.Backend != conn.Backend {
		t.Fatalf("closed tombstone changed with no alternative: %+v", got)
	}
}

func TestIPv4MappedKeyIsNormalized(t *testing.T) {
	tbl := mustTable(t, Config{Backends: []Backend{{ID: "a", Weight: 1}}})
	src := netip.MustParseAddr("192.0.2.1")
	dst := netip.MustParseAddr("198.51.100.2")
	plain := FiveTuple{SrcAddr: src, SrcPort: 1234, DstAddr: dst, DstPort: 443, Protocol: 6}
	mapped := FiveTuple{
		SrcAddr:  netip.MustParseAddr("::ffff:192.0.2.1"),
		SrcPort:  1234,
		DstAddr:  netip.MustParseAddr("::ffff:198.51.100.2"),
		DstPort:  443,
		Protocol: 6,
	}

	conn, err := tbl.Open(plain)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	got, ok := tbl.Lookup(mapped)
	if !ok || got.Generation != conn.Generation {
		t.Fatalf("mapped spelling did not hit plain entry: %+v, ok=%v", got, ok)
	}
	if _, err := tbl.Close(mapped, conn.Generation); err != nil {
		t.Fatalf("Close mapped spelling: %v", err)
	}
	if n := len(tbl.flows); n != 1 {
		t.Fatalf("table has %d entries, want 1", n)
	}
}

func TestForgetClosedTombstone(t *testing.T) {
	tbl := mustTable(t, Config{Backends: testBackends()})
	conn, err := tbl.Open(flowKey(10))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := tbl.Forget(conn.Key, conn.Generation); !errors.Is(err, ErrFlowActive) {
		t.Fatalf("Forget active error = %v, want ErrFlowActive", err)
	}
	if _, err := tbl.Close(conn.Key, conn.Generation); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := tbl.Forget(conn.Key, conn.Generation-1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("Forget stale error = %v, want ErrStaleGeneration", err)
	}
	if err := tbl.Forget(conn.Key, conn.Generation); err != nil {
		t.Fatalf("Forget closed: %v", err)
	}
	if _, ok := tbl.Lookup(conn.Key); ok {
		t.Fatal("forgotten entry still present")
	}
	if stats := tbl.Stats(); stats.Active != 0 || stats.Closed != 0 {
		t.Fatalf("stats after Forget: %+v", stats)
	}
}
