package dataeng

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestWaitMergesMaxDeadlineAcrossScopes(t *testing.T) {
	s := NewScheduler()
	now := time.Now()
	route := Route{Tenant: "t1", Resource: "r1", Method: "GET"}

	s.Update(route, Feedback{
		Tenant: &Hint{ResetAt: now.Add(40 * time.Millisecond), Remaining: 0, Limit: -1},
		Method: &Hint{ResetAt: now.Add(120 * time.Millisecond), Remaining: 0, Limit: -1},
	})

	start := time.Now()
	if err := s.Wait(context.Background(), route); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Fatalf("Wait returned after %v, want the max scope deadline (~120ms)", elapsed)
	}

	// A route that does not touch the method bucket is only bound by the
	// tenant deadline, which has already passed.
	start = time.Now()
	other := Route{Tenant: "t1", Resource: "r2", Method: "POST"}
	if err := s.Wait(context.Background(), other); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 80*time.Millisecond {
		t.Fatalf("unrelated route blocked for %v on another scope's bucket", elapsed)
	}
}

func TestDeadlineIsMaxOfRelevantScopes(t *testing.T) {
	s := NewScheduler()
	now := time.Now()
	route := Route{Tenant: "t1", Resource: "r1", Method: "GET"}
	s.Update(route, Feedback{
		Global:   &Hint{ResetAt: now.Add(10 * time.Second), Remaining: 0, Limit: -1},
		Tenant:   &Hint{ResetAt: now.Add(30 * time.Second), Remaining: 0, Limit: -1},
		Resource: &Hint{ResetAt: now.Add(20 * time.Second), Remaining: 0, Limit: -1},
	})

	s.mu.Lock()
	deadline := s.deadlineLocked(route.Keys())
	s.mu.Unlock()
	want := now.Add(30 * time.Second)
	if deadline.Sub(want).Abs() > 50*time.Millisecond {
		t.Fatalf("deadline = %v, want max scope reset ~%v", deadline, want)
	}

	// Scopes outside the route do not constrain it.
	other := Route{Tenant: "t2"}
	s.mu.Lock()
	d2 := s.deadlineLocked(other.Keys())
	s.mu.Unlock()
	want2 := now.Add(10 * time.Second) // only the global bucket applies
	if d2.Sub(want2).Abs() > 50*time.Millisecond {
		t.Fatalf("deadline for other route = %v, want ~%v", d2, want2)
	}
}

func TestUpdateOnlyTouchesExplicitBuckets(t *testing.T) {
	s := NewScheduler()
	now := time.Now()
	route := Route{Tenant: "t1", Resource: "r1", Method: "GET"}

	s.Update(route, Feedback{
		Tenant: &Hint{ResetAt: now.Add(time.Minute), Remaining: 3, Limit: 10},
	})

	if got := s.Remaining(Key{Scope: ScopeTenant, ID: "t1"}); got != 3 {
		t.Fatalf("tenant remaining = %d, want 3", got)
	}
	for _, k := range []Key{
		{Scope: ScopeGlobal},
		{Scope: ScopeResource, ID: "r1"},
		{Scope: ScopeMethod, ID: "GET"},
	} {
		if got := s.Remaining(k); got != -1 {
			t.Fatalf("bucket %v touched by feedback that omitted it: remaining = %d", k, got)
		}
	}

	// A success response carrying only global feedback must not clear the
	// tenant bucket learned earlier.
	s.Update(route, Feedback{
		Global: &Hint{Remaining: 99, Limit: 100},
	})
	if got := s.Remaining(Key{Scope: ScopeTenant, ID: "t1"}); got != 3 {
		t.Fatalf("tenant remaining = %d after global-only update, want 3", got)
	}
	if got := s.Remaining(Key{Scope: ScopeGlobal}); got != 99 {
		t.Fatalf("global remaining = %d, want 99", got)
	}
}

func TestClockSkewCorrectionIsBounded(t *testing.T) {
	now := time.Now()
	s := NewScheduler(
		WithClock(func() time.Time { return now }),
		WithMaxSkew(30*time.Second),
	)
	resetAt := now.Add(2*time.Hour + 100*time.Second)

	// Server clock claims to be 2 hours ahead; only 30s of that is trusted.
	got := s.correct(now.Add(2*time.Hour), resetAt)
	want := resetAt.Add(-30 * time.Second)
	if !got.Equal(want) {
		t.Fatalf("correct() = %v, want %v (skew clamped to 30s)", got, want)
	}

	// Same bound in the other direction.
	got = s.correct(now.Add(-2*time.Hour), resetAt)
	want = resetAt.Add(30 * time.Second)
	if !got.Equal(want) {
		t.Fatalf("correct() = %v, want %v (skew clamped to -30s)", got, want)
	}
}

