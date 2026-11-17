package formal

import (
	"context"
	"errors"
	"math/rand"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func mustGet(t *testing.T, q *Queue, timeout time.Duration) Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	event, ok := q.Get(ctx)
	if !ok {
		t.Fatalf("expected an event within %s", timeout)
	}
	return event
}

func expectNoEvent(t *testing.T, q *Queue, wait time.Duration) {
	t.Helper()
	if event, ok := q.TryGet(); ok {
		t.Fatalf("unexpected event %s", event)
	}
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	if event, ok := q.Get(ctx); ok {
		t.Fatalf("unexpected event %s", event)
	}
}

func TestResourceVersionCoalescing(t *testing.T) {
	q := NewQueue()
	key := Key("team-a", "widget")

	if !q.Add(Event{Type: EventAdd, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 3}) {
		t.Fatal("newest version should be accepted")
	}
	if q.Add(Event{Type: EventUpdate, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 2}) {
		t.Fatal("stale version should be rejected")
	}
	if q.Add(Event{Type: EventUpdate, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 3}) {
		t.Fatal("duplicate version should be rejected")
	}

	event := mustGet(t, q, time.Second)
	if event.ResourceVersion != 3 {
		t.Fatalf("got version %d, want 3", event.ResourceVersion)
	}
	if !q.Done(event) {
		t.Fatal("Done should accept the delivered lease")
	}
	if q.Add(Event{Type: EventUpdate, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 3}) {
		t.Fatal("a delivered version must not be accepted again")
	}
	expectNoEvent(t, q, 20*time.Millisecond)
}

func TestVersionAliasAndObjectIdentity(t *testing.T) {
	q := NewQueue()
	if !q.Add(Event{Name: "a", Version: 7}) {
		t.Fatal("Version alias should be accepted")
	}
	if !q.Add(Event{Name: "b", Version: 1}) {
		t.Fatal("a different object must have its own version watermark")
	}

	first := mustGet(t, q, time.Second)
	second := mustGet(t, q, time.Second)
	if first.Name != "a" || first.ResourceVersion != 7 {
		t.Fatalf("unexpected first event: %s", first)
	}
	if second.Name != "b" || second.ResourceVersion != 1 {
		t.Fatalf("unexpected second event: %s", second)
	}
	q.Done(first)
	q.Done(second)
}

func TestNewerVersionWaitsForInFlightObject(t *testing.T) {
	q := NewQueue()
	key := Key("team-a", "widget")

	q.Add(Event{Namespace: key.Namespace, Name: key.Name, ResourceVersion: 1})
	first := mustGet(t, q, time.Second)
	if !q.Add(Event{Namespace: key.Namespace, Name: key.Name, ResourceVersion: 2}) {
		t.Fatal("newer version should be accepted while version 1 is in flight")
	}
	if event, ok := q.TryGet(); ok {
		t.Fatalf("object was delivered concurrently: %s", event)
	}
	if !q.Done(first) {
		t.Fatal("Done should accept the first delivery")
	}
	second := mustGet(t, q, time.Second)
	if second.ResourceVersion != 2 {
		t.Fatalf("got version %d, want 2", second.ResourceVersion)
	}
	q.Done(second)
}

func TestDeleteTombstoneOvertakesOlderUpdates(t *testing.T) {
	q := NewQueue()
	key := Key("team-a", "widget")

	q.Add(Event{Type: EventUpdate, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 8})
	if !q.Add(Event{Type: EventDelete, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 9}) {
		t.Fatal("delete tombstone should replace the older update")
	}
	if q.Add(Event{Type: EventUpdate, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 7}) {
		t.Fatal("update older than the tombstone must be rejected")
	}

	event := mustGet(t, q, time.Second)
	if event.Type != EventDelete || event.ResourceVersion != 9 {
		t.Fatalf("got %s, want delete@9", event)
	}
	q.Done(event)

	if q.Add(Event{Type: EventUpdate, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 8}) {
		t.Fatal("a late stale update must not resurrect an object")
	}
	expectNoEvent(t, q, 20*time.Millisecond)

	if !q.Add(Event{Type: EventAdd, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 10}) {
		t.Fatal("a genuinely newer re-creation should be accepted")
	}
	if event := mustGet(t, q, time.Second); event.ResourceVersion != 10 {
		t.Fatalf("got version %d, want 10", event.ResourceVersion)
	}

	equal := NewQueue()
	equal.Add(Event{Type: EventUpdate, Namespace: "ns", Name: "same", ResourceVersion: 4})
	if !equal.Add(Event{Type: EventDelete, Namespace: "ns", Name: "same", ResourceVersion: 4}) {
		t.Fatal("an equal-version tombstone should replace a waiting update")
	}
	if event := mustGet(t, equal, time.Second); event.Type != EventDelete {
		t.Fatalf("got %s, want equal-version delete", event)
	}
}

