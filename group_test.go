package workgroup

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Closing must freeze membership first and then wait for the members
// that were admitted before the freeze.
func TestCloseFreezesThenWaits(t *testing.T) {
	g := NewGraph().Group("g")
	if err := g.Add(); err != nil {
		t.Fatalf("Add before close: %v", err)
	}

	closed := make(chan struct{})
	go func() {
		g.Close()
		close(closed)
	}()

	select {
	case <-closed:
		t.Fatal("Close returned while a member was still active")
	case <-time.After(20 * time.Millisecond):
	}

	// After Close started, the group is frozen: no new members.
	if err := g.Add(); err != ErrFrozen {
		t.Fatalf("Add after freeze = %v, want ErrFrozen", err)
	}

	g.Done()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close did not return after last member exited")
	}
	if !g.Closed() {
		t.Fatal("Closed() = false after Close returned")
	}
}

// Close is idempotent and concurrent-safe.
func TestCloseIdempotent(t *testing.T) {
	g := NewGraph().Group("g")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g.Close()
		}()
	}
	wg.Wait()
	if !g.Closed() {
		t.Fatal("group not closed")
	}
}

// Task creation racing with Close must not lose members: every Add
// that succeeds is observed by Close, so Close only returns after all
// admitted members have exited.
func TestInterleavedAddClose(t *testing.T) {
	for round := 0; round < 50; round++ {
		g := NewGraph().Group("g")
		var added, exited atomic.Int64
		var wg sync.WaitGroup
		stop := make(chan struct{})

		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					if err := g.Add(); err != nil {
						return // frozen: no more members admitted
					}
					added.Add(1)
					g.Done()
					exited.Add(1)
				}
			}()
		}

		time.Sleep(time.Duration(round%5) * time.Millisecond)
		g.Close()
		close(stop)
		wg.Wait()

		if got, want := exited.Load(), added.Load(); got != want {
			t.Fatalf("round %d: Close returned with %d members admitted but only %d exited", round, want, got)
		}
		if err := g.Add(); err != ErrFrozen {
			t.Fatalf("round %d: Add after Close = %v, want ErrFrozen", round, err)
		}
	}
}

// Go runs admitted tasks and reports refusal once frozen.
func TestGo(t *testing.T) {
	g := NewGraph().Group("g")
	var ran atomic.Int64
	for i := 0; i < 10; i++ {
		if err := g.Go(func() { ran.Add(1) }); err != nil {
			t.Fatalf("Go: %v", err)
		}
	}
	g.Close()
	if got := ran.Load(); got != 10 {
		t.Fatalf("ran %d tasks, want 10", got)
	}
	if err := g.Go(func() {}); err != ErrFrozen {
		t.Fatalf("Go after Close = %v, want ErrFrozen", err)
	}
}
