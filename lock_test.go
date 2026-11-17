package formal_test

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	formal "example.org/dlks/formal/q10162"
)

const testTimeout = 5 * time.Second

func mustClient(t *testing.T, backend formal.Backend, ttl time.Duration) *formal.Client {
	t.Helper()
	client, err := formal.NewClient(backend, ttl)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})
	return client
}

func mustAcquire(t *testing.T, client *formal.Client, lock string) *formal.Handle {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	handle, err := client.Acquire(ctx, lock)
	if err != nil {
		t.Fatalf("Acquire(%q): %v", lock, err)
	}
	return handle
}

type acquireOutcome struct {
	handle *formal.Handle
	err    error
}

func acquireAsync(client *formal.Client, lock string) <-chan acquireOutcome {
	out := make(chan acquireOutcome, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		handle, err := client.Acquire(ctx, lock)
		out <- acquireOutcome{handle: handle, err: err}
	}()
	return out
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func nextEvent(t *testing.T, ch <-chan formal.Event) formal.Event {
	t.Helper()
	select {
	case event := <-ch:
		return event
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for event")
		return formal.Event{}
	}
}

func expectNoEvent(t *testing.T, what string, ch <-chan formal.Event) {
	t.Helper()
	select {
	case event := <-ch:
		t.Fatalf("%s unexpectedly got event %s", what, event.Type)
	case <-time.After(10 * time.Millisecond):
	}
}

func TestMutualExclusionAndStrictlyIncreasingTokens(t *testing.T) {
	coordinator := formal.NewCoordinator(formal.NewFakeClock())
	t.Cleanup(func() { _ = coordinator.Close() })

	const contenders = 24
	clients := make([]*formal.Client, contenders)
	for i := range clients {
		clients[i] = mustClient(t, coordinator, time.Hour)
	}

	var (
		active    int32
		maxActive int32
		counter   int64
		tokenMu   sync.Mutex
		tokens    []formal.Token
		wg        sync.WaitGroup
	)
	errs := make(chan error, contenders)
	start := make(chan struct{})

	for _, client := range clients {
		wg.Add(1)
		go func(client *formal.Client) {
			defer wg.Done()
			<-start

			ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
			defer cancel()
			handle, err := client.Acquire(ctx, "counter")
			if err != nil {
				errs <- err
				return
			}

			current := atomic.AddInt32(&active, 1)
			for {
				previous := atomic.LoadInt32(&maxActive)
				if current <= previous || atomic.CompareAndSwapInt32(&maxActive, previous, current) {
					break
				}
			}
			atomic.AddInt64(&counter, 1)
			tokenMu.Lock()
			tokens = append(tokens, handle.Token())
			tokenMu.Unlock()

			runtime.Gosched()
			atomic.AddInt32(&active, -1)
			if err := handle.Unlock(); err != nil {
				errs <- err
			}
		}(client)
	}

	close(start)
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("contenders deadlocked")
	}
	close(errs)
	for err := range errs {
		t.Fatalf("contender failed: %v", err)
	}

	if got := atomic.LoadInt64(&counter); got != contenders {
		t.Fatalf("counter = %d, want %d", got, contenders)
	}
	if got := atomic.LoadInt32(&maxActive); got != 1 {
		t.Fatalf("maximum concurrent holders = %d, want 1", got)
	}
	if len(tokens) != contenders {
		t.Fatalf("recorded %d tokens, want %d", len(tokens), contenders)
	}
	for i := 1; i < len(tokens); i++ {
		if tokens[i] <= tokens[i-1] {
			t.Fatalf("tokens are not strictly increasing at %d: %d then %d",
				i, tokens[i-1], tokens[i])
		}
	}
}

