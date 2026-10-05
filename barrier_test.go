package barrier

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"
)

// awaitAll starts one goroutine per member awaiting the barrier and returns
// a channel that is closed when all of them returned.
func awaitAll(b *Barrier, members ...string) (<-chan error, func()) {
	errs := make(chan error, len(members))
	var wg sync.WaitGroup
	for _, m := range members {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, err := b.Await(context.Background(), id)
			errs <- err
		}(m)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	return errs, func() { <-done }
}

func sorted(s []string) []string {
	out := append([]string(nil), s...)
	sort.Strings(out)
	return out
}

// arriveAsync runs Await in a goroutine for arrivals that are not expected
// to release the round by themselves.
func arriveAsync(b *Barrier, ctx context.Context, id string) <-chan error {
	done := make(chan error, 1)
	go func() {
		_, err := b.Await(ctx, id)
		done <- err
	}()
	return done
}

// TestThreeMemberHistory runs three members through three rounds and
// enumerates the recorded history of every round.
func TestThreeMemberHistory(t *testing.T) {
	members := []string{"alpha", "beta", "gamma"}
	b := New(members...)

	const rounds = 3
	var wg sync.WaitGroup
	for _, m := range members {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			for r := 0; r < rounds; r++ {
				if _, err := b.Await(context.Background(), id); err != nil {
					t.Errorf("member %s round %d: %v", id, r, err)
				}
			}
		}(m)
	}
	wg.Wait()

	history := b.History()
	if len(history) != rounds {
		t.Fatalf("history length = %d, want %d", len(history), rounds)
	}
	// Enumerate the recorded history of the three members.
	for i, rec := range history {
		t.Logf("round %d: arrived=%v exited=%v", rec.Generation, rec.Arrived, rec.Exited)
		if rec.Generation != uint64(i) {
			t.Errorf("record %d: generation = %d, want %d", i, rec.Generation, i)
		}
		if !reflect.DeepEqual(sorted(rec.Arrived), members) {
			t.Errorf("generation %d: arrived = %v, want all of %v", i, rec.Arrived, members)
		}
		if len(rec.Exited) != 0 {
			t.Errorf("generation %d: exited = %v, want none", i, rec.Exited)
		}
	}
	if got := b.Generation(); got != rounds {
		t.Errorf("Generation() = %d, want %d", got, rounds)
	}
}

// TestPermanentExit verifies that an exiting member counts as arrived for the
// current round and that the next round expects one fewer party.
func TestPermanentExit(t *testing.T) {
	b := New("a", "b", "c")

	// Round 0: a and b arrive, c never shows up but exits permanently.
	aDone := arriveAsync(b, context.Background(), "a")
	bDone := arriveAsync(b, context.Background(), "b")
	// Give them a moment to block, then c exits: c counts as arrived for
	// round 0, releasing a and b.
	time.Sleep(20 * time.Millisecond)
	if err := b.Exit("c"); err != nil {
		t.Fatal(err)
	}
	for name, done := range map[string]<-chan error{"a": aDone, "b": bDone} {
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("member %s round 0: %v", name, err)
			}
		case <-time.After(time.Second):
			t.Fatalf("round 0 was not released after c exited (member %s)", name)
		}
	}
	if got := b.Parties(); got != 2 {
		t.Fatalf("Parties() = %d, want 2 after c exited", got)
	}

	// Round 1: only a and b are needed now.
	aDone = arriveAsync(b, context.Background(), "a")
	if _, err := b.Await(context.Background(), "b"); err != nil {
		t.Fatal(err)
	}
	if err := <-aDone; err != nil {
		t.Fatal(err)
	}

	history := b.History()
	if len(history) != 2 {
		t.Fatalf("history length = %d, want 2", len(history))
	}
	if !reflect.DeepEqual(sorted(history[0].Arrived), []string{"a", "b", "c"}) {
		t.Errorf("round 0 arrived = %v, want [a b c]", history[0].Arrived)
	}
	if !reflect.DeepEqual(history[0].Exited, []string{"c"}) {
		t.Errorf("round 0 exited = %v, want [c]", history[0].Exited)
	}
	if !reflect.DeepEqual(sorted(history[1].Arrived), []string{"a", "b"}) {
		t.Errorf("round 1 arrived = %v, want [a b]", history[1].Arrived)
	}
	if err := b.Exit("c"); err != ErrUnknownMember {
		t.Errorf("second Exit(c) = %v, want ErrUnknownMember", err)
	}
}

