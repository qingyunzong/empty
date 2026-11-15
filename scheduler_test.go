package dataeng

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testScheduler(t *testing.T, cfg Config) *Scheduler {
	t.Helper()
	scheduler, err := NewScheduler(cfg)
	if err != nil {
		t.Fatalf("NewScheduler: %v", err)
	}
	t.Cleanup(scheduler.Close)
	return scheduler
}

func submit(t *testing.T, scheduler *Scheduler, tenant, endpoint string) *Ticket {
	t.Helper()
	ticket, err := scheduler.Submit(Request{Tenant: tenant, Endpoint: endpoint})
	if err != nil {
		t.Fatalf("Submit(%s, %s): %v", tenant, endpoint, err)
	}
	return ticket
}

func TestNoOverQuotaAcrossAllScopes(t *testing.T) {
	start := time.Unix(1_700_000_000, 0).UTC()
	clock := NewManualClock(start)
	scheduler := testScheduler(t, Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 40, Burst: 4},
		Tenants: map[string]TenantConfig{
			"alpha": {Weight: 2, Bucket: BucketConfig{Rate: 25, Burst: 3}},
			"beta":  {Weight: 1, Bucket: BucketConfig{Rate: 12, Burst: 2}},
		},
		Endpoints: map[string]BucketConfig{
			"read":  {Rate: 18, Burst: 2},
			"write": {Rate: 9, Burst: 2},
		},
	})

	type requestPair struct{ tenant, endpoint string }
	pairs := []requestPair{
		{"alpha", "read"},
		{"beta", "read"},
		{"alpha", "write"},
		{"beta", "write"},
	}
	var tickets []*Ticket
	for tick := 0; tick < 600; tick++ {
		for _, pair := range pairs {
			tickets = append(tickets, submit(t, scheduler, pair.tenant, pair.endpoint))
		}
		if tick%5 == 0 {
			clock.Advance(25 * time.Millisecond)
		} else {
			clock.Advance(5 * time.Millisecond)
		}
		snapshot := scheduler.Snapshot()
		for name, bucket := range snapshot.Endpoints {
			if bucket.Tokens < 0 || bucket.InFlight < 0 {
				t.Fatalf("endpoint %s has negative state: %+v", name, bucket)
			}
		}
		if snapshot.Global.Tokens < 0 || snapshot.Global.InFlight < 0 {
			t.Fatalf("global has negative state: %+v", snapshot.Global)
		}
	}

	var all, alpha, beta, read, write []time.Time
	for _, ticket := range tickets {
		reservation := ticket.Reservation()
		if reservation == nil {
			continue
		}
		at := reservation.AdmittedAt()
		all = append(all, at)
		switch reservation.Tenant() {
		case "alpha":
			alpha = append(alpha, at)
		case "beta":
			beta = append(beta, at)
		}
		switch reservation.Endpoint() {
		case "read":
			read = append(read, at)
		case "write":
			write = append(write, at)
		}
	}

	if len(all) == 0 {
		t.Fatal("no request was admitted")
	}
	assertWithinLimit(t, "global", all, 4, 40, time.Second)
	assertWithinLimit(t, "tenant alpha", alpha, 3, 25, time.Second)
	assertWithinLimit(t, "tenant beta", beta, 2, 12, time.Second)
	assertWithinLimit(t, "endpoint read", read, 2, 18, time.Second)
	assertWithinLimit(t, "endpoint write", write, 2, 9, time.Second)
	if len(alpha) == 0 || len(beta) == 0 || len(read) == 0 || len(write) == 0 {
		t.Fatalf("expected traffic on every scope, got alpha=%d beta=%d read=%d write=%d",
			len(alpha), len(beta), len(read), len(write))
	}
}

func assertWithinLimit(t *testing.T, name string, grants []time.Time, burst, rate float64, window time.Duration) {
	t.Helper()
	sort.Slice(grants, func(i, j int) bool { return grants[i].Before(grants[j]) })
	limit := burst + rate*window.Seconds()
	for i := range grants {
		end := grants[i].Add(window)
		count := 0
		for j := i; j < len(grants) && !grants[j].After(end); j++ {
			count++
		}
		if float64(count) > limit+1e-6 {
			t.Fatalf("%s admitted %d requests in [%s,%s], limit is %.3f",
				name, count, grants[i], end, limit)
		}
	}
}

