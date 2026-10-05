package statewait

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestWaitReturnsWhenVersionExceeds(t *testing.T) {
	b := New()
	go func() {
		time.Sleep(10 * time.Millisecond)
		b.Update(5)
	}()
	v, err := b.Wait(context.Background(), 3)
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if v <= 3 {
		t.Fatalf("got version %d, want > 3", v)
	}
}

func TestWaitReturnsImmediatelyIfAlreadyAhead(t *testing.T) {
	b := New()
	b.Update(10)
	v, err := b.Wait(context.Background(), 4)
	if err != nil || v != 10 {
		t.Fatalf("got (%d, %v), want (10, nil)", v, err)
	}
}

func TestWaitEqualVersionStillBlocks(t *testing.T) {
	b := New()
	b.Update(7)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := b.Wait(ctx, 7); err != context.DeadlineExceeded {
		t.Fatalf("Wait(7) at version 7 should block, got err=%v", err)
	}
}

func TestSameVersionUpdateDoesNotWake(t *testing.T) {
	b := New()
	b.Update(3)
	done := make(chan error, 1)
	go func() {
		_, err := b.Wait(context.Background(), 3)
		done <- err
	}()
	time.Sleep(10 * time.Millisecond)
	for i := 0; i < 5; i++ {
		b.Update(3) // repeated same-version updates
		b.Update(2) // lower version
	}
	select {
	case err := <-done:
		t.Fatalf("waiter woke on non-advancing update: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	b.Update(4)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("waiter: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("waiter not woken by advancing update")
	}
}

func TestCancelUnblocksWaiter(t *testing.T) {
	b := New()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := b.Wait(ctx, 1)
		done <- err
	}()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("got %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not unblock waiter")
	}
}

// TestCancelUpdateRaceFirstWins hammers the cancel/update race: each
// iteration must return exactly one outcome (success or ctx.Err()),
// never hang and never report a stale version on success.
func TestCancelUpdateRaceFirstWins(t *testing.T) {
	for i := 0; i < 2000; i++ {
		b := New()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			v, err := b.Wait(ctx, 0)
			if err == nil && v < 1 {
				done <- fmt.Errorf("success with stale version %d", v)
				return
			}
			done <- err
		}()
		go cancel()
		go b.Update(1)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("iteration %d: Wait hung on cancel/update race", i)
		}
		cancel()
	}
}

func TestCloseUnblocksWaitersImmediately(t *testing.T) {
	b := New()
	const waiters = 50
	var wg sync.WaitGroup
	errs := make(chan error, waiters)
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := b.Wait(context.Background(), 100)
			errs <- err
		}()
	}
	time.Sleep(20 * time.Millisecond)
	b.Close()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != ErrClosed {
			t.Fatalf("got %v, want ErrClosed", err)
		}
	}
	// Wait after Close exits immediately too.
	if _, err := b.Wait(context.Background(), 0); err != ErrClosed {
		t.Fatalf("post-close Wait: got %v, want ErrClosed", err)
	}
	// Close is idempotent.
	b.Close()
}

// TestBarrierExhaustiveRegistration is the barrier test: for every
// version step, waiters registered both before and after each
// notification must all observe a version greater than their threshold.
func TestBarrierExhaustiveRegistration(t *testing.T) {
	const steps = 200
	const perStep = 8
	b := New()

	var wg sync.WaitGroup
	fail := make(chan string, steps*perStep*2)

	// Waiters registered BEFORE the notifications start.
	for i := 0; i < steps; i++ {
		threshold := uint64(i)
		for j := 0; j < perStep; j++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				v, err := b.Wait(context.Background(), threshold)
				if err != nil {
					fail <- fmt.Sprintf("pre-registered waiter(th=%d): %v", threshold, err)
				} else if v <= threshold {
					fail <- fmt.Sprintf("pre-registered waiter(th=%d): stale version %d", threshold, v)
				}
			}()
		}
	}

	// Waiters registered AFTER each notification, racing the next one.
	stop := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-stop; cancel() }()
	for j := 0; j < perStep; j++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				cur := b.Version()
				v, err := b.Wait(ctx, cur)
				if err != nil {
					if err == context.Canceled {
						return
					}
					fail <- fmt.Sprintf("post-registered waiter(th=%d): %v", cur, err)
					return
				}
				if v <= cur {
					fail <- fmt.Sprintf("post-registered waiter(th=%d): stale version %d", cur, v)
					return
				}
			}
		}()
	}

	for i := 1; i <= steps; i++ {
		b.Update(uint64(i))
	}
	close(stop)
	b.Update(steps + 1) // release any pre-registered waiter still pending

	waitDone := make(chan struct{})
	go func() { wg.Wait(); close(waitDone) }()
	select {
	case <-waitDone:
	case <-time.After(30 * time.Second):
		t.Fatal("barrier test: waiters did not all finish")
	}
	close(fail)
	for msg := range fail {
		t.Error(msg)
	}
	if got := b.Version(); got != steps+1 {
		t.Fatalf("final version %d, want %d", got, steps+1)
	}
}

func TestZeroValueUsable(t *testing.T) {
	var b Barrier
	go func() {
		time.Sleep(5 * time.Millisecond)
		b.Update(1)
	}()
	v, err := b.Wait(context.Background(), 0)
	if err != nil || v != 1 {
		t.Fatalf("zero-value Barrier: got (%d, %v), want (1, nil)", v, err)
	}
}
