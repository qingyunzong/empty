package rwlock

import (
	"context"
	"testing"
	"time"
)

const (
	grantTimeout = 2 * time.Second
	blockTimeout = 100 * time.Millisecond
)

// waitAcquired blocks until ch signals a grant, failing the test on timeout.
func waitAcquired(t *testing.T, ch <-chan struct{}, who string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(grantTimeout):
		t.Fatalf("%s was not granted within %s", who, grantTimeout)
	}
}

// assertBlocked fails the test if ch signals a grant within blockTimeout.
func assertBlocked(t *testing.T, ch <-chan struct{}, who string) {
	t.Helper()
	select {
	case <-ch:
		t.Fatalf("%s was granted but should still be blocked", who)
	case <-time.After(blockTimeout):
	}
}

// waitQueued blocks until the lock has exactly n queued waiters.
func waitQueued(t *testing.T, l *RWLock, n int) {
	t.Helper()
	deadline := time.Now().Add(grantTimeout)
	for l.queued() != n {
		if time.Now().After(deadline) {
			t.Fatalf("queued = %d, want %d", l.queued(), n)
		}
		time.Sleep(time.Millisecond)
	}
}

// acquireAsync starts a goroutine acquiring with the given function and
// returns a channel that closes once the acquisition completes.
func acquireAsync(fn func() error) (<-chan struct{}, <-chan error) {
	done := make(chan struct{})
	errc := make(chan error, 1)
	go func() {
		errc <- fn()
		close(done)
	}()
	return done, errc
}

func TestDowngradeRetainsReadToken(t *testing.T) {
	var l RWLock
	l.Lock()
	if !l.Downgrade() {
		t.Fatal("Downgrade returned false while holding exclusive lock")
	}

	// After downgrade the lock is shared: another reader is granted.
	rDone, _ := acquireAsync(func() error { l.RLock(); return nil })
	waitAcquired(t, rDone, "queued reader after downgrade")

	// The downgrader's retained read token still blocks a writer.
	wDone, _ := acquireAsync(func() error { l.Lock(); return nil })
	assertBlocked(t, wDone, "writer while downgraded token retained")

	// Releasing the retained token alone is not enough: the second
	// reader still holds a token.
	if !l.RUnlock() {
		t.Fatal("RUnlock of retained token returned false")
	}
	assertBlocked(t, wDone, "writer while other reader holds token")

	l.RUnlock() // release the second reader
	waitAcquired(t, wDone, "writer after all read tokens released")
	l.Unlock()
}

func TestDowngradeBatchGrantsQueuedReaders(t *testing.T) {
	var l RWLock
	l.Lock()

	r1, _ := acquireAsync(func() error { l.RLock(); return nil })
	waitQueued(t, &l, 1)
	r2, _ := acquireAsync(func() error { l.RLock(); return nil })
	waitQueued(t, &l, 2)
	w1, _ := acquireAsync(func() error { l.Lock(); return nil })
	waitQueued(t, &l, 3)

	// Downgrading releases exclusivity, so the readers queued before the
	// writer are granted as a batch while the writer keeps waiting.
	l.Downgrade()
	waitAcquired(t, r1, "reader 1 queued before writer")
	waitAcquired(t, r2, "reader 2 queued before writer")
	assertBlocked(t, w1, "writer queued behind readers")

	l.RUnlock() // retained token
	l.RUnlock() // r1
	assertBlocked(t, w1, "writer while reader 2 holds token")
	l.RUnlock() // r2
	waitAcquired(t, w1, "writer after readers drain")
	l.Unlock()
}

func TestGrantOrderReadersCannotBypassWriter(t *testing.T) {
	var l RWLock
	l.Lock()

	// Enqueue in deterministic order: R1, R2, W, R3.
	r1, _ := acquireAsync(func() error { l.RLock(); return nil })
	waitQueued(t, &l, 1)
	r2, _ := acquireAsync(func() error { l.RLock(); return nil })
	waitQueued(t, &l, 2)
	w, _ := acquireAsync(func() error { l.Lock(); return nil })
	waitQueued(t, &l, 3)
	r3, _ := acquireAsync(func() error { l.RLock(); return nil })
	waitQueued(t, &l, 4)

	l.Unlock()

	// Readers queued before the writer are granted as a batch.
	waitAcquired(t, r1, "reader 1")
	waitAcquired(t, r2, "reader 2")
	// The writer and the reader queued behind it stay blocked.
	assertBlocked(t, w, "writer behind batch readers")
	assertBlocked(t, r3, "reader 3 must not bypass writer")

	l.RUnlock() // r1
	assertBlocked(t, w, "writer while reader 2 holds token")
	l.RUnlock() // r2
	waitAcquired(t, w, "writer after readers drain")
	assertBlocked(t, r3, "reader 3 while writer holds lock")

	l.Unlock()
	waitAcquired(t, r3, "reader 3 after writer releases")
	l.RUnlock()

	if got := l.queued(); got != 0 {
		t.Fatalf("queue not drained, %d waiters left", got)
	}
}