func TestGlobalTenantAndEndpointMustAllAllow(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 0, Burst: 10},
		Tenants: map[string]TenantConfig{
			"small": {Weight: 1, Bucket: BucketConfig{Rate: 0, Burst: 1}},
			"wide":  {Weight: 1, Bucket: BucketConfig{Rate: 0, Burst: 10}},
		},
		Endpoints: map[string]BucketConfig{
			"one": {Rate: 0, Burst: 1},
			"ten": {Rate: 0, Burst: 10},
		},
	})

	var small []*Ticket
	for i := 0; i < 5; i++ {
		small = append(small, submit(t, scheduler, "small", "ten"))
	}
	if got := countAdmitted(small); got != 1 {
		t.Fatalf("tenant bucket should admit exactly 1, got %d", got)
	}

	var wide []*Ticket
	for i := 0; i < 12; i++ {
		wide = append(wide, submit(t, scheduler, "wide", "ten"))
	}
	if got := countAdmitted(wide); got != 9 {
		t.Fatalf("global bucket should have 9 tokens left, admitted %d", got)
	}

	var endpoint []*Ticket
	scheduler2 := testScheduler(t, Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 0, Burst: 10},
		Endpoints: map[string]BucketConfig{
			"tiny": {Rate: 0, Burst: 1},
		},
	})
	for i := 0; i < 5; i++ {
		endpoint = append(endpoint, submit(t, scheduler2, "tenant", "tiny"))
	}
	if got := countAdmitted(endpoint); got != 1 {
		t.Fatalf("endpoint bucket should admit exactly 1, got %d", got)
	}
}

func countAdmitted(tickets []*Ticket) int {
	n := 0
	for _, ticket := range tickets {
		if ticket.Reservation() != nil {
			n++
		}
	}
	return n
}

func TestWeightedFairnessAndNoStarvation(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 100, Burst: 1},
		Tenants: map[string]TenantConfig{
			"high": {Weight: 4},
			"low":  {Weight: 1},
		},
	})

	var tickets []*Ticket
	for i := 0; i < 1000; i++ {
		tickets = append(tickets, submit(t, scheduler, "high", "api"))
		tickets = append(tickets, submit(t, scheduler, "low", "api"))
	}

	granted := make([]*Reservation, 0, 900)
	collect := func() {
		for _, ticket := range tickets {
			reservation := ticket.Reservation()
			if reservation != nil {
				granted = append(granted, reservation)
				ticket.reservation = nil
			}
		}
	}
	collect()
	for i := 0; i < 800; i++ {
		clock.Advance(10 * time.Millisecond)
		collect()
	}

	if len(granted) < 700 {
		t.Fatalf("expected sustained admission, got %d grants", len(granted))
	}
	sort.SliceStable(granted, func(i, j int) bool {
		return granted[i].AdmittedAt().Before(granted[j].AdmittedAt())
	})

	high, low := 0, 0
	maxLowGap := 0
	gap := 0
	var lastLow time.Time
	var maxLowWait time.Duration
	for _, reservation := range granted {
		switch reservation.Tenant() {
		case "high":
			high++
			gap++
		case "low":
			low++
			if gap > maxLowGap {
				maxLowGap = gap
			}
			gap = 0
			if !lastLow.IsZero() {
				if wait := reservation.AdmittedAt().Sub(lastLow); wait > maxLowWait {
					maxLowWait = wait
				}
			}
			lastLow = reservation.AdmittedAt()
		}
	}
	if low == 0 {
		t.Fatal("low-weight tenant was starved")
	}
	ratio := float64(high) / float64(low)
	if ratio < 3.6 || ratio > 4.4 {
		t.Fatalf("weighted ratio high/low = %.3f, want about 4", ratio)
	}
	if maxLowGap > 6 {
		t.Fatalf("low-weight tenant waited behind %d high-weight grants", maxLowGap)
	}
	if maxLowWait > 100*time.Millisecond {
		t.Fatalf("low-weight tenant waited %v between grants", maxLowWait)
	}
}