func TestFIFOQueueAndCanceledHead(t *testing.T) {
	coordinator := formal.NewCoordinator(formal.NewFakeClock())
	t.Cleanup(func() { _ = coordinator.Close() })

	open := func(name string, ttl time.Duration) (formal.SessionID, <-chan formal.Event) {
		t.Helper()
		events := make(chan formal.Event, 64)
		session, err := coordinator.OpenSession(ttl, func(event formal.Event) {
			events <- event
		})
		if err != nil {
			t.Fatalf("%s OpenSession: %v", name, err)
		}
		return session, events
	}

	s1, events1 := open("s1", time.Hour)
	s2, events2 := open("s2", time.Hour)
	s3, events3 := open("s3", time.Hour)

	sequence1, err := coordinator.Acquire(s1, 1, "fifo")
	if err != nil {
		t.Fatal(err)
	}
	grant1 := nextEvent(t, events1)
	if grant1.Type != formal.EventGranted || grant1.Sequence != sequence1 {
		t.Fatalf("first grant = %+v", grant1)
	}

	sequence2, err := coordinator.Acquire(s2, 2, "fifo")
	if err != nil {
		t.Fatal(err)
	}
	sequence3, err := coordinator.Acquire(s3, 3, "fifo")
	if err != nil {
		t.Fatal(err)
	}
	if !(sequence1 < sequence2 && sequence2 < sequence3) {
		t.Fatalf("sequences are not increasing: %d, %d, %d", sequence1, sequence2, sequence3)
	}
	if got := coordinator.QueueLength("fifo"); got != 2 {
		t.Fatalf("queue length = %d, want 2", got)
	}
	expectNoEvent(t, "second waiter", events2)
	expectNoEvent(t, "third waiter", events3)

	if err := coordinator.Release(s1, "fifo", grant1.Token); err != nil {
		t.Fatal(err)
	}
	grant2 := nextEvent(t, events2)
	if grant2.Type != formal.EventGranted || grant2.Token <= grant1.Token {
		t.Fatalf("second grant = %+v after token %d", grant2, grant1.Token)
	}
	expectNoEvent(t, "third waiter", events3)

	if err := coordinator.Release(s2, "fifo", grant2.Token); err != nil {
		t.Fatal(err)
	}
	grant3 := nextEvent(t, events3)
	if grant3.Type != formal.EventGranted || grant3.Token <= grant2.Token {
		t.Fatalf("third grant = %+v after token %d", grant3, grant2.Token)
	}

	// A canceled head must be skipped without allowing a later request to
	// overtake it.
	head, headEvents := open("head", time.Hour)
	middle, middleEvents := open("middle", time.Hour)
	tail, tailEvents := open("tail", time.Hour)

	if _, err := coordinator.Acquire(head, 10, "cancel-head"); err != nil {
		t.Fatal(err)
	}
	headGrant := nextEvent(t, headEvents)
	if _, err := coordinator.Acquire(middle, 11, "cancel-head"); err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.Acquire(tail, 12, "cancel-head"); err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Cancel(middle, 11); err != nil {
		t.Fatal(err)
	}
	if got := coordinator.PendingRequests("cancel-head"); len(got) != 1 || got[0] != 12 {
		t.Fatalf("pending requests = %v, want [12]", got)
	}
	if err := coordinator.Release(head, "cancel-head", headGrant.Token); err != nil {
		t.Fatal(err)
	}
	tailGrant := nextEvent(t, tailEvents)
	if tailGrant.Type != formal.EventGranted {
		t.Fatalf("tail grant = %+v", tailGrant)
	}
	expectNoEvent(t, "canceled middle request", middleEvents)
}

func TestSameSessionReentrancy(t *testing.T) {
	coordinator := formal.NewCoordinator(formal.NewFakeClock())
	t.Cleanup(func() { _ = coordinator.Close() })

	first := mustClient(t, coordinator, time.Hour)
	second := mustClient(t, coordinator, time.Hour)

	outer := mustAcquire(t, first, "reentrant")
	inner := mustAcquire(t, first, "reentrant")
	if inner.Token() != outer.Token() {
		t.Fatalf("nested token = %d, want %d", inner.Token(), outer.Token())
	}
	if !outer.Valid() || !inner.Valid() {
		t.Fatal("nested handles should both be valid")
	}

	waiting := acquireAsync(second, "reentrant")
	eventually(t, "second client to queue", func() bool {
		return coordinator.QueueLength("reentrant") == 1
	})

	if err := inner.Unlock(); err != nil {
		t.Fatalf("inner Unlock: %v", err)
	}
	if !outer.Valid() {
		t.Fatal("outer handle lost ownership after inner Unlock")
	}
	select {
	case outcome := <-waiting:
		t.Fatalf("second client acquired before outer Unlock: %+v", outcome)
	case <-time.After(10 * time.Millisecond):
	}

	if err := outer.Unlock(); err != nil {
		t.Fatalf("outer Unlock: %v", err)
	}
	if outer.Valid() {
		t.Fatal("outer handle is still valid after final Unlock")
	}

	var outcome acquireOutcome
	select {
	case outcome = <-waiting:
	case <-time.After(testTimeout):
		t.Fatal("second client did not acquire after final Unlock")
	}
	if outcome.err != nil {
		t.Fatalf("second Acquire: %v", outcome.err)
	}
	if outcome.handle.Token() <= outer.Token() {
		t.Fatalf("new owner token = %d, want > %d", outcome.handle.Token(), outer.Token())
	}
	if err := outcome.handle.Unlock(); err != nil {
		t.Fatalf("second Unlock: %v", err)
	}
}