func TestTombstoneBypassesRetryBackoff(t *testing.T) {
	q := NewQueue(Config{
		Backoff: map[ErrorClass]Backoff{
			ErrorClassTransient: {Base: time.Second, Max: time.Second, Multiplier: 2},
		},
	})
	key := Key("team-a", "widget")

	q.Add(Event{Type: EventUpdate, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 1})
	event := mustGet(t, q, time.Second)
	if !q.Fail(event, errors.New("temporary")) {
		t.Fatal("Fail should accept the delivered lease")
	}
	if stats := q.Stats(); stats.Delayed != 1 || stats.Ready != 0 {
		t.Fatalf("expected a delayed retry, got %+v", stats)
	}

	if !q.Add(Event{Type: EventDelete, Namespace: key.Namespace, Name: key.Name, ResourceVersion: 2}) {
		t.Fatal("delete should replace the delayed update")
	}
	if stats := q.Stats(); stats.Delayed != 0 || stats.Ready != 1 {
		t.Fatalf("tombstone should be ready immediately, got %+v", stats)
	}

	start := time.Now()
	event = mustGet(t, q, 200*time.Millisecond)
	if elapsed := time.Since(start); elapsed > 150*time.Millisecond {
		t.Fatalf("tombstone waited behind backoff for %s", elapsed)
	}
	if event.Type != EventDelete || event.ResourceVersion != 2 {
		t.Fatalf("got %s, want delete@2", event)
	}
}

func TestCategoryBackoffIsExponential(t *testing.T) {
	q := NewQueue(Config{
		Backoff: map[ErrorClass]Backoff{
			ErrorClassTransient: {Base: 50 * time.Millisecond, Max: time.Second, Multiplier: 2},
			ErrorClassConflict:  {Base: 150 * time.Millisecond, Max: time.Second, Multiplier: 2},
		},
	})

	event := Event{Name: "widget", ResourceVersion: 1}
	q.Add(event)
	event = mustGet(t, q, time.Second)
	q.Fail(event, WithClass(errors.New("try later"), ErrorClassTransient))

	firstStart := time.Now()
	expectNoEvent(t, q, 15*time.Millisecond)
	event = mustGet(t, q, 300*time.Millisecond)
	firstWait := time.Since(firstStart)

	q.Fail(event, errors.New("still temporary"))
	secondStart := time.Now()
	expectNoEvent(t, q, 30*time.Millisecond)
	event = mustGet(t, q, 400*time.Millisecond)
	secondWait := time.Since(secondStart)

	if firstWait < 40*time.Millisecond {
		t.Fatalf("first retry came too early: %s", firstWait)
	}
	if secondWait < 80*time.Millisecond {
		t.Fatalf("second retry was not exponentially longer: %s", secondWait)
	}
	if !q.Done(event) {
		t.Fatal("Done should succeed after the retry")
	}
}

func TestBackoffDelaySequence(t *testing.T) {
	policy := Backoff{Base: 10 * time.Millisecond, Max: 35 * time.Millisecond, Multiplier: 2}
	want := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 35 * time.Millisecond, 35 * time.Millisecond}
	for attempt, expected := range want {
		if got := policy.Delay(attempt + 1); got != expected {
			t.Fatalf("attempt %d: got %s, want %s", attempt+1, got, expected)
		}
	}
}

func TestExplicitDefaultBackoffOverridesBuiltInClasses(t *testing.T) {
	q := NewQueue(Config{
		DefaultBackoff: Backoff{Base: 15 * time.Millisecond, Max: 15 * time.Millisecond, Multiplier: 3},
	})
	for _, class := range []ErrorClass{ErrorClassTransient, ErrorClassConflict, ErrorClass("custom")} {
		if got := q.backoffFor(class).Base; got != 15*time.Millisecond {
			t.Fatalf("class %q used base %s, want 15ms", class, got)
		}
	}
}

