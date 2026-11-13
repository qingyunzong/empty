package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var testStart = time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("condition not met: %s", what)
}

func mustScheduler(t *testing.T, cfg Config, clock Clock) *Scheduler {
	t.Helper()
	s, err := NewScheduler(cfg, clock)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func pendingLen(s *Scheduler) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

func assertBucketsHealthy(t *testing.T, s *Scheduler) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.buckets {
		if b.tokens < 0 {
			t.Fatalf("bucket over-issued: tokens=%v capacity=%v", b.tokens, b.capacity)
		}
		if b.tokens > float64(b.capacity)+1e-9 {
			t.Fatalf("bucket over capacity: tokens=%v capacity=%v", b.tokens, b.capacity)
		}
	}
}

func TestAcquireBlocksUntilRefill(t *testing.T) {
	clock := NewManualClock(testStart)
	s := mustScheduler(t, Config{
		PerEndpoint: Rate{Burst: 2, Every: time.Second},
	}, clock)
	key := Key{App: "a", User: "u", Endpoint: "e"}
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if _, err := s.Acquire(ctx, key, 1); err != nil {
			t.Fatal(err)
		}
	}
	granted := make(chan struct{})
	go func() {
		if _, err := s.Acquire(ctx, key, 1); err == nil {
			close(granted)
		}
	}()
	select {
	case <-granted:
		t.Fatal("third acquire granted before refill")
	case <-time.After(20 * time.Millisecond):
	}
	clock.Advance(time.Second)
	eventually(t, "third acquire granted after refill", func() bool {
		select {
		case <-granted:
			return true
		default:
			return false
		}
	})
	assertBucketsHealthy(t, s)
}

// TestConcurrentAcquiresNeverOverIssue enumerates concurrent requests
// across many tenants and verifies grants never exceed what the buckets
// can supply, while every request is eventually served.
func TestConcurrentAcquiresNeverOverIssue(t *testing.T) {
	clock := NewManualClock(testStart)
	cfg := Config{
		Global:      Rate{Burst: 5, Every: time.Second},
		PerApp:      Rate{Burst: 4, Every: time.Second},
		PerUser:     Rate{Burst: 3, Every: time.Second},
		PerEndpoint: Rate{Burst: 2, Every: time.Second},
	}
	s := mustScheduler(t, cfg, clock)
	ctx := context.Background()

	var granted atomic.Int64
	var wg sync.WaitGroup
	const perKey = 4
	total := 0
	for app := 0; app < 2; app++ {
		for user := 0; user < 2; user++ {
			for ep := 0; ep < 2; ep++ {
				key := Key{
					App:      fmt.Sprintf("app%d", app),
					User:     fmt.Sprintf("user%d", user),
					Endpoint: fmt.Sprintf("ep%d", ep),
				}
				for i := 0; i < perKey; i++ {
					total++
					wg.Add(1)
					go func() {
						defer wg.Done()
						res, err := s.Acquire(ctx, key, 1)
						if err != nil {
							t.Error(err)
							return
						}
						granted.Add(1)
						_ = res.Consume(1)
					}()
				}
			}
		}
	}

	// Before any time passes, at most the initial burst may be granted.
	eventually(t, "initial burst granted", func() bool { return granted.Load() == 5 })
	time.Sleep(20 * time.Millisecond)
	if g := granted.Load(); g > 5 {
		t.Fatalf("over-issue before refill: granted=%d", g)
	}
	assertBucketsHealthy(t, s)

	// Each simulated second adds exactly the global rate of new quota.
	// Grants may lag the budget (the tail of the queue can cluster under
	// a tenant's own buckets) but must never exceed it, and every
	// request must complete within a bounded number of refills.
	for step := int64(1); granted.Load() < int64(total); step++ {
		if step > 10 {
			t.Fatalf("requests not completing: granted=%d of %d", granted.Load(), total)
		}
		clock.Advance(time.Second)
		limit := 5 + 5*step
		time.Sleep(50 * time.Millisecond) // let woken waiters settle
		if g := granted.Load(); g > limit {
			t.Fatalf("over-issue at step %d: granted=%d limit=%d", step, g, limit)
		}
		assertBucketsHealthy(t, s)
	}
	wg.Wait()
	if got := granted.Load(); got != int64(total) {
		t.Fatalf("granted=%d, want %d", got, total)
	}
}