func TestConcurrentReentrantAcquireSameClient(t *testing.T) {
	coordinator := formal.NewCoordinator(formal.NewFakeClock())
	t.Cleanup(func() { _ = coordinator.Close() })

	shared := mustClient(t, coordinator, time.Hour)
	other := mustClient(t, coordinator, time.Hour)

	const levels = 8
	handles := make(chan *formal.Handle, levels)
	errs := make(chan error, levels)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < levels; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
			defer cancel()
			handle, err := shared.Acquire(ctx, "shared-reentrant")
			if err != nil {
				errs <- err
				return
			}
			handles <- handle
		}()
	}
	close(start)
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("concurrent reentrant acquisitions deadlocked")
	}
	close(handles)
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent Acquire: %v", err)
	}

	var all []*formal.Handle
	for handle := range handles {
		all = append(all, handle)
	}
	if len(all) != levels {
		t.Fatalf("got %d handles, want %d", len(all), levels)
	}
	token := all[0].Token()
	for _, handle := range all {
		if handle.Token() != token {
			t.Fatalf("reentrant token = %d, want %d", handle.Token(), token)
		}
	}

	for i, handle := range all {
		if err := handle.Unlock(); err != nil {
			t.Fatalf("Unlock %d: %v", i, err)
		}
		if i < len(all)-1 {
			if _, _, ok := coordinator.Holder("shared-reentrant"); !ok {
				t.Fatalf("lock released after only %d of %d Unlocks", i+1, len(all))
			}
		}
	}
	if _, _, ok := coordinator.Holder("shared-reentrant"); ok {
		t.Fatal("lock still held after all Unlocks")
	}

	next := mustAcquire(t, other, "shared-reentrant")
	if next.Token() <= token {
		t.Fatalf("next token = %d, want > %d", next.Token(), token)
	}
	if err := next.Unlock(); err != nil {
		t.Fatal(err)
	}
}

func TestLeaseExpiryPromotesNextAndInvalidatesOldToken(t *testing.T) {
	clock := formal.NewFakeClock()
	coordinator := formal.NewCoordinator(clock)
	t.Cleanup(func() { _ = coordinator.Close() })

	short := mustClient(t, coordinator, 10*time.Second)
	long := mustClient(t, coordinator, time.Minute)

	oldHandle := mustAcquire(t, short, "leased")
	oldToken := oldHandle.Token()
	oldSession := short.Session()
	var fencer formal.Fencer
	if !fencer.Allow(oldToken) {
		t.Fatal("initial token should be accepted")
	}

	waiting := acquireAsync(long, "leased")
	eventually(t, "second client to queue", func() bool {
		return coordinator.QueueLength("leased") == 1
	})

	clock.Advance(10 * time.Second)

	if oldHandle.Valid() {
		t.Fatal("expired handle is still valid")
	}
	if short.Connected() {
		t.Fatal("expired client still reports connected")
	}
	if _, err := short.Acquire(context.Background(), "leased"); !errors.Is(err, formal.ErrDisconnected) {
		t.Fatalf("Acquire after expiry = %v, want ErrDisconnected", err)
	}
	if err := oldHandle.Unlock(); !errors.Is(err, formal.ErrLockLost) {
		t.Fatalf("old Unlock = %v, want ErrLockLost", err)
	}

	var outcome acquireOutcome
	select {
	case outcome = <-waiting:
	case <-time.After(testTimeout):
		t.Fatal("waiting client was not promoted")
	}
	if outcome.err != nil {
		t.Fatalf("promoted Acquire: %v", outcome.err)
	}
	newHandle := outcome.handle
	if newHandle.Token() <= oldToken {
		t.Fatalf("promoted token = %d, want > %d", newHandle.Token(), oldToken)
	}
	if !newHandle.Valid() {
		t.Fatal("promoted handle is not valid")
	}
	if !fencer.Allow(newHandle.Token()) {
		t.Fatalf("new token %d was rejected", newHandle.Token())
	}
	if fencer.Allow(oldToken) {
		t.Fatalf("old token %d became valid again", oldToken)
	}

	if err := short.Reconnect(); err != nil {
		t.Fatalf("Reconnect: %v", err)
	}
	if short.Session() == oldSession {
		t.Fatal("Reconnect reused the old session id")
	}
	other := mustAcquire(t, short, "other")
	if other.Token() <= newHandle.Token() {
		t.Fatalf("token after reconnect = %d, want > %d", other.Token(), newHandle.Token())
	}
	if fencer.Allow(oldToken) {
		t.Fatalf("old token %d became valid after reconnect", oldToken)
	}
	if err := other.Unlock(); err != nil {
		t.Fatal(err)
	}
	if !newHandle.Valid() {
		t.Fatal("disconnected old client affected the current holder")
	}
	if err := newHandle.Unlock(); err != nil {
		t.Fatal(err)
	}
}