func TestReservationSettlesExactlyOnce(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 0, Burst: 10},
		Tenants: map[string]TenantConfig{
			"t": {Weight: 1, Bucket: BucketConfig{Rate: 0, Burst: 10}},
		},
		Endpoints: map[string]BucketConfig{
			"e": {Rate: 0, Burst: 10},
		},
	})

	acquire := func() *Reservation {
		reservation, err := scheduler.Acquire(context.Background(), Request{Tenant: "t", Endpoint: "e"})
		if err != nil {
			t.Fatalf("Acquire: %v", err)
		}
		return reservation
	}

	committed := acquire()
	if got := scheduler.Snapshot().Global.Tokens; got != 9 {
		t.Fatalf("after admit global tokens = %v, want 9", got)
	}
	if !committed.Commit() {
		t.Fatal("first Commit should win")
	}
	if committed.Commit() || committed.Cancel() || committed.Fail(time.Second) {
		t.Fatal("a settled reservation accepted a second settlement")
	}
	if got := scheduler.Snapshot().Global.Tokens; got != 9 {
		t.Fatalf("after commit global tokens = %v, want 9", got)
	}

	cancelled := acquire()
	if !cancelled.Cancel() {
		t.Fatal("first Cancel should win")
	}
	if cancelled.Cancel() || cancelled.Commit() || cancelled.Fail(0) {
		t.Fatal("a cancelled reservation accepted a second settlement")
	}
	if got := scheduler.Snapshot().Global.Tokens; got != 9 {
		t.Fatalf("refund should restore one token but cap at burst, got %v", got)
	}

	failed := acquire()
	if !failed.Fail(2 * time.Second) {
		t.Fatal("first Fail should win")
	}
	if failed.Fail(20*time.Second) || failed.Commit() || failed.Cancel() {
		t.Fatal("a failed reservation accepted a second settlement")
	}
	if got := scheduler.Snapshot().Global.Tokens; got != 9 {
		t.Fatalf("after failure and refund global tokens = %v, want 9", got)
	}
	pending := submit(t, scheduler, "t", "e")
	if pending.Reservation() != nil {
		t.Fatal("retry-after should keep the endpoint closed during cooldown")
	}
	clock.Advance(2 * time.Second)
	if pending.Reservation() == nil {
		t.Fatal("retry-after cooldown should end after 2s")
	}
}

func TestConcurrentSettlementHasOneWinner(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 0, Burst: 10},
		Endpoints: map[string]BucketConfig{
			"e": {Rate: 0, Burst: 10},
		},
	})
	reservation, err := scheduler.Acquire(context.Background(), Request{Tenant: "t", Endpoint: "e"})
	if err != nil {
		t.Fatal(err)
	}

	var winners atomic.Int32
	var wait sync.WaitGroup
	for i := 0; i < 64; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			var won bool
			switch i % 3 {
			case 0:
				won = reservation.Commit()
			case 1:
				won = reservation.Cancel()
			default:
				won = reservation.Fail(time.Second)
			}
			if won {
				winners.Add(1)
			}
		}(i)
	}
	wait.Wait()
	if got := winners.Load(); got != 1 {
		t.Fatalf("settlement winners = %d, want exactly 1", got)
	}
	snapshot := scheduler.Snapshot()
	if snapshot.Global.InFlight != 0 {
		t.Fatalf("in-flight = %v after settlement, want 0", snapshot.Global.InFlight)
	}
	if snapshot.Global.Tokens != 9 && snapshot.Global.Tokens != 10 {
		t.Fatalf("tokens = %v, want 9 (commit) or 10 (refund)", snapshot.Global.Tokens)
	}
	if reservation.State() == ReservationPending {
		t.Fatal("reservation is still pending after settlement")
	}
}