// TestFIFOOrderNoStarvation queues requests from two tenants and checks
// they are granted strictly in arrival order, so a tenant with fewer
// requests is never starved by a busier one.
func TestFIFOOrderNoStarvation(t *testing.T) {
	clock := NewManualClock(testStart)
	s := mustScheduler(t, Config{
		Global:  Rate{Burst: 1, Every: 100 * time.Millisecond},
		PerUser: Rate{Burst: 10, Every: 100 * time.Millisecond},
	}, clock)
	ctx := context.Background()

	keyA := Key{App: "a", User: "heavy", Endpoint: "e"}
	keyB := Key{App: "a", User: "light", Endpoint: "e"}

	// Drain the initial token so the following requests queue up.
	if _, err := s.Acquire(ctx, keyA, 1); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var order []string
	acquire := func(key Key, tag string) {
		res, err := s.Acquire(ctx, key, 1)
		if err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		order = append(order, tag)
		mu.Unlock()
		_ = res.Consume(1)
	}
	go acquire(keyA, "A1")
	eventually(t, "A1 queued", func() bool { return pendingLen(s) == 1 })
	go acquire(keyA, "A2")
	eventually(t, "A2 queued", func() bool { return pendingLen(s) == 2 })
	go acquire(keyB, "B1")
	eventually(t, "B1 queued", func() bool { return pendingLen(s) == 3 })

	for i := 0; i < 3; i++ {
		clock.Advance(100 * time.Millisecond)
		eventually(t, fmt.Sprintf("grant %d", i+1), func() bool {
			mu.Lock()
			defer mu.Unlock()
			return len(order) == i+1
		})
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"A1", "A2", "B1"}
	for i, tag := range want {
		if order[i] != tag {
			t.Fatalf("grant order=%v, want %v", order, want)
		}
	}
}

func TestCancelReturnsUnconsumedReservation(t *testing.T) {
	clock := NewManualClock(testStart)
	s := mustScheduler(t, Config{
		Global: Rate{Burst: 5, Every: time.Minute},
	}, clock)
	ctx := context.Background()
	key := Key{App: "a", User: "u", Endpoint: "e"}

	res, err := s.Acquire(ctx, key, 5)
	if err != nil {
		t.Fatal(err)
	}
	if err := res.Consume(2); err != nil {
		t.Fatal(err)
	}
	res.Cancel()

	// The 3 unconsumed tokens are back: they can be reserved without
	// waiting for the minute-long refill.
	res2, err := s.Acquire(ctx, key, 3)
	if err != nil {
		t.Fatal(err)
	}
	res2.Cancel()

	if _, err := s.Acquire(ctx, key, 1); err != nil {
		t.Fatal("returned tokens were not reusable")
	}
	assertBucketsHealthy(t, s)
}

func TestReservationConsumeValidation(t *testing.T) {
	s := mustScheduler(t, Config{Global: Rate{Burst: 2, Every: time.Second}}, NewManualClock(testStart))
	res, err := s.Acquire(context.Background(), Key{}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := res.Consume(3); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("over-consume: got %v", err)
	}
	res.Cancel()
	if err := res.Consume(1); !errors.Is(err, ErrReservationClosed) {
		t.Fatalf("consume after cancel: got %v", err)
	}
	res.Cancel() // idempotent
}

func TestContextCancelWhileQueued(t *testing.T) {
	clock := NewManualClock(testStart)
	s := mustScheduler(t, Config{
		Global: Rate{Burst: 1, Every: time.Hour},
	}, clock)
	key := Key{App: "a", User: "u", Endpoint: "e"}

	if _, err := s.Acquire(context.Background(), key, 1); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := s.Acquire(ctx, key, 1)
		errCh <- err
	}()
	eventually(t, "request queued", func() bool { return pendingLen(s) == 1 })
	cancel()
	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
	eventually(t, "queue drained", func() bool { return pendingLen(s) == 0 })

	// The cancelled request left no trace: after a refill the next
	// acquire succeeds.
	clock.Advance(time.Hour)
	if _, err := s.Acquire(context.Background(), key, 1); err != nil {
		t.Fatal(err)
	}
	assertBucketsHealthy(t, s)
}