func TestConnectionLossBlocksEntryAndRecoveryInvalidatesToken(t *testing.T) {
	coordinator := formal.NewCoordinator(formal.NewFakeClock())
	t.Cleanup(func() { _ = coordinator.Close() })

	first := mustClient(t, coordinator, time.Hour)
	second := mustClient(t, coordinator, time.Hour)

	oldSession := first.Session()
	oldHandle := mustAcquire(t, first, "connection")
	oldToken := oldHandle.Token()

	waiting := acquireAsync(second, "connection")
	eventually(t, "second client to queue", func() bool {
		return coordinator.QueueLength("connection") == 1
	})

	coordinator.Disconnect(oldSession)
	if _, err := first.Acquire(context.Background(), "connection"); !errors.Is(err, formal.ErrDisconnected) {
		t.Fatalf("Acquire while disconnected = %v, want ErrDisconnected", err)
	}
	if oldHandle.Valid() {
		t.Fatal("handle survived connection loss")
	}
	if err := oldHandle.Unlock(); !errors.Is(err, formal.ErrLockLost) {
		t.Fatalf("old Unlock = %v, want ErrLockLost", err)
	}

	var secondOutcome acquireOutcome
	select {
	case secondOutcome = <-waiting:
	case <-time.After(testTimeout):
		t.Fatal("queued client was not promoted after disconnect")
	}
	if secondOutcome.err != nil {
		t.Fatalf("second Acquire: %v", secondOutcome.err)
	}
	if secondOutcome.handle.Token() <= oldToken {
		t.Fatalf("new token = %d, want > %d", secondOutcome.handle.Token(), oldToken)
	}

	if err := coordinator.Release(oldSession, "connection", oldToken); !errors.Is(err, formal.ErrSessionLost) {
		t.Fatalf("release with old session = %v, want ErrSessionLost", err)
	}
	if err := coordinator.Release(second.Session(), "connection", oldToken); !errors.Is(err, formal.ErrStaleToken) {
		t.Fatalf("release with old token = %v, want ErrStaleToken", err)
	}
	if !secondOutcome.handle.Valid() {
		t.Fatal("stale releases disturbed the current owner")
	}

	if err := first.Reconnect(); err != nil {
		t.Fatalf("Reconnect: %v", err)
	}
	if first.Session() == oldSession {
		t.Fatal("Reconnect reused the old session id")
	}
	reacquired := acquireAsync(first, "connection")
	eventually(t, "reconnected client to queue", func() bool {
		return coordinator.QueueLength("connection") == 1
	})
	if err := secondOutcome.handle.Unlock(); err != nil {
		t.Fatal(err)
	}
	var reacquiredOutcome acquireOutcome
	select {
	case reacquiredOutcome = <-reacquired:
	case <-time.After(testTimeout):
		t.Fatal("reconnected client did not acquire")
	}
	if reacquiredOutcome.err != nil {
		t.Fatalf("reconnected Acquire: %v", reacquiredOutcome.err)
	}
	if reacquiredOutcome.handle.Token() <= secondOutcome.handle.Token() {
		t.Fatalf("token after recovery = %d, want > %d",
			reacquiredOutcome.handle.Token(), secondOutcome.handle.Token())
	}

	var fencer formal.Fencer
	if !fencer.Allow(reacquiredOutcome.handle.Token()) {
		t.Fatal("recovered token was rejected")
	}
	if fencer.Allow(secondOutcome.handle.Token()) || fencer.Allow(oldToken) {
		t.Fatal("an older token was accepted after recovery")
	}
	if err := reacquiredOutcome.handle.Unlock(); err != nil {
		t.Fatal(err)
	}
}