func TestErrorClassificationAndTerminalFailure(t *testing.T) {
	if got := ClassifyError(WithClass(errors.New("x"), ErrorClassConflict)); got != ErrorClassConflict {
		t.Fatalf("got class %q, want conflict", got)
	}
	if got := ClassifyError(errors.Join(errors.New("outer"), ErrRateLimited)); got != ErrorClassRateLimited {
		t.Fatalf("got class %q, want rate-limited", got)
	}
	if got := ClassifyError(errors.New("unknown")); got != ErrorClassTransient {
		t.Fatalf("got class %q, want transient", got)
	}

	q := NewQueue()
	event := Event{Name: "widget", ResourceVersion: 1}
	q.Add(event)
	event = mustGet(t, q, time.Second)
	if !q.Fail(event, ErrTerminal) {
		t.Fatal("terminal failure should complete the lease")
	}
	if stats := q.Stats(); stats.Pending != 0 || stats.InFlight != 0 {
		t.Fatalf("terminal failure must not be retried, got %+v", stats)
	}
	expectNoEvent(t, q, 30*time.Millisecond)
}

func TestGlobalAndNamespaceBucketsBothApply(t *testing.T) {
	q := NewQueue(Config{
		Global:    RateLimit{Rate: 200, Burst: 1},
		Namespace: RateLimit{Rate: 40, Burst: 1},
	})

	q.Add(Event{Namespace: "a", Name: "one", ResourceVersion: 1})
	q.Add(Event{Namespace: "a", Name: "two", ResourceVersion: 1})
	first := mustGet(t, q, time.Second)
	q.Done(first)

	start := time.Now()
	second := mustGet(t, q, time.Second)
	elapsed := time.Since(start)
	q.Done(second)

	if elapsed < 20*time.Millisecond {
		t.Fatalf("namespace bucket should dominate at 40/s, got %s", elapsed)
	}
}

func TestNamespaceRoundRobinAvoidsStarvation(t *testing.T) {
	q := NewQueue(Config{
		Global:    RateLimit{Rate: 1000, Burst: 1},
		Namespace: RateLimit{Rate: 1000, Burst: 1000},
	})

	for i := 0; i < 20; i++ {
		q.Add(Event{Namespace: "hot", Name: "hot-" + strconv.Itoa(i), ResourceVersion: 1})
	}
	q.Add(Event{Namespace: "cold", Name: "cold-1", ResourceVersion: 1})

	seenCold := false
	for i := 0; i < 3; i++ {
		event := mustGet(t, q, time.Second)
		if event.Namespace == "cold" {
			seenCold = true
		}
		q.Done(event)
	}
	if !seenCold {
		t.Fatal("cold namespace was starved behind a hot namespace")
	}
}

func TestOutOfOrderWatchDeliversMonotonicVersionsOnce(t *testing.T) {
	q := NewQueue()
	const last = 80

	order := rand.New(rand.NewSource(42)).Perm(last)
	producerDone := make(chan struct{})
	go func() {
		defer close(producerDone)
		for _, value := range order {
			q.Add(Event{
				Type:            EventUpdate,
				Namespace:       "watch",
				Name:            "object",
				ResourceVersion: uint64(value + 1),
			})
		}
	}()

	delivered := make(map[uint64]int)
	var previous uint64
	for {
		event := mustGet(t, q, time.Second)
		if event.ResourceVersion <= previous {
			t.Fatalf("versions went backwards: %d after %d", event.ResourceVersion, previous)
		}
		previous = event.ResourceVersion
		delivered[event.ResourceVersion]++
		q.Done(event)
		if event.ResourceVersion == last {
			break
		}
	}
	<-producerDone

	for version, count := range delivered {
		if count != 1 {
			t.Fatalf("version %d delivered %d times", version, count)
		}
	}
	expectNoEvent(t, q, 20*time.Millisecond)
}

func TestCancelBeforeDeliveryAllowsOneRequeue(t *testing.T) {
	q := NewQueue()
	event := Event{Name: "widget", ResourceVersion: 4}

	q.Add(event)
	if !q.Cancel(event) {
		t.Fatal("Cancel should remove a waiting event")
	}
	if !q.Add(event) {
		t.Fatal("an undelivered cancelled version may be re-added")
	}
	delivered := mustGet(t, q, time.Second)
	if delivered.ResourceVersion != 4 {
		t.Fatalf("got version %d, want 4", delivered.ResourceVersion)
	}
	q.Done(delivered)

	if q.Add(event) {
		t.Fatal("re-adding a delivered version must be rejected")
	}
}

func TestCancelInFlightIsAtMostOnce(t *testing.T) {
	q := NewQueue()
	event := Event{Name: "widget", ResourceVersion: 4}

	q.Add(event)
	delivered := mustGet(t, q, time.Second)
	if !q.Cancel(delivered) {
		t.Fatal("Cancel should invalidate an in-flight delivery")
	}
	if q.Done(delivered) {
		t.Fatal("Done after Cancel must be rejected")
	}
	if q.Add(event) {
		t.Fatal("an already delivered version must stay deduplicated")
	}

	if !q.Add(Event{Name: "widget", ResourceVersion: 5}) {
		t.Fatal("a newer version should still be accepted")
	}
	next := mustGet(t, q, time.Second)
	if next.ResourceVersion != 5 {
		t.Fatalf("got version %d, want 5", next.ResourceVersion)
	}
}