func TestThrottleFreezesOnlyHitEndpointBucket(t *testing.T) {
	clock := NewManualClock(testStart)
	cfg := Config{
		PerUser:     Rate{Burst: 10, Every: time.Hour},
		PerEndpoint: Rate{Burst: 10, Every: time.Hour},
	}
	s := mustScheduler(t, cfg, clock)
	ctx := context.Background()
	hit := Key{App: "a", User: "u1", Endpoint: "e1"}

	until, err := s.Throttle(hit, LevelEndpoint, "60", "")
	if err != nil {
		t.Fatal(err)
	}
	if want := testStart.Add(60 * time.Second); !until.Equal(want) {
		t.Fatalf("freeze until %v, want %v", until, want)
	}

	// Sibling buckets stay open: other endpoint, other app, other user
	// on the same endpoint bucket... the frozen bucket is (app, endpoint).
	for _, key := range []Key{
		{App: "a", User: "u1", Endpoint: "e2"},
		{App: "b", User: "u1", Endpoint: "e1"},
	} {
		if _, err := s.Acquire(ctx, key, 1); err != nil {
			t.Fatalf("unrelated bucket frozen: %v", err)
		}
	}

	// The hit bucket is frozen even for another user of the same app.
	granted := make(chan struct{})
	go func() {
		if _, err := s.Acquire(ctx, Key{App: "a", User: "u2", Endpoint: "e1"}, 1); err == nil {
			close(granted)
		}
	}()
	select {
	case <-granted:
		t.Fatal("frozen bucket granted a request")
	case <-time.After(20 * time.Millisecond):
	}
	clock.Advance(60 * time.Second)
	eventually(t, "frozen bucket resumes", func() bool {
		select {
		case <-granted:
			return true
		default:
			return false
		}
	})
	assertBucketsHealthy(t, s)
}

func TestThrottleFreezesOnlyHitUserBucket(t *testing.T) {
	clock := NewManualClock(testStart)
	s := mustScheduler(t, Config{
		PerUser: Rate{Burst: 10, Every: time.Hour},
	}, clock)
	ctx := context.Background()

	if _, err := s.Throttle(Key{App: "a", User: "u1"}, LevelUser, "30", ""); err != nil {
		t.Fatal(err)
	}
	// Same user, different endpoint: blocked by the user-level freeze.
	granted := make(chan struct{})
	go func() {
		if _, err := s.Acquire(ctx, Key{App: "a", User: "u1", Endpoint: "e2"}, 1); err == nil {
			close(granted)
		}
	}()
	select {
	case <-granted:
		t.Fatal("frozen user bucket granted a request")
	case <-time.After(20 * time.Millisecond):
	}
	// Different user: unaffected.
	if _, err := s.Acquire(ctx, Key{App: "a", User: "u2", Endpoint: "e2"}, 1); err != nil {
		t.Fatal(err)
	}
	clock.Advance(30 * time.Second)
	eventually(t, "frozen user resumes", func() bool {
		select {
		case <-granted:
			return true
		default:
			return false
		}
	})
}

func TestThrottleDisabledLevel(t *testing.T) {
	s := mustScheduler(t, Config{Global: Rate{Burst: 1, Every: time.Second}}, NewManualClock(testStart))
	if _, err := s.Throttle(Key{App: "a"}, LevelApp, "10", ""); !errors.Is(err, ErrLevelDisabled) {
		t.Fatalf("got %v, want ErrLevelDisabled", err)
	}
}

func TestAcquireValidation(t *testing.T) {
	s := mustScheduler(t, Config{Global: Rate{Burst: 2, Every: time.Second}}, NewManualClock(testStart))
	if _, err := s.Acquire(context.Background(), Key{}, 0); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("zero amount: got %v", err)
	}
	if _, err := s.Acquire(context.Background(), Key{}, 3); !errors.Is(err, ErrRequestTooLarge) {
		t.Fatalf("oversized: got %v", err)
	}
}

func TestNewSchedulerRejectsBadRate(t *testing.T) {
	if _, err := NewScheduler(Config{Global: Rate{Burst: 1}}, nil); err == nil {
		t.Fatal("expected error for rate without interval")
	}
	if _, err := NewScheduler(Config{Global: Rate{Every: time.Second}}, nil); err == nil {
		t.Fatal("expected error for rate without burst")
	}
}