type recordingBackend struct {
	formal.Backend

	mu        sync.Mutex
	events    []formal.Event
	duplicate bool
}

func (r *recordingBackend) OpenSession(ttl time.Duration, notify func(formal.Event)) (formal.SessionID, error) {
	return r.Backend.OpenSession(ttl, func(event formal.Event) {
		r.mu.Lock()
		r.events = append(r.events, event)
		r.mu.Unlock()
		notify(event)
		if r.duplicate {
			notify(event)
		}
	})
}

func (r *recordingBackend) snapshot() []formal.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	events := make([]formal.Event, len(r.events))
	copy(events, r.events)
	return events
}

func TestDuplicateCallbacksAreIdempotent(t *testing.T) {
	coordinator := formal.NewCoordinator(formal.NewFakeClock())
	t.Cleanup(func() { _ = coordinator.Close() })
	recorder := &recordingBackend{Backend: coordinator, duplicate: true}

	first := mustClient(t, recorder, time.Hour)
	second := mustClient(t, recorder, time.Hour)

	firstHandle := mustAcquire(t, first, "duplicates")
	firstToken := firstHandle.Token()
	firstSession := first.Session()
	if err := firstHandle.Unlock(); err != nil {
		t.Fatal(err)
	}

	secondHandle := mustAcquire(t, second, "duplicates")
	secondToken := secondHandle.Token()
	if secondToken <= firstToken {
		t.Fatalf("second token = %d, want > %d", secondToken, firstToken)
	}

	nested := mustAcquire(t, second, "duplicates")
	if nested.Token() != secondToken {
		t.Fatalf("nested token = %d, want %d", nested.Token(), secondToken)
	}
	if err := nested.Unlock(); err != nil {
		t.Fatal(err)
	}
	if !secondHandle.Valid() {
		t.Fatal("duplicate grant incorrectly consumed a recursion level")
	}
	if err := secondHandle.Unlock(); err != nil {
		t.Fatal(err)
	}

	thirdHandle := mustAcquire(t, first, "duplicates")
	if thirdHandle.Token() <= secondToken {
		t.Fatalf("third token = %d, want > %d; duplicate callback probably leaked depth",
			thirdHandle.Token(), secondToken)
	}

	// Replay an old grant after ownership moved on. It must be ignored, not
	// recreate a handle or disturb the current owner.
	for _, event := range recorder.snapshot() {
		if event.Type == formal.EventGranted &&
			event.Session == firstSession &&
			event.Token == firstToken {
			first.Deliver(event)
			first.Deliver(event)
			break
		}
	}
	if !thirdHandle.Valid() {
		t.Fatal("stale replayed grant invalidated the current owner")
	}
	if _, token, ok := coordinator.Holder("duplicates"); !ok || token != thirdHandle.Token() {
		t.Fatalf("holder token = %d (present=%v), want %d", token, ok, thirdHandle.Token())
	}

	coordinator.Disconnect(second.Session())
	coordinator.Disconnect(second.Session())
	if second.Connected() {
		t.Fatal("duplicate session-lost callback left client connected")
	}
	if _, err := second.Acquire(context.Background(), "duplicates"); !errors.Is(err, formal.ErrDisconnected) {
		t.Fatalf("Acquire after duplicate disconnect = %v, want ErrDisconnected", err)
	}
	if !thirdHandle.Valid() {
		t.Fatal("disconnecting another session affected the holder")
	}
	if err := thirdHandle.Unlock(); err != nil {
		t.Fatal(err)
	}
}