func TestRetryAfterBlocksOnlyItsEndpoint(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{
		Clock: clock,
		Endpoints: map[string]BucketConfig{
			"x": {Rate: 1, Burst: 5},
			"y": {Rate: 1, Burst: 5},
		},
	})
	reservation, err := scheduler.Acquire(context.Background(), Request{Tenant: "t", Endpoint: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if !reservation.Fail(2 * time.Second) {
		t.Fatal("Fail should win")
	}
	if reservation.Fail(10 * time.Second) {
		t.Fatal("second Fail should be ignored")
	}

	x := submit(t, scheduler, "t", "x")
	y := submit(t, scheduler, "t", "y")
	if x.Reservation() != nil {
		t.Fatal("x should be cooling down")
	}
	if y.Reservation() == nil {
		t.Fatal("y should not be affected by x's retry-after")
	}
	clock.Advance(1999 * time.Millisecond)
	if x.Reservation() != nil {
		t.Fatal("cooldown ended early")
	}
	clock.Advance(time.Millisecond)
	if x.Reservation() == nil {
		t.Fatal("x should be admitted when its cooldown ends")
	}
}

func TestTicketCancelAndContextCancel(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 0, Burst: 1},
	})
	first := submit(t, scheduler, "t", "e")
	if first.Reservation() == nil {
		t.Fatal("first request should consume the only token")
	}

	second := submit(t, scheduler, "t", "e")
	if second.Reservation() != nil {
		t.Fatal("second request should be queued")
	}
	if !second.Cancel() {
		t.Fatal("Cancel should remove the queued ticket")
	}
	if second.Cancel() {
		t.Fatal("second Cancel should be false")
	}
	if _, err := second.Wait(context.Background()); !errors.Is(err, ErrTicketCanceled) {
		t.Fatalf("Wait error = %v, want ErrTicketCanceled", err)
	}

	third := submit(t, scheduler, "t", "e")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := third.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait error = %v, want context.Canceled", err)
	}
	if scheduler.Pending() != 0 {
		t.Fatalf("pending = %d after cancellation, want 0", scheduler.Pending())
	}
}

func TestQuotaHeadersParseAndTightenBucket(t *testing.T) {
	start := time.Unix(1_700_000_000, 0).UTC()
	clock := NewManualClock(start)
	scheduler := testScheduler(t, Config{
		Clock: clock,
		Endpoints: map[string]BucketConfig{
			"x": {Rate: 1, Burst: 10},
			"y": {Rate: 1, Burst: 10},
		},
	})

	headers := make(http.Header)
	headers.Set("X-RateLimit-Limit", "10")
	headers.Set("X-RateLimit-Remaining", "3")
	headers.Set("X-RateLimit-Reset", strconv.FormatInt(start.Add(6*time.Second).Unix(), 10))
	headers.Set("Retry-After", "2")
	state, err := ParseQuotaHeaders(headers, start)
	if err != nil {
		t.Fatalf("ParseQuotaHeaders: %v", err)
	}
	if state.Limit == nil || *state.Limit != 10 {
		t.Fatalf("limit = %v, want 10", state.Limit)
	}
	if state.Remaining == nil || *state.Remaining != 3 {
		t.Fatalf("remaining = %v, want 3", state.Remaining)
	}
	if state.ResetAt == nil || !state.ResetAt.Equal(start.Add(6*time.Second)) {
		t.Fatalf("reset = %v, want %v", state.ResetAt, start.Add(6*time.Second))
	}
	if state.RetryAfter == nil || *state.RetryAfter != 2*time.Second {
		t.Fatalf("retry-after = %v, want 2s", state.RetryAfter)
	}
	if err := scheduler.ApplyQuota(ScopeEndpoint, "x", state); err != nil {
		t.Fatalf("ApplyQuota: %v", err)
	}

	snapshot := scheduler.Snapshot()
	x := snapshot.Endpoints["x"]
	if x.Tokens != 3 {
		t.Fatalf("x tokens = %v, want 3", x.Tokens)
	}
	wantRate := 7.0 / 6.0
	if math.Abs(x.Rate-wantRate) > 1e-9 {
		t.Fatalf("x rate = %v, want %v", x.Rate, wantRate)
	}
	if !x.CooldownUntil.Equal(start.Add(2 * time.Second)) {
		t.Fatalf("x cooldown = %v, want %v", x.CooldownUntil, start.Add(2*time.Second))
	}

	xTicket := submit(t, scheduler, "t", "x")
	yTicket := submit(t, scheduler, "t", "y")
	if xTicket.Reservation() != nil {
		t.Fatal("Retry-After header should defer x")
	}
	if yTicket.Reservation() == nil {
		t.Fatal("y should be admitted")
	}
	clock.Advance(2 * time.Second)
	if xTicket.Reservation() == nil {
		t.Fatal("x should be admitted after Retry-After")
	}
	clock.Advance(4 * time.Second)
	snapshot = scheduler.Snapshot()
	x = snapshot.Endpoints["x"]
	if math.Abs(x.Rate-1) > 1e-9 {
		t.Fatalf("configured rate should resume after reset, got %v", x.Rate)
	}
	if x.Tokens < 8.9 || x.Tokens > 10 {
		t.Fatalf("x tokens at reset = %v, want about 9 after one consumed token", x.Tokens)
	}

	standard := make(http.Header)
	standard.Set("RateLimit-Limit", "100")
	standard.Set("RateLimit-Remaining", "20")
	standard.Set("RateLimit-Reset", "30")
	state, err = ParseQuotaHeaders(standard, start)
	if err != nil {
		t.Fatalf("standard headers: %v", err)
	}
	if state.ResetAt == nil || !state.ResetAt.Equal(start.Add(30*time.Second)) {
		t.Fatalf("standard reset = %v, want %v", state.ResetAt, start.Add(30*time.Second))
	}

	relative := make(http.Header)
	relative.Set("X-RateLimit-Reset", "5")
	state, err = ParseQuotaHeaders(relative, start)
	if err != nil {
		t.Fatalf("relative reset: %v", err)
	}
	if state.ResetAt == nil || !state.ResetAt.Equal(start.Add(5*time.Second)) {
		t.Fatalf("relative reset = %v, want %v", state.ResetAt, start.Add(5*time.Second))
	}

	bad := make(http.Header)
	bad.Set("X-RateLimit-Remaining", "not-a-number")
	if _, err := ParseQuotaHeaders(bad, start); err == nil {
		t.Fatal("malformed quota header should return an error")
	}
}