func TestCancelHeadAdvancesQueue(t *testing.T) {
	var l RWLock
	l.RLock() // hold a read token so writers queue up

	ctx, cancel := context.WithCancel(context.Background())
	wDone, wErr := acquireAsync(func() error { return l.LockContext(ctx) })
	waitQueued(t, &l, 1)

	rDone, _ := acquireAsync(func() error { l.RLock(); return nil })
	waitQueued(t, &l, 2)
	// The reader is queued behind the writer and must not bypass it.
	assertBlocked(t, rDone, "reader queued behind writer")

	// Canceling the head writer promptly advances the queue: the reader
	// behind it becomes grantable because a read token is already held.
	cancel()
	if err := <-wErr; err != context.Canceled {
		t.Fatalf("canceled writer got err = %v, want context.Canceled", err)
	}
	<-wDone
	waitAcquired(t, rDone, "reader behind canceled head")

	l.RUnlock()
	l.RUnlock()
	if got := l.queued(); got != 0 {
		t.Fatalf("queue not drained, %d waiters left", got)
	}
}

func TestCancelHeadWriterUnblocksNextWriter(t *testing.T) {
	var l RWLock
	l.Lock()

	ctx, cancel := context.WithCancel(context.Background())
	w1Done, w1Err := acquireAsync(func() error { return l.LockContext(ctx) })
	waitQueued(t, &l, 1)
	w2Done, _ := acquireAsync(func() error { l.Lock(); return nil })
	waitQueued(t, &l, 2)

	cancel()
	if err := <-w1Err; err != context.Canceled {
		t.Fatalf("canceled writer got err = %v, want context.Canceled", err)
	}
	<-w1Done
	waitQueued(t, &l, 1)

	l.Unlock()
	waitAcquired(t, w2Done, "writer behind canceled head")
	l.Unlock()
}

func TestCancelNonHeadDoesNotDisturbOrder(t *testing.T) {
	var l RWLock
	l.Lock()

	w1, _ := acquireAsync(func() error { l.Lock(); return nil })
	waitQueued(t, &l, 1)
	ctx, cancel := context.WithCancel(context.Background())
	r1Done, r1Err := acquireAsync(func() error { return l.RLockContext(ctx) })
	waitQueued(t, &l, 2)
	r2, _ := acquireAsync(func() error { l.RLock(); return nil })
	waitQueued(t, &l, 3)

	// Canceling a non-head waiter leaves the rest of the queue intact.
	cancel()
	if err := <-r1Err; err != context.Canceled {
		t.Fatalf("canceled reader got err = %v, want context.Canceled", err)
	}
	<-r1Done
	waitQueued(t, &l, 2)

	l.Unlock()
	waitAcquired(t, w1, "head writer")
	assertBlocked(t, r2, "reader behind writer")
	l.Unlock()
	waitAcquired(t, r2, "reader after writer releases")
	l.RUnlock()
}

func TestDoubleReleaseDoesNotChangeState(t *testing.T) {
	var l RWLock

	// Repeated exclusive release.
	l.Lock()
	if !l.Unlock() {
		t.Fatal("first Unlock returned false")
	}
	if l.Unlock() {
		t.Fatal("repeated Unlock returned true")
	}
	if l.Unlock() {
		t.Fatal("third Unlock returned true")
	}

	// Repeated shared release.
	if l.RUnlock() {
		t.Fatal("RUnlock without tokens returned true")
	}
	l.RLock()
	if !l.RUnlock() {
		t.Fatal("first RUnlock returned false")
	}
	if l.RUnlock() {
		t.Fatal("repeated RUnlock returned true")
	}

	// Downgrade without an exclusive hold is a no-op.
	if l.Downgrade() {
		t.Fatal("Downgrade without hold returned true")
	}

	// State must be pristine: a fresh writer acquires immediately and
	// the internals show no residual holds or waiters.
	done, _ := acquireAsync(func() error { l.Lock(); return nil })
	waitAcquired(t, done, "writer after spurious releases")
	l.Unlock()

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.writer || l.readers != 0 || len(l.queue) != 0 {
		t.Fatalf("state changed by repeated release: writer=%v readers=%d queued=%d",
			l.writer, l.readers, len(l.queue))
	}
}