func TestStaleRevocationAfterReconnectIsIgnored(t *testing.T) {
	coordinator := formal.NewCoordinator(formal.NewFakeClock())
	t.Cleanup(func() { _ = coordinator.Close() })
	recorder := &recordingBackend{Backend: coordinator, duplicate: true}

	client := mustClient(t, recorder, time.Hour)
	oldSession := client.Session()
	oldHandle := mustAcquire(t, client, "stale-revoke")
	oldToken := oldHandle.Token()

	coordinator.Disconnect(oldSession)
	if oldHandle.Valid() {
		t.Fatal("handle survived disconnect")
	}

	var revoked formal.Event
	found := false
	for _, event := range recorder.snapshot() {
		if event.Type == formal.EventRevoked &&
			event.Session == oldSession &&
			event.Token == oldToken {
			revoked = event
			found = true
			break
		}
	}
	if !found {
		t.Fatal("disconnect did not produce a revocation event")
	}

	if err := client.Reconnect(); err != nil {
		t.Fatalf("Reconnect: %v", err)
	}
	current := mustAcquire(t, client, "stale-revoke")
	if current.Token() <= oldToken {
		t.Fatalf("token after reconnect = %d, want > %d", current.Token(), oldToken)
	}

	client.Deliver(revoked)
	client.Deliver(revoked)
	if !current.Valid() {
		t.Fatal("stale revocation invalidated the new ownership")
	}
	if err := current.Unlock(); err != nil {
		t.Fatal(err)
	}
}

func TestCanceledAcquireLeavesQueue(t *testing.T) {
	coordinator := formal.NewCoordinator(formal.NewFakeClock())
	t.Cleanup(func() { _ = coordinator.Close() })

	holder := mustClient(t, coordinator, time.Hour)
	canceled := mustClient(t, coordinator, time.Hour)
	next := mustClient(t, coordinator, time.Hour)

	held := mustAcquire(t, holder, "cancel")
	ctx, cancel := context.WithCancel(context.Background())
	outcome := make(chan acquireOutcome, 1)
	go func() {
		handle, err := canceled.Acquire(ctx, "cancel")
		outcome <- acquireOutcome{handle: handle, err: err}
	}()

	eventually(t, "canceled client to queue", func() bool {
		return coordinator.QueueLength("cancel") == 1
	})
	cancel()

	select {
	case result := <-outcome:
		if !errors.Is(result.err, context.Canceled) {
			t.Fatalf("Acquire error = %v, want context.Canceled", result.err)
		}
		if result.handle != nil {
			t.Fatal("canceled Acquire returned a handle")
		}
	case <-time.After(testTimeout):
		t.Fatal("canceled Acquire did not return")
	}
	eventually(t, "canceled request removal", func() bool {
		return coordinator.QueueLength("cancel") == 0
	})

	if err := held.Unlock(); err != nil {
		t.Fatal(err)
	}
	nextHandle := mustAcquire(t, next, "cancel")
	if nextHandle.Token() <= held.Token() {
		t.Fatalf("next token = %d, want > %d", nextHandle.Token(), held.Token())
	}
	if err := nextHandle.Unlock(); err != nil {
		t.Fatal(err)
	}

	// The canceled client is still usable once it is not waiting.
	again := mustAcquire(t, canceled, "cancel")
	if again.Token() <= nextHandle.Token() {
		t.Fatalf("token after cancel = %d, want > %d", again.Token(), nextHandle.Token())
	}
	if err := again.Unlock(); err != nil {
		t.Fatal(err)
	}
}

func TestKeepAliveExtendsLease(t *testing.T) {
	clock := formal.NewFakeClock()
	coordinator := formal.NewCoordinator(clock)
	t.Cleanup(func() { _ = coordinator.Close() })

	client := mustClient(t, coordinator, 10*time.Second)
	handle := mustAcquire(t, client, "keepalive")

	clock.Advance(9 * time.Second)
	if !handle.Valid() {
		t.Fatal("lock expired before its lease")
	}
	if err := client.KeepAlive(); err != nil {
		t.Fatalf("KeepAlive: %v", err)
	}

	clock.Advance(9 * time.Second)
	if !handle.Valid() {
		t.Fatal("KeepAlive did not extend the lease")
	}

	clock.Advance(2 * time.Second)
	if handle.Valid() {
		t.Fatal("lock survived after the renewed lease expired")
	}
	if client.Connected() {
		t.Fatal("client still connected after lease expiry")
	}
}

type stalledClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *stalledClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *stalledClock) AfterFunc(time.Duration, func()) formal.Timer {
	return stalledTimer{}
}