func TestExpiredResetDateIsClampedToNow(t *testing.T) {
	now := time.Now()
	s := NewScheduler(WithClock(func() time.Time { return now }))

	got := s.correct(time.Time{}, now.Add(-time.Hour))
	if !got.Equal(now) {
		t.Fatalf("expired reset corrected to %v, want now (%v)", got, now)
	}

	// An expired hint must not block the next request.
	route := Route{Tenant: "t1"}
	s.Update(route, Feedback{
		Tenant: &Hint{ResetAt: now.Add(-time.Hour), Remaining: 0, Limit: 5},
	})
	s.mu.Lock()
	deadline := s.deadlineLocked(route.Keys())
	s.mu.Unlock()
	if !deadline.IsZero() {
		t.Fatalf("expired reset still blocks requests until %v", deadline)
	}
}

func TestCancelledWaitConsumesNoToken(t *testing.T) {
	s := NewScheduler()
	route := Route{Tenant: "t1"}
	key := Key{Scope: ScopeTenant, ID: "t1"}

	s.Update(route, Feedback{
		Tenant: &Hint{
			ResetAt:   time.Now().Add(200 * time.Millisecond),
			Remaining: 0,
			Limit:     5,
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Wait(ctx, route) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-done; err != context.Canceled {
		t.Fatalf("Wait returned %v, want context.Canceled", err)
	}
	if got := s.Remaining(key); got != 0 {
		t.Fatalf("cancelled wait consumed a token: remaining = %d, want 0", got)
	}

	// After the reset passes, a fresh wait refills and consumes exactly one.
	if err := s.Wait(context.Background(), route); err != nil {
		t.Fatalf("Wait after reset: %v", err)
	}
	if got := s.Remaining(key); got != 4 {
		t.Fatalf("remaining = %d after refill+consume, want 4", got)
	}
}

func TestCancelledBeforeStartConsumesNoToken(t *testing.T) {
	s := NewScheduler()
	route := Route{Tenant: "t1"}
	s.Update(route, Feedback{
		Tenant: &Hint{Remaining: 1, Limit: 1},
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Wait(ctx, route); err != context.Canceled {
		t.Fatalf("Wait returned %v, want context.Canceled", err)
	}
	if got := s.Remaining(Key{Scope: ScopeTenant, ID: "t1"}); got != 1 {
		t.Fatalf("remaining = %d, want 1 (no consumption on cancel)", got)
	}
}

func TestSchedulerEndToEndWithHTTPHeaders(t *testing.T) {
	s := NewScheduler()
	route := Route{Tenant: "acme", Resource: "repos", Method: "GET"}

	// Success response: all four scopes report state at once.
	h := http.Header{}
	h.Set("Date", time.Now().UTC().Format(http.TimeFormat))
	h.Set("RateLimit-Limit", "1000")
	h.Set("RateLimit-Remaining", "999")
	h.Set("X-RateLimit-Remaining-Tenant", "12")
	h.Set("X-RateLimit-Limit-Tenant", "100")
	h.Set("X-RateLimit-Remaining-Resource", "40")
	h.Set("X-RateLimit-Remaining-Method", "7")

	s.Update(route, ParseFeedback(h, time.Now()))
	if got := s.Remaining(Key{Scope: ScopeGlobal}); got != 999 {
		t.Fatalf("global remaining = %d, want 999", got)
	}
	if got := s.Remaining(Key{Scope: ScopeTenant, ID: "acme"}); got != 12 {
		t.Fatalf("tenant remaining = %d, want 12", got)
	}
	if got := s.Remaining(Key{Scope: ScopeResource, ID: "repos"}); got != 40 {
		t.Fatalf("resource remaining = %d, want 40", got)
	}
	if got := s.Remaining(Key{Scope: ScopeMethod, ID: "GET"}); got != 7 {
		t.Fatalf("method remaining = %d, want 7", got)
	}

	// 429 response: tenant is throttled for a short window, everything else
	// stays as reported before.
	throttle := http.Header{}
	throttle.Set("X-RateLimit-Reset-Tenant", "1") // 1s from now, delta form
	s.Update(route, ParseFeedback(throttle, time.Now()))

	start := time.Now()
	if err := s.Wait(context.Background(), route); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 900*time.Millisecond {
		t.Fatalf("Wait returned after %v, want ~1s tenant backoff", elapsed)
	}
	if got := s.Remaining(Key{Scope: ScopeTenant, ID: "acme"}); got != 99 {
		t.Fatalf("tenant remaining = %d after refill, want 99 (limit 100 minus 1)", got)
	}
}