// TestCancelOnlyUndoesOwnArrival verifies that cancelling a wait undoes only
// that arrival and leaves the barrier usable for the same and later rounds.
func TestCancelOnlyUndoesOwnArrival(t *testing.T) {
	b := New("a", "b", "c")

	aDone := arriveAsync(b, context.Background(), "a")

	ctx, cancel := context.WithCancel(context.Background())
	waitDone := arriveAsync(b, ctx, "b")
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-waitDone; err != context.Canceled {
		t.Fatalf("cancelled Await returned %v, want context.Canceled", err)
	}

	// The barrier must not be broken: b can arrive again and, together
	// with c, complete round 0.
	bDone := arriveAsync(b, context.Background(), "b")
	if _, err := b.Await(context.Background(), "c"); err != nil {
		t.Fatalf("round 0 did not complete after cancel: %v", err)
	}
	for name, done := range map[string]<-chan error{"a": aDone, "b": bDone} {
		if err := <-done; err != nil {
			t.Fatalf("member %s round 0: %v", name, err)
		}
	}

	// Later rounds are unaffected too.
	errs, wait := awaitAll(b, "a", "b", "c")
	wait()
	for i := 0; i < 3; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("round 1: %v", err)
		}
	}

	history := b.History()
	if len(history) != 2 {
		t.Fatalf("history length = %d, want 2", len(history))
	}
	for _, rec := range history {
		if !reflect.DeepEqual(sorted(rec.Arrived), []string{"a", "b", "c"}) {
			t.Errorf("generation %d arrived = %v, want [a b c]", rec.Generation, rec.Arrived)
		}
	}
}

// TestStaleCancelCannotTouchNewRound verifies generation safety: a
// cancellation delivered after its round was released must not remove an
// arrival from the new round.
func TestStaleCancelCannotTouchNewRound(t *testing.T) {
	b := New("a", "b")

	// a waits with a cancellable context; b completes round 0.
	ctx, cancel := context.WithCancel(context.Background())
	aDone := arriveAsync(b, ctx, "a")
	time.Sleep(20 * time.Millisecond)
	if _, err := b.Await(context.Background(), "b"); err != nil {
		t.Fatal(err)
	}
	if err := <-aDone; err != nil {
		t.Fatalf("a should have been released by round 0, got %v", err)
	}

	// a enters round 1, then its old context is cancelled. The stale
	// cancel must not undo a's arrival in round 1.
	aDone = arriveAsync(b, context.Background(), "a")
	time.Sleep(20 * time.Millisecond)
	cancel()
	time.Sleep(20 * time.Millisecond)

	// Round 1 must still complete with b alone.
	if _, err := b.Await(context.Background(), "b"); err != nil {
		t.Fatal(err)
	}
	if err := <-aDone; err != nil {
		t.Fatal(err)
	}
	history := b.History()
	if len(history) != 2 {
		t.Fatalf("history length = %d, want 2", len(history))
	}
	if !reflect.DeepEqual(sorted(history[1].Arrived), []string{"a", "b"}) {
		t.Errorf("round 1 arrived = %v, want [a b]", history[1].Arrived)
	}
}

// TestReleaseOncePerRound hammers the barrier with concurrent members over
// many rounds and checks that every generation is released exactly once.
func TestReleaseOncePerRound(t *testing.T) {
	const members, rounds = 8, 50
	ids := make([]string, members)
	for i := range ids {
		ids[i] = fmt.Sprintf("m%d", i)
	}
	b := New(ids...)

	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			for r := 0; r < rounds; r++ {
				gen, err := b.Await(context.Background(), id)
				if err != nil {
					t.Errorf("member %s round %d: %v", id, r, err)
					return
				}
				if gen != uint64(r) {
					t.Errorf("member %s round %d: participated in generation %d", id, r, gen)
					return
				}
			}
		}(id)
	}
	wg.Wait()

	history := b.History()
	if len(history) != rounds {
		t.Fatalf("history length = %d, want %d (each round released exactly once)", len(history), rounds)
	}
	seen := make(map[uint64]bool)
	for _, rec := range history {
		if seen[rec.Generation] {
			t.Errorf("generation %d released more than once", rec.Generation)
		}
		seen[rec.Generation] = true
		if len(rec.Arrived) != members {
			t.Errorf("generation %d: %d arrivals, want %d", rec.Generation, len(rec.Arrived), members)
		}
	}
}

// TestDuplicateAndUnknown verifies arrival validation.
func TestDuplicateAndUnknown(t *testing.T) {
	b := New("a", "b")
	if _, err := b.Await(context.Background(), "nobody"); err != ErrUnknownMember {
		t.Errorf("Await(nobody) = %v, want ErrUnknownMember", err)
	}
	aDone := arriveAsync(b, context.Background(), "a")
	time.Sleep(20 * time.Millisecond)
	if _, err := b.Await(context.Background(), "a"); err != ErrDuplicateArrival {
		t.Errorf("duplicate Await(a) = %v, want ErrDuplicateArrival", err)
	}
	if err := b.Exit("nobody"); err != ErrUnknownMember {
		t.Errorf("Exit(nobody) = %v, want ErrUnknownMember", err)
	}
	if _, err := b.Await(context.Background(), "b"); err != nil {
		t.Fatal(err)
	}
	if err := <-aDone; err != nil {
		t.Fatal(err)
	}
}
