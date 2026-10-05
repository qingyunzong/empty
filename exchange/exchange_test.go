package exchange

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// checkConservation verifies that every produced item exists in exactly one
// of three states (queued, claimed, cancelled) and nowhere else.
func checkConservation(t *testing.T, e *Exchange, produced map[string]bool) {
	t.Helper()
	where := make(map[string]string)
	for _, it := range e.Snapshot() {
		if prev, dup := where[it.ID]; dup {
			t.Fatalf("item %q in queue and %s", it.ID, prev)
		}
		where[it.ID] = "queue"
	}
	for id := range e.Claimed() {
		if prev, dup := where[id]; dup {
			t.Fatalf("item %q in claimed and %s", id, prev)
		}
		where[id] = "claimed"
	}
	for id := range e.Cancelled() {
		if prev, dup := where[id]; dup {
			t.Fatalf("item %q in cancelled and %s", id, prev)
		}
		where[id] = "cancelled"
	}
	for id := range produced {
		if _, ok := where[id]; !ok {
			t.Fatalf("produced item %q lost: not in queue/claimed/cancelled", id)
		}
	}
	for id := range where {
		if !produced[id] {
			t.Fatalf("item %q materialized in %s without being produced", id, where[id])
		}
	}
}

func TestClaimTakesUpToK(t *testing.T) {
	e := New()
	for i := 0; i < 5; i++ {
		e.Produce(Item{ID: fmt.Sprintf("it%d", i)})
	}
	got, err := e.Claim(context.Background(), 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].ID != "it0" || got[2].ID != "it2" {
		t.Fatalf("expected FIFO batch of 3, got %v", got)
	}
	if n := len(e.Snapshot()); n != 2 {
		t.Fatalf("expected 2 left, got %d", n)
	}
	got, err = e.Claim(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("expected partial batch of 2, got %d", len(got))
	}
	if n := len(e.Snapshot()); n != 0 {
		t.Fatalf("expected empty queue, got %d", n)
	}
}

func TestClaimTimeoutLeavesQueueUnchanged(t *testing.T) {
	e := New()
	before := len(e.History())
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	got, err := e.Claim(ctx, 4)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if got != nil {
		t.Fatalf("expected no items, got %v", got)
	}
	if n := len(e.Snapshot()); n != 0 {
		t.Fatalf("queue changed on timeout: %d items", n)
	}
	hist := e.History()
	if len(hist) != before+1 || hist[len(hist)-1].Kind != EventClaimTimeout {
		t.Fatalf("expected exactly one claim-timeout event, got %v", hist[before:])
	}
	// Queue still accepts items afterwards.
	e.Produce(Item{ID: "late"})
	got, err = e.Claim(context.Background(), 1)
	if err != nil || len(got) != 1 || got[0].ID != "late" {
		t.Fatalf("claim after timeout failed: %v %v", got, err)
	}
}

func TestCancelOnlyWithdrawsUnclaimed(t *testing.T) {
	e := New()
	e.Produce(Item{ID: "a"})
	e.Produce(Item{ID: "b"})
	if _, err := e.Claim(context.Background(), 1); err != nil { // claims "a"
		t.Fatal(err)
	}
	if e.Cancel("a") {
		t.Fatal("cancelled an already-claimed item")
	}
	if !e.Cancel("b") {
		t.Fatal("failed to cancel an unclaimed item")
	}
	if e.Cancel("b") {
		t.Fatal("cancelled the same item twice")
	}
	if e.Cancel("ghost") {
		t.Fatal("cancelled a nonexistent item")
	}
	if n := len(e.Snapshot()); n != 0 {
		t.Fatalf("expected empty queue, got %d", n)
	}
	if len(e.Claimed()) != 1 || len(e.Cancelled()) != 1 {
		t.Fatalf("claimed=%d cancelled=%d, want 1/1", len(e.Claimed()), len(e.Cancelled()))
	}
}

func TestHistoryOutput(t *testing.T) {
	e := New()
	e.Produce(Item{ID: "x"})
	e.Produce(Item{ID: "y"})
	if _, err := e.Claim(context.Background(), 2); err != nil {
		t.Fatal(err)
	}
	e.Cancel("x") // miss: already claimed
	var sb strings.Builder
	e.DumpHistory(&sb)
	out := sb.String()
	t.Logf("state history:\n%s", out)
	for _, want := range []string{"produce", "claim", "cancel-miss"} {
		if !strings.Contains(out, want) {
			t.Fatalf("history missing %q:\n%s", want, out)
		}
	}
	hist := e.History()
	for i, ev := range hist {
		if ev.Seq != i {
			t.Fatalf("history sequence broken at %d: %+v", i, ev)
		}
	}
	if hist[1].QueueLen != 2 || hist[2].QueueLen != 0 {
		t.Fatalf("queue-length tracking wrong: %+v", hist)
	}
}