func TestQuotaRemainingIsSafeWithInFlight(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{
		Clock: clock,
		Endpoints: map[string]BucketConfig{
			"x": {Rate: 0, Burst: 10},
		},
	})
	reservation, err := scheduler.Acquire(context.Background(), Request{Tenant: "t", Endpoint: "x"})
	if err != nil {
		t.Fatal(err)
	}
	remaining := 5.0
	if err := scheduler.ApplyQuota(ScopeEndpoint, "x", QuotaState{Remaining: &remaining}); err != nil {
		t.Fatal(err)
	}
	if got := scheduler.Snapshot().Endpoints["x"].Tokens; got != 5 {
		t.Fatalf("tokens = %v, want server remaining", got)
	}
	if !reservation.Cancel() {
		t.Fatal("cancel should win")
	}
	if got := scheduler.Snapshot().Endpoints["x"].Tokens; got != 6 {
		t.Fatalf("refunded tokens = %v, want 6", got)
	}

	remaining = 8
	if err := scheduler.ApplyQuota(ScopeEndpoint, "x", QuotaState{Remaining: &remaining}); err != nil {
		t.Fatal(err)
	}
	if got := scheduler.Snapshot().Endpoints["x"].Tokens; got != 8 {
		t.Fatalf("idle bucket should accept server remaining, got %v", got)
	}

	second, err := scheduler.Acquire(context.Background(), Request{Tenant: "t", Endpoint: "x"})
	if err != nil {
		t.Fatal(err)
	}
	remaining = 10
	if err := scheduler.ApplyQuota(ScopeEndpoint, "x", QuotaState{Remaining: &remaining}); err != nil {
		t.Fatal(err)
	}
	if got := scheduler.Snapshot().Endpoints["x"].Tokens; got != 7 {
		t.Fatalf("in-flight bucket should not be raised, got %v", got)
	}
	if !second.Commit() {
		t.Fatal("commit should win")
	}
	if got := scheduler.Snapshot().Endpoints["x"].Tokens; got != 7 {
		t.Fatalf("commit should keep consumed tokens, got %v", got)
	}
}