func TestGetHonorsContextCancellation(t *testing.T) {
	q := NewQueue()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan bool, 1)
	go func() {
		_, ok := q.Get(ctx)
		result <- ok
	}()

	cancel()
	select {
	case ok := <-result:
		if ok {
			t.Fatal("Get returned an event after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("Get did not observe context cancellation")
	}
}

func TestConcurrentDuplicateAddsDeliverOnce(t *testing.T) {
	q := NewQueue()
	event := Event{Name: "widget", ResourceVersion: 9}

	var accepted atomic.Int32
	var group sync.WaitGroup
	for i := 0; i < 64; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if q.Add(event) {
				accepted.Add(1)
			}
		}()
	}
	group.Wait()
	if accepted.Load() != 1 {
		t.Fatalf("accepted %d duplicate adds, want 1", accepted.Load())
	}

	delivered := mustGet(t, q, time.Second)
	q.Done(delivered)
	expectNoEvent(t, q, 20*time.Millisecond)
}

func TestDoneAndReenqueueRace(t *testing.T) {
	for i := 0; i < 100; i++ {
		q := NewQueue()
		event := Event{Name: "widget", ResourceVersion: 1}
		q.Add(event)
		delivered := mustGet(t, q, time.Second)

		var group sync.WaitGroup
		group.Add(2)
		go func() {
			defer group.Done()
			q.Done(delivered)
		}()
		go func() {
			defer group.Done()
			q.Add(event)
		}()
		group.Wait()

		expectNoEvent(t, q, 5*time.Millisecond)
	}
}

func TestCancelAndReenqueueRaceAtMostOnce(t *testing.T) {
	for i := 0; i < 30; i++ {
		q := NewQueue()
		event := Event{Name: "widget", ResourceVersion: 1}
		q.Add(event)

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		var delivered atomic.Int32
		var group sync.WaitGroup
		group.Add(3)

		go func() {
			defer group.Done()
			if got, ok := q.Get(ctx); ok {
				delivered.Add(1)
				q.Done(got)
			}
		}()
		go func() {
			defer group.Done()
			q.Cancel(event)
		}()
		go func() {
			defer group.Done()
			q.Add(event)
		}()

		group.Wait()
		cancel()

		if got, ok := q.TryGet(); ok {
			delivered.Add(1)
			q.Done(got)
		}
		if delivered.Load() > 1 {
			t.Fatalf("iteration %d delivered version more than once", i)
		}
	}
}

func TestShutdownReleasesBlockedGet(t *testing.T) {
	q := NewQueue()
	result := make(chan bool, 1)
	go func() {
		_, ok := q.Get(context.Background())
		result <- ok
	}()

	time.Sleep(10 * time.Millisecond)
	q.ShutDown()
	select {
	case ok := <-result:
		if ok {
			t.Fatal("Get returned an event after shutdown")
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not release Get")
	}
	if !q.ShuttingDown() {
		t.Fatal("ShuttingDown should report true")
	}
	if q.Add(Event{Name: "late", ResourceVersion: 1}) {
		t.Fatal("Add after shutdown should be rejected")
	}
}

func TestStatsTrackReadyDelayedAndInFlight(t *testing.T) {
	q := NewQueue(Config{
		Backoff: map[ErrorClass]Backoff{
			ErrorClassTransient: {Base: time.Second, Max: time.Second, Multiplier: 2},
		},
	})
	q.Add(Event{Name: "one", ResourceVersion: 1})
	q.Add(Event{Name: "two", ResourceVersion: 1})
	if stats := q.Stats(); stats.Pending != 2 || stats.Ready != 2 || stats.Namespaces != 1 {
		t.Fatalf("unexpected stats before delivery: %+v", stats)
	}

	event := mustGet(t, q, time.Second)
	if stats := q.Stats(); stats.InFlight != 1 || stats.Ready != 1 {
		t.Fatalf("unexpected stats after delivery: %+v", stats)
	}
	q.Fail(event, errors.New("retry"))
	if stats := q.Stats(); stats.InFlight != 0 || stats.Delayed != 1 || stats.Ready != 1 {
		t.Fatalf("unexpected stats after failure: %+v", stats)
	}
}