// op is one scripted action in the enumeration test.
type op struct {
	desc     string
	produces string            // item ID this op adds to the produced set, if any
	run      func(e *Exchange) // must be non-blocking
}

// TestConservationEnumeration exhaustively enumerates every ordering of a
// small script of produces, batch claims and cancels, and checks the
// conservation invariant after every single step of every ordering.
func TestConservationEnumeration(t *testing.T) {
	ops := []op{
		{"produce x", "x", func(e *Exchange) { e.Produce(Item{ID: "x"}) }},
		{"produce y", "y", func(e *Exchange) { e.Produce(Item{ID: "y"}) }},
		{"produce z", "z", func(e *Exchange) { e.Produce(Item{ID: "z"}) }},
		{"claim k=1", "", func(e *Exchange) { claimNowait(e, 1) }},
		{"claim k=2", "", func(e *Exchange) { claimNowait(e, 2) }},
		{"cancel x", "", func(e *Exchange) { e.Cancel("x") }},
		{"cancel y", "", func(e *Exchange) { e.Cancel("y") }},
		{"cancel z", "", func(e *Exchange) { e.Cancel("z") }},
	}

	permutations(ops, func(order []op) {
		e := New()
		produced := make(map[string]bool)
		for _, o := range order {
			o.run(e)
			if o.produces != "" {
				produced[o.produces] = true
			}
			checkConservation(t, e, produced)
		}
		// Every claim batch must respect its k; re-verify from history.
		for _, ev := range e.History() {
			if ev.Kind == EventClaim && len(ev.ItemIDs) > ev.K {
				t.Fatalf("claim batch %v exceeds k=%d in order %v", ev.ItemIDs, ev.K, describe(order))
			}
		}
	})
	t.Logf("verified conservation across all %d orderings of %d operations", factorial(len(ops)), len(ops))
}

// claimNowait claims with an already-expired context so it never blocks:
// it either takes a batch immediately or records a timeout.
func claimNowait(e *Exchange, k int) {
	ctx, cancel := context.WithCancel(context.Background())
	if len(e.Snapshot()) == 0 {
		cancel() // force the timeout path on an empty queue
	}
	defer cancel()
	e.Claim(ctx, k)
}

func permutations(ops []op, fn func([]op)) {
	var rec func(int)
	rec = func(i int) {
		if i == len(ops) {
			fn(ops)
			return
		}
		for j := i; j < len(ops); j++ {
			ops[i], ops[j] = ops[j], ops[i]
			rec(i + 1)
			ops[i], ops[j] = ops[j], ops[i]
		}
	}
	rec(0)
}

func describe(ops []op) []string {
	out := make([]string, len(ops))
	for i, o := range ops {
		out[i] = o.desc
	}
	return out
}

func factorial(n int) int {
	f := 1
	for i := 2; i <= n; i++ {
		f *= i
	}
	return f
}

// TestConcurrentClaimCancelLinearize races batch claims against cancels on
// the same items. Because each operation linearizes as a whole, every item
// must end up in exactly one final state and no batch may exceed its k.
func TestConcurrentClaimCancelLinearize(t *testing.T) {
	for round := 0; round < 50; round++ {
		e := New()
		const n = 20
		produced := make(map[string]bool, n)
		var prodWg sync.WaitGroup
		for i := 0; i < n; i++ {
			id := fmt.Sprintf("r%d-i%d", round, i)
			produced[id] = true
			prodWg.Add(1)
			go func(id string) {
				defer prodWg.Done()
				e.Produce(Item{ID: id})
			}(id)
		}
		ctx, stop := context.WithCancel(context.Background())
		batches := make(chan []Item, 64)
		var consWg sync.WaitGroup
		for w := 0; w < 4; w++ {
			consWg.Add(1)
			go func(k int) {
				defer consWg.Done()
				for {
					items, err := e.Claim(ctx, k)
					if err != nil {
						return
					}
					if len(items) > k {
						t.Errorf("batch of %d exceeds k=%d", len(items), k)
						return
					}
					batches <- items
				}
			}(w + 1)
		}
		for i := 0; i < n; i++ {
			prodWg.Add(1)
			go func(i int) {
				defer prodWg.Done()
				e.Cancel(fmt.Sprintf("r%d-i%d", round, i))
			}(i)
		}
		prodWg.Wait()
		// No more produces: once the queue drains, release the consumers.
		for len(e.Snapshot()) != 0 {
			time.Sleep(time.Millisecond)
		}
		stop()
		consWg.Wait()
		close(batches)
		seen := make(map[string]bool)
		for b := range batches {
			for _, it := range b {
				if seen[it.ID] {
					t.Fatalf("item %q claimed twice", it.ID)
				}
				seen[it.ID] = true
			}
		}
		checkConservation(t, e, produced)
		if len(e.Claimed()) != len(seen) {
			t.Fatalf("claimed map has %d, batches delivered %d", len(e.Claimed()), len(seen))
		}
	}
}