func TestQuotaAppliesToGlobalAndTenantScopes(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 0, Burst: 10},
		Tenants: map[string]TenantConfig{
			"t": {Weight: 1, Bucket: BucketConfig{Rate: 0, Burst: 10}},
		},
	})

	one := 1.0
	if err := scheduler.ApplyQuota(ScopeGlobal, "", QuotaState{Remaining: &one}); err != nil {
		t.Fatal(err)
	}
	var first []*Ticket
	for i := 0; i < 3; i++ {
		first = append(first, submit(t, scheduler, "t", "e"))
	}
	if got := countAdmitted(first); got != 1 {
		t.Fatalf("global remaining=1 admitted %d, want 1", got)
	}
	if !first[0].Reservation().Commit() {
		t.Fatal("commit should win")
	}

	ten := 10.0
	if err := scheduler.ApplyQuota(ScopeGlobal, "", QuotaState{Remaining: &ten}); err != nil {
		t.Fatal(err)
	}
	two := 2.0
	if err := scheduler.ApplyQuota(ScopeTenant, "t", QuotaState{Remaining: &two}); err != nil {
		t.Fatal(err)
	}
	var second []*Ticket
	for i := 0; i < 5; i++ {
		second = append(second, submit(t, scheduler, "t", "e"))
	}
	if got := countAdmitted(second); got != 2 {
		t.Fatalf("tenant remaining=2 admitted %d, want 2", got)
	}
}

func TestQuotaLimitOnUnconfiguredEndpointIsNotUnlimited(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler := testScheduler(t, Config{Clock: clock})
	limit := 10.0
	remaining := 2.0
	if err := scheduler.ApplyQuota(ScopeEndpoint, "new", QuotaState{
		Limit:     &limit,
		Remaining: &remaining,
	}); err != nil {
		t.Fatal(err)
	}
	snapshot := scheduler.Snapshot()
	bucket := snapshot.Endpoints["new"]
	if bucket.Burst != 10 || bucket.Tokens != 2 || bucket.Rate != 0 {
		t.Fatalf("dynamic endpoint bucket = %+v, want burst 10 tokens 2 rate 0", bucket)
	}
	clock.Advance(10 * time.Second)
	bucket = scheduler.Snapshot().Endpoints["new"]
	if bucket.Tokens != 2 {
		t.Fatalf("a dynamic limit must not refill without a reset window, tokens = %v", bucket.Tokens)
	}
	var tickets []*Ticket
	for i := 0; i < 4; i++ {
		tickets = append(tickets, submit(t, scheduler, "t", "new"))
	}
	if got := countAdmitted(tickets); got != 2 {
		t.Fatalf("dynamic remaining=2 admitted %d, want 2", got)
	}
}

func TestCloseReleasesQueuedTickets(t *testing.T) {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler, err := NewScheduler(Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 0, Burst: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	first := submit(t, scheduler, "t", "e")
	if first.Reservation() == nil {
		t.Fatal("first should be admitted")
	}
	second := submit(t, scheduler, "t", "e")
	scheduler.Close()
	if _, err := second.Wait(context.Background()); !errors.Is(err, ErrSchedulerClosed) {
		t.Fatalf("Wait error = %v, want ErrSchedulerClosed", err)
	}
	if _, err := scheduler.Submit(Request{Tenant: "t", Endpoint: "e"}); !errors.Is(err, ErrSchedulerClosed) {
		t.Fatalf("Submit error = %v, want ErrSchedulerClosed", err)
	}
	if scheduler.Pending() != 0 {
		t.Fatalf("pending = %d after Close", scheduler.Pending())
	}
}

func ExampleScheduler() {
	clock := NewManualClock(time.Unix(1_700_000_000, 0))
	scheduler, _ := NewScheduler(Config{
		Clock:  clock,
		Global: BucketConfig{Rate: 10, Burst: 2},
		Tenants: map[string]TenantConfig{
			"collector": {Weight: 1, Bucket: BucketConfig{Rate: 5, Burst: 2}},
		},
		Endpoints: map[string]BucketConfig{
			"/items": {Rate: 3, Burst: 1},
		},
	})
	reservation, err := scheduler.Acquire(context.Background(), Request{
		Tenant:   "collector",
		Endpoint: "/items",
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(reservation.Tenant(), reservation.Endpoint())
	reservation.Commit()
	scheduler.Close()
	// Output: collector /items
}
