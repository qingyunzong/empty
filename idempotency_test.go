package formal

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock(now time.Time) *fakeClock {
	return &fakeClock{now: now}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		runtime.Gosched()
		time.Sleep(time.Millisecond)
	}
}

func TestDoReusesPublishedResult(t *testing.T) {
	store := New[string, int](time.Minute)
	var executions atomic.Int32
	fn := func(context.Context) (int, error) {
		executions.Add(1)
		return 41, nil
	}

	first, err := store.Do(context.Background(), "key", fn)
	if err != nil || first != 41 {
		t.Fatalf("first Do = (%d, %v), want (41, nil)", first, err)
	}
	for i := 0; i < 10; i++ {
		got, err := store.Do(context.Background(), "key", fn)
		if err != nil || got != 41 {
			t.Fatalf("reused Do = (%d, %v), want (41, nil)", got, err)
		}
	}
	if got := executions.Load(); got != 1 {
		t.Fatalf("executions = %d, want 1", got)
	}
}

func TestDoConcurrentCallersShareOneExecution(t *testing.T) {
	const callers = 128

	store := New[string, int](time.Minute)
	started := make(chan struct{})
	release := make(chan struct{})
	var startOnce sync.Once
	var executions atomic.Int32

	results := make(chan struct {
		value int
		err   error
	}, callers)
	begin := make(chan struct{})
	for i := 0; i < callers; i++ {
		go func() {
			<-begin
			value, err := store.Do(context.Background(), "same", func(context.Context) (int, error) {
				executions.Add(1)
				startOnce.Do(func() { close(started) })
				<-release
				return 99, nil
			})
			results <- struct {
				value int
				err   error
			}{value, err}
		}()
	}
	close(begin)

	<-started
	waitFor(t, "all callers to join", func() bool {
		return store.Waiting("same") == callers-1
	})
	close(release)

	for i := 0; i < callers; i++ {
		result := <-results
		if result.err != nil || result.value != 99 {
			t.Fatalf("result %d = (%d, %v), want (99, nil)", i, result.value, result.err)
		}
	}
	if got := executions.Load(); got != 1 {
		t.Fatalf("executions = %d, want 1", got)
	}
	if got := store.Waiting("same"); got != 0 {
		t.Fatalf("remaining waiters = %d, want 0", got)
	}
}

func TestConcurrentDistinctKeysExecuteIndependently(t *testing.T) {
	const keys = 32

	store := New[int, int](time.Minute)
	var executions atomic.Int32
	var wg sync.WaitGroup
	for key := 0; key < keys; key++ {
		key := key
		wg.Add(1)
		go func() {
			defer wg.Done()
			value, err := store.Do(context.Background(), key, func(context.Context) (int, error) {
				executions.Add(1)
				return key * 10, nil
			})
			if err != nil || value != key*10 {
				t.Errorf("key %d = (%d, %v), want (%d, nil)", key, value, err, key*10)
			}
		}()
	}
	wg.Wait()

	if got := executions.Load(); got != keys {
		t.Fatalf("executions = %d, want %d", got, keys)
	}
}

type observedDoneContext struct {
	context.Context
	once       sync.Once
	doneCalled chan struct{}
}

func (c *observedDoneContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.doneCalled) })
	return c.Context.Done()
}

func TestCanceledWaiterDoesNotCancelLeader(t *testing.T) {
	store := New[string, int](time.Minute)
	started := make(chan struct{})
	release := make(chan struct{})
	var executions atomic.Int32

	leader := make(chan struct {
		value int
		err   error
	}, 1)
	go func() {
		value, err := store.Do(context.Background(), "key", func(context.Context) (int, error) {
			executions.Add(1)
			close(started)
			<-release
			return 7, nil
		})
		leader <- struct {
			value int
			err   error
		}{value, err}
	}()
	<-started

	base, cancel := context.WithCancel(context.Background())
	watched := &observedDoneContext{Context: base, doneCalled: make(chan struct{})}
	waiter := make(chan error, 1)
	go func() {
		_, err := store.Do(watched, "key", func(context.Context) (int, error) {
			return 0, errors.New("waiter must not execute")
		})
		waiter <- err
	}()

	<-watched.doneCalled
	cancel()
	if err := <-waiter; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiter error = %v, want context.Canceled", err)
	}

	close(release)
	if result := <-leader; result.err != nil || result.value != 7 {
		t.Fatalf("leader = (%d, %v), want (7, nil)", result.value, result.err)
	}
	if got := executions.Load(); got != 1 {
		t.Fatalf("executions = %d, want 1", got)
	}
	if got, err := store.Do(context.Background(), "key", func(context.Context) (int, error) {
		executions.Add(1)
		return 0, nil
	}); err != nil || got != 7 {
		t.Fatalf("cached Do = (%d, %v), want (7, nil)", got, err)
	}
}