func (c *stalledClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

type stalledTimer struct{}

func (stalledTimer) Stop() bool { return false }

func TestExpiredLeaseCannotBeRenewedBeforeTimerFires(t *testing.T) {
	clock := &stalledClock{now: time.Unix(0, 0)}
	coordinator := formal.NewCoordinator(clock)
	t.Cleanup(func() { _ = coordinator.Close() })

	events := make(chan formal.Event, 8)
	session, err := coordinator.OpenSession(10*time.Second, func(event formal.Event) {
		events <- event
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.Acquire(session, 1, "lazy-expiry"); err != nil {
		t.Fatal(err)
	}
	nextEvent(t, events) // grant

	clock.Advance(10 * time.Second)
	if err := coordinator.KeepAlive(session); !errors.Is(err, formal.ErrSessionLost) {
		t.Fatalf("KeepAlive after deadline = %v, want ErrSessionLost", err)
	}

	revoked := nextEvent(t, events)
	if revoked.Type != formal.EventRevoked {
		t.Fatalf("first expiry event = %s, want revoked", revoked.Type)
	}
	lost := nextEvent(t, events)
	if lost.Type != formal.EventSessionLost || !errors.Is(lost.Err, formal.ErrLeaseExpired) {
		t.Fatalf("second expiry event = %+v", lost)
	}
	if _, _, ok := coordinator.Holder("lazy-expiry"); ok {
		t.Fatal("expired session still holds the lock")
	}
}

func TestExpiredQueuedHeadDoesNotBlockTail(t *testing.T) {
	clock := formal.NewFakeClock()
	coordinator := formal.NewCoordinator(clock)
	t.Cleanup(func() { _ = coordinator.Close() })

	open := func(name string, ttl time.Duration) (formal.SessionID, <-chan formal.Event) {
		t.Helper()
		events := make(chan formal.Event, 64)
		session, err := coordinator.OpenSession(ttl, func(event formal.Event) {
			events <- event
		})
		if err != nil {
			t.Fatalf("%s OpenSession: %v", name, err)
		}
		return session, events
	}

	holder, holderEvents := open("holder", time.Hour)
	shortHead, headEvents := open("short-head", 10*time.Second)
	tail, tailEvents := open("tail", time.Hour)

	if _, err := coordinator.Acquire(holder, 31, "expiry-head"); err != nil {
		t.Fatal(err)
	}
	holderGrant := nextEvent(t, holderEvents)
	if _, err := coordinator.Acquire(shortHead, 32, "expiry-head"); err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.Acquire(tail, 33, "expiry-head"); err != nil {
		t.Fatal(err)
	}

	clock.Advance(10 * time.Second)
	lost := nextEvent(t, headEvents)
	if lost.Type != formal.EventSessionLost || !errors.Is(lost.Err, formal.ErrLeaseExpired) {
		t.Fatalf("expired head event = %+v", lost)
	}
	if got := coordinator.QueueLength("expiry-head"); got != 1 {
		t.Fatalf("queue length after head expiry = %d, want 1", got)
	}
	if err := coordinator.KeepAlive(shortHead); !errors.Is(err, formal.ErrSessionLost) {
		t.Fatalf("KeepAlive on expired head = %v, want ErrSessionLost", err)
	}

	if err := coordinator.Release(holder, "expiry-head", holderGrant.Token); err != nil {
		t.Fatal(err)
	}
	tailGrant := nextEvent(t, tailEvents)
	if tailGrant.Type != formal.EventGranted {
		t.Fatalf("tail grant = %+v", tailGrant)
	}
	if tailGrant.Token <= holderGrant.Token {
		t.Fatalf("tail token = %d, want > %d", tailGrant.Token, holderGrant.Token)
	}
}

func TestFencerConcurrentUse(t *testing.T) {
	var fencer formal.Fencer
	var accepted int32
	var wg sync.WaitGroup
	for i := 1; i <= 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if fencer.Allow(1) {
				atomic.AddInt32(&accepted, 1)
			}
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt32(&accepted); got != 1 {
		t.Fatalf("accepted %d tokens concurrently, want exactly 1", got)
	}
	if fencer.Allow(1) || fencer.Allow(0) {
		t.Fatal("fencer accepted a replayed or zero token")
	}
	if !fencer.Allow(2) || fencer.Allow(1) || !fencer.Allow(3) {
		t.Fatal("fencer did not enforce strict token ordering")
	}
}