func TestPrecanceledCallDoesNotExecute(t *testing.T) {
	store := New[string, int](time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var executions atomic.Int32
	_, err := store.Do(ctx, "key", func(context.Context) (int, error) {
		executions.Add(1)
		return 1, nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if got := executions.Load(); got != 0 {
		t.Fatalf("executions = %d, want 0", got)
	}
	if got := store.Len(); got != 0 {
		t.Fatalf("Len = %d, want 0", got)
	}
}

func TestErrorsAndPanicsArePublished(t *testing.T) {
	t.Run("error", func(t *testing.T) {
		store := New[string, int](time.Minute)
		wantErr := errors.New("upstream failed")
		var executions atomic.Int32
		fn := func(context.Context) (int, error) {
			executions.Add(1)
			return 0, wantErr
		}

		if _, err := store.Do(context.Background(), "key", fn); !errors.Is(err, wantErr) {
			t.Fatalf("first error = %v, want %v", err, wantErr)
		}
		if _, err := store.Do(context.Background(), "key", fn); !errors.Is(err, wantErr) {
			t.Fatalf("cached error = %v, want %v", err, wantErr)
		}
		if got := executions.Load(); got != 1 {
			t.Fatalf("executions = %d, want 1", got)
		}
	})

	t.Run("panic", func(t *testing.T) {
		store := New[string, int](time.Minute)
		var executions atomic.Int32
		started := make(chan struct{})
		var startOnce sync.Once
		release := make(chan struct{})

		const callers = 16
		errs := make(chan error, callers)
		leaderPanicked := make(chan any, 1)
		for i := 0; i < callers; i++ {
			go func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						leaderPanicked <- recovered
					}
				}()
				_, err := store.Do(context.Background(), "panic", func(context.Context) (int, error) {
					executions.Add(1)
					startOnce.Do(func() { close(started) })
					<-release
					panic("boom")
				})
				errs <- err
			}()
		}
		<-started
		waitFor(t, "panic waiters", func() bool {
			return store.Waiting("panic") == callers-1
		})
		close(release)

		select {
		case <-leaderPanicked:
		case <-time.After(5 * time.Second):
			t.Fatal("leader did not panic")
		}
		for i := 0; i < callers-1; i++ {
			select {
			case err := <-errs:
				if !errors.Is(err, ErrPanic) {
					t.Fatalf("waiter error = %v, want ErrPanic", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("waiter did not return")
			}
		}
		if got := executions.Load(); got != 1 {
			t.Fatalf("executions = %d, want 1", got)
		}
		if _, err := store.Do(context.Background(), "panic", func(context.Context) (int, error) {
			executions.Add(1)
			return 0, nil
		}); !errors.Is(err, ErrPanic) {
			t.Fatalf("cached panic error = %v, want ErrPanic", err)
		}
	})
}

func TestExpiryStartsWhenResultIsPublished(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	clock := newFakeClock(t0)
	const ttl = 10 * time.Second
	store := NewWithClock[string, int](ttl, clock)

	var executions atomic.Int32
	fn := func(context.Context) (int, error) {
		return int(executions.Add(1)), nil
	}

	if got, _ := store.Do(context.Background(), "key", fn); got != 1 {
		t.Fatalf("first value = %d, want 1", got)
	}
	clock.Advance(ttl - time.Nanosecond)
	if got, _ := store.Do(context.Background(), "key", fn); got != 1 {
		t.Fatalf("value before expiry = %d, want 1", got)
	}
	clock.Advance(time.Nanosecond)
	if got, _ := store.Do(context.Background(), "key", fn); got != 2 {
		t.Fatalf("value at expiry = %d, want 2", got)
	}
	if got := executions.Load(); got != 2 {
		t.Fatalf("executions = %d, want 2", got)
	}

	// A request that starts before expiry but finishes much later gets a full
	// result lifetime measured from publication.
	started := make(chan struct{})
	release := make(chan struct{})
	longRun := make(chan int, 1)
	go func() {
		value, _ := store.Do(context.Background(), "long", func(context.Context) (int, error) {
			executions.Add(1)
			close(started)
			<-release
			return 2, nil
		})
		longRun <- value
	}()
	<-started
	clock.Advance(20 * ttl)
	close(release)
	if value := <-longRun; value != 2 {
		t.Fatalf("long-running value = %d, want 2", value)
	}
	clock.Advance(ttl - time.Nanosecond)
	if got, _ := store.Do(context.Background(), "long", fn); got != 2 {
		t.Fatalf("published result was not kept for a full TTL: got %d", got)
	}
	clock.Advance(time.Nanosecond)
	if got, _ := store.Do(context.Background(), "long", fn); got != 4 {
		t.Fatalf("value after publication TTL = %d, want 4", got)
	}
}

func TestReapSkipsInFlightButRemovesExpiredCompletedEntries(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	clock := newFakeClock(t0)
	const ttl = 10 * time.Second
	store := NewWithClock[string, int](ttl, clock)

	for _, key := range []string{"a", "b"} {
		key := key
		if _, err := store.Do(context.Background(), key, func(context.Context) (int, error) {
			return len(key), nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	clock.Advance(ttl - time.Second)
	if got := store.Reap(); got != 0 {
		t.Fatalf("early Reap removed %d, want 0", got)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	var executions atomic.Int32
	call := make(chan struct {
		value int
		err   error
	}, 1)
	go func() {
		value, err := store.Do(context.Background(), "in-flight", func(context.Context) (int, error) {
			executions.Add(1)
			close(started)
			<-release
			return 3, nil
		})
		call <- struct {
			value int
			err   error
		}{value, err}
	}()
	<-started

	clock.Advance(100 * ttl)
	if got := store.Reap(); got != 2 {
		t.Fatalf("Reap removed %d, want 2 expired completed entries", got)
	}
	if got := store.InFlight(); got != 1 {
		t.Fatalf("InFlight = %d, want 1", got)
	}
	if got := store.Reap(); got != 0 {
		t.Fatalf("Reap removed in-flight entry: %d", got)
	}
	if _, ok := store.Get("a"); ok {
		t.Fatal("expired entry a is still readable")
	}

	close(release)
	if result := <-call; result.err != nil || result.value != 3 {
		t.Fatalf("in-flight result = (%d, %v), want (3, nil)", result.value, result.err)
	}
	if got := store.Reap(); got != 0 {
		t.Fatalf("freshly published result was reaped: %d", got)
	}
	clock.Advance(ttl - time.Nanosecond)
	if result, ok := store.Get("in-flight"); !ok || result.Value != 3 {
		t.Fatalf("published result before its TTL = (%+v, %v)", result, ok)
	}
	clock.Advance(time.Nanosecond)
	if got := store.Reap(); got != 1 {
		t.Fatalf("Reap after TTL removed %d, want 1", got)
	}
	if got := executions.Load(); got != 1 {
		t.Fatalf("executions = %d, want 1", got)
	}
}

func TestCompletionAndReapInterleavingsDoNotRepeatExecution(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	const ttl = 10 * time.Second

	for iteration := 0; iteration < 250; iteration++ {
		clock := newFakeClock(t0)
		store := NewWithClock[string, int](ttl, clock)

		started := make(chan struct{})
		release := make(chan struct{})
		var executions atomic.Int32
		callDone := make(chan struct {
			value int
			err   error
		}, 1)
		go func() {
			value, err := store.Do(context.Background(), "key", func(context.Context) (int, error) {
				executions.Add(1)
				close(started)
				<-release
				return 5, nil
			})
			callDone <- struct {
				value int
				err   error
			}{value, err}
		}()
		<-started
		clock.Advance(10 * ttl)

		gate := make(chan struct{})
		reaperDone := make(chan int, 1)
		go func() {
			<-gate
			reaperDone <- store.Reap()
		}()
		go func() {
			<-gate
			close(release)
		}()
		close(gate)

		if result := <-callDone; result.err != nil || result.value != 5 {
			t.Fatalf("iteration %d: call = (%d, %v)", iteration, result.value, result.err)
		}
		if removed := <-reaperDone; removed != 0 {
			t.Fatalf("iteration %d: Reap removed %d entries", iteration, removed)
		}
		if got := store.Reap(); got != 0 {
			t.Fatalf("iteration %d: result expired before its publication TTL: %d", iteration, got)
		}
		if got, err := store.Do(context.Background(), "key", func(context.Context) (int, error) {
			executions.Add(1)
			return 100, nil
		}); err != nil || got != 5 {
			t.Fatalf("iteration %d: cached result = (%d, %v), want (5, nil)", iteration, got, err)
		}
		if got := executions.Load(); got != 1 {
			t.Fatalf("iteration %d: executions = %d, want 1", iteration, got)
		}
	}
}

func TestGetDeleteCloseAndTTLZero(t *testing.T) {
	t.Run("get and delete", func(t *testing.T) {
		store := New[string, int](time.Minute)
		started := make(chan struct{})
		release := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = store.Do(context.Background(), "key", func(context.Context) (int, error) {
				close(started)
				<-release
				return 8, nil
			})
		}()
		<-started
		if _, ok := store.Get("key"); ok {
			t.Fatal("Get returned an in-flight entry")
		}
		if store.Delete("key") {
			t.Fatal("Delete removed an in-flight entry")
		}
		close(release)
		<-done

		if result, ok := store.Get("key"); !ok || result.Value != 8 || result.Err != nil {
			t.Fatalf("Get = (%+v, %v), want value 8", result, ok)
		}
		if !store.Delete("key") {
			t.Fatal("Delete did not remove a completed entry")
		}
		if store.Delete("key") {
			t.Fatal("Delete removed a missing entry")
		}
	})

	t.Run("close", func(t *testing.T) {
		store := New[string, int](time.Minute)
		if _, err := store.Do(context.Background(), "key", func(context.Context) (int, error) {
			return 1, nil
		}); err != nil {
			t.Fatal(err)
		}
		store.Close()
		if _, err := store.Do(context.Background(), "new", func(context.Context) (int, error) {
			return 2, nil
		}); !errors.Is(err, ErrClosed) {
			t.Fatalf("Do after Close error = %v, want ErrClosed", err)
		}
		if result, ok := store.Get("key"); !ok || result.Value != 1 {
			t.Fatalf("published result after Close = (%+v, %v)", result, ok)
		}
	})

	t.Run("non-positive ttl never expires", func(t *testing.T) {
		clock := newFakeClock(time.Unix(1_700_000_000, 0))
		store := NewWithClock[string, int](0, clock)
		var executions atomic.Int32
		fn := func(context.Context) (int, error) {
			return int(executions.Add(1)), nil
		}
		if got, _ := store.Do(context.Background(), "key", fn); got != 1 {
			t.Fatalf("first value = %d", got)
		}
		clock.Advance(100 * 365 * 24 * time.Hour)
		if got := store.Reap(); got != 0 {
			t.Fatalf("Reap removed %d entries with TTL disabled", got)
		}
		if got, _ := store.Do(context.Background(), "key", fn); got != 1 {
			t.Fatalf("value = %d, want cached 1", got)
		}
	})
}

func TestSweepReapsAndStopsWithContext(t *testing.T) {
	clock := newFakeClock(time.Unix(1_700_000_000, 0))
	const ttl = time.Minute
	store := NewWithClock[string, int](ttl, clock)
	if _, err := store.Do(context.Background(), "key", func(context.Context) (int, error) {
		return 1, nil
	}); err != nil {
		t.Fatal(err)
	}
	clock.Advance(ttl)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- store.Sweep(ctx, time.Millisecond)
	}()
	waitFor(t, "sweep to reap the expired entry", func() bool {
		return store.Len() == 0
	})
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Sweep error = %v, want context.Canceled", err)
	}
	if err := store.Sweep(context.Background(), 0); err == nil {
		t.Fatal("Sweep accepted a non-positive interval")
	}
}

func TestNilFunctionIsRejected(t *testing.T) {
	store := New[string, int](time.Minute)
	if _, err := store.Do(context.Background(), "key", nil); !errors.Is(err, ErrNilFunc) {
		t.Fatalf("error = %v, want ErrNilFunc", err)
	}
	if got := store.Len(); got != 0 {
		t.Fatalf("Len = %d, want 0", got)
	}
}

// naiveRequestTable is an intentionally simple, non-concurrent reference.
// It recomputes which request must execute from the current table state.
type naiveRequestTable struct {
	ttl        time.Duration
	now        time.Time
	entries    map[string]naiveResult
	inFlight   map[string]bool
	executions map[string]int
}

type naiveResult struct {
	value     int
	expiresAt time.Time
}

func newNaiveRequestTable(now time.Time, ttl time.Duration) *naiveRequestTable {
	return &naiveRequestTable{
		ttl:        ttl,
		now:        now,
		entries:    make(map[string]naiveResult),
		inFlight:   make(map[string]bool),
		executions: make(map[string]int),
	}
}

func (n *naiveRequestTable) live(key string) (naiveResult, bool) {
	result, ok := n.entries[key]
	if !ok {
		return naiveResult{}, false
	}
	if n.ttl > 0 && !n.now.Before(result.expiresAt) {
		delete(n.entries, key)
		return naiveResult{}, false
	}
	return result, true
}

func (n *naiveRequestTable) begin(key string) {
	if n.inFlight[key] {
		panic("begin while in flight")
	}
	if _, ok := n.live(key); ok {
		panic("begin while a result is live")
	}
	n.inFlight[key] = true
	n.executions[key]++
}

func (n *naiveRequestTable) finish(key string, value int) {
	if !n.inFlight[key] {
		panic("finish without a flight")
	}
	delete(n.inFlight, key)
	expiresAt := time.Time{}
	if n.ttl > 0 {
		expiresAt = n.now.Add(n.ttl)
	}
	n.entries[key] = naiveResult{value: value, expiresAt: expiresAt}
}

func (n *naiveRequestTable) request(key string, value int) (int, bool) {
	if result, ok := n.live(key); ok {
		return result.value, false
	}
	n.executions[key]++
	expiresAt := time.Time{}
	if n.ttl > 0 {
		expiresAt = n.now.Add(n.ttl)
	}
	n.entries[key] = naiveResult{value: value, expiresAt: expiresAt}
	return value, true
}

func (n *naiveRequestTable) advance(d time.Duration) {
	n.now = n.now.Add(d)
}

func (n *naiveRequestTable) reap() int {
	removed := 0
	for key, result := range n.entries {
		if n.ttl > 0 && !n.now.Before(result.expiresAt) {
			delete(n.entries, key)
			removed++
		}
	}
	return removed
}

func (n *naiveRequestTable) delete(key string) bool {
	if n.inFlight[key] {
		return false
	}
	if _, ok := n.entries[key]; !ok {
		return false
	}
	delete(n.entries, key)
	return true
}

type scenarioAction int

const (
	actionBegin scenarioAction = iota
	actionJoin
	actionTick
	actionReap
	actionFinish
	actionDelete
)

func (a scenarioAction) String() string {
	switch a {
	case actionBegin:
		return "begin"
	case actionJoin:
		return "join"
	case actionTick:
		return "tick"
	case actionReap:
		return "reap"
	case actionFinish:
		return "finish"
	case actionDelete:
		return "delete"
	default:
		return fmt.Sprintf("action(%d)", a)
	}
}

func validActionOrder(actions []scenarioAction) bool {
	begun, finished := false, false
	for _, action := range actions {
		switch action {
		case actionBegin:
			if begun {
				return false
			}
			begun = true
		case actionJoin:
			if !begun || finished {
				return false
			}
		case actionFinish:
			if !begun || finished {
				return false
			}
			finished = true
		}
	}
	return true
}

func permutationsOfActions() [][]scenarioAction {
	base := []scenarioAction{
		actionBegin,
		actionJoin,
		actionTick,
		actionReap,
		actionFinish,
		actionDelete,
	}
	var result [][]scenarioAction
	var generate func(int)
	generate = func(index int) {
		if index == len(base) {
			if validActionOrder(base) {
				order := append([]scenarioAction(nil), base...)
				result = append(result, order)
			}
			return
		}
		for i := index; i < len(base); i++ {
			base[index], base[i] = base[i], base[index]
			generate(index + 1)
			base[index], base[i] = base[i], base[index]
		}
	}
	generate(0)
	return result
}

type callOutcome struct {
	value int
	err   error
}

// TestExhaustiveRaceSequences compares the store with a naive request table
// for every valid ordering of an in-flight request, a joining request, a clock
// tick, reclamation, publication, and explicit deletion.
func TestExhaustiveRaceSequences(t *testing.T) {
	const (
		key  = "key"
		ttl  = 10 * time.Second
		base = 1000
	)
	orders := permutationsOfActions()
	if len(orders) == 0 {
		t.Fatal("no action orders generated")
	}

	for scenarioIndex, actions := range orders {
		actions := actions
		t.Run(fmt.Sprint(actions), func(t *testing.T) {
			t0 := time.Unix(1_700_000_000, 0)
			clock := newFakeClock(t0)
			store := NewWithClock[string, int](ttl, clock)
			model := newNaiveRequestTable(t0, ttl)
			flightValue := base + scenarioIndex

			started := make(chan struct{})
			release := make(chan struct{})
			var startOnce sync.Once
			var actualExecutions atomic.Int32
			calls := make([]chan callOutcome, 0, 2)
			followers := 0

			startCall := func(blocking bool) {
				outcome := make(chan callOutcome, 1)
				calls = append(calls, outcome)
				go func() {
					value, err := store.Do(context.Background(), key, func(context.Context) (int, error) {
						actualExecutions.Add(1)
						startOnce.Do(func() { close(started) })
						if blocking {
							<-release
						}
						return flightValue, nil
					})
					outcome <- callOutcome{value: value, err: err}
				}()
			}

			for _, action := range actions {
				switch action {
				case actionBegin:
					if _, ok := model.live(key); ok {
						t.Fatalf("begin while a live result exists")
					}
					model.begin(key)
					startCall(true)
					select {
					case <-started:
					case outcome := <-calls[0]:
						t.Fatalf("begin did not execute: (%d, %v)", outcome.value, outcome.err)
					case <-time.After(5 * time.Second):
						t.Fatal("begin did not start")
					}

				case actionJoin:
					if !model.inFlight[key] {
						t.Fatal("join without an in-flight request")
					}
					followers++
					startCall(false)
					want := followers
					waitFor(t, fmt.Sprintf("%d joiners", want), func() bool {
						return store.Waiting(key) == want
					})

				case actionTick:
					clock.Advance(ttl)
					model.advance(ttl)

				case actionReap:
					want := model.reap()
					if got := store.Reap(); got != want {
						t.Fatalf("Reap = %d, want %d", got, want)
					}

				case actionFinish:
					model.finish(key, flightValue)
					close(release)
					for i, outcome := range calls {
						select {
						case result := <-outcome:
							if result.err != nil || result.value != flightValue {
								t.Fatalf("call %d = (%d, %v), want (%d, nil)", i, result.value, result.err, flightValue)
							}
						case <-time.After(5 * time.Second):
							t.Fatalf("call %d did not return", i)
						}
					}
					calls = calls[:0]

				case actionDelete:
					want := model.delete(key)
					if got := store.Delete(key); got != want {
						t.Fatalf("Delete = %v, want %v", got, want)
					}
				}

				if got, want := store.InFlight(), len(model.inFlight); got != want {
					t.Fatalf("after %s: InFlight = %d, want %d", action, got, want)
				}
			}

			finalValue := base + 500 + scenarioIndex
			wantValue, wantExecuted := model.request(key, finalValue)
			gotValue, err := store.Do(context.Background(), key, func(context.Context) (int, error) {
				actualExecutions.Add(1)
				return finalValue, nil
			})
			if err != nil || gotValue != wantValue {
				t.Fatalf("final Do = (%d, %v), want (%d, nil)", gotValue, err, wantValue)
			}
			expectedExecutions := model.executions[key]
			if got := int(actualExecutions.Load()); got != expectedExecutions {
				t.Fatalf("executions = %d, want %d (final executed: %v)", got, expectedExecutions, wantExecuted)
			}
		})
	}
}

func TestReferenceTableAcrossInterleavedKeys(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	const ttl = 10 * time.Second
	clock := newFakeClock(t0)
	store := NewWithClock[string, int](ttl, clock)
	model := newNaiveRequestTable(t0, ttl)

	var executions atomic.Int32
	for step := 0; step < 200; step++ {
		key := fmt.Sprintf("key-%d", step%7)
		value := 100 + step
		wantValue, wantExecute := model.request(key, value)
		executionsBefore := executions.Load()
		gotValue, err := store.Do(context.Background(), key, func(context.Context) (int, error) {
			executions.Add(1)
			return value, nil
		})
		if err != nil || gotValue != wantValue {
			t.Fatalf("step %d: Do = (%d, %v), want (%d, nil)", step, gotValue, err, wantValue)
		}
		if executed := executions.Load() != executionsBefore; executed != wantExecute {
			t.Fatalf("step %d: executed = %v, want %v", step, executed, wantExecute)
		}

		switch step % 9 {
		case 4:
			clock.Advance(ttl)
			model.advance(ttl)
		case 7:
			want := model.reap()
			if got := store.Reap(); got != want {
				t.Fatalf("step %d: Reap = %d, want %d", step, got, want)
			}
		case 8:
			if want, got := model.delete(key), store.Delete(key); got != want {
				t.Fatalf("step %d: Delete = %v, want %v", step, got, want)
			}
		}
	}
}
