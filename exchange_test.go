package exchange

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestClaimAtMostK(t *testing.T) {
	e := New()
	for i := 0; i < 5; i++ {
		e.Put(i)
	}
	got := e.Claim(3, 0)
	if len(got) != 3 {
		t.Fatalf("claim k=3 over 5 pending: got %d items, want 3", len(got))
	}
	for i, it := range got {
		if it.ID != i {
			t.Fatalf("FIFO violated: got id %d at position %d", it.ID, i)
		}
	}
	got = e.Claim(10, 0)
	if len(got) != 2 {
		t.Fatalf("claim k=10 over 2 pending: got %d items, want 2", len(got))
	}
	if p, c, x := e.Counts(); p != 0 || c != 5 || x != 0 {
		t.Fatalf("counts = (%d,%d,%d), want (0,5,0)", p, c, x)
	}
}

func TestClaimTimeoutLeavesQueueUnchanged(t *testing.T) {
	e := New()
	e.Put("a")
	e.Claim(1, 0) // drain
	before := e.History()[len(e.History())-1].PendingAfter
	start := time.Now()
	got := e.Claim(2, 30*time.Millisecond)
	if got != nil {
		t.Fatalf("timeout claim returned %v, want nil", got)
	}
	if time.Since(start) < 25*time.Millisecond {
		t.Fatalf("claim returned before timeout elapsed")
	}
	after := e.History()[len(e.History())-1]
	if after.Op != OpClaimTimeout {
		t.Fatalf("last event = %s, want %s", after.Op, OpClaimTimeout)
	}
	if fmt.Sprint(after.PendingAfter) != fmt.Sprint(before) {
		t.Fatalf("timeout changed queue: before %v after %v", before, after.PendingAfter)
	}
}

func TestClaimWaitsForPut(t *testing.T) {
	e := New()
	go func() {
		time.Sleep(20 * time.Millisecond)
		e.Put("late")
	}()
	got := e.Claim(1, 2*time.Second)
	if len(got) != 1 || got[0].Value != "late" {
		t.Fatalf("got %v, want the late put", got)
	}
}

func TestCancelOnlyUnclaimed(t *testing.T) {
	e := New()
	a := e.Put("a")
	b := e.Put("b")
	e.Claim(1, 0) // claims a
	if e.Cancel(a) {
		t.Fatalf("cancelled an already-claimed item")
	}
	if !e.Cancel(b) {
		t.Fatalf("failed to cancel a pending item")
	}
	if p, c, x := e.Counts(); p != 0 || c != 1 || x != 1 {
		t.Fatalf("counts = (%d,%d,%d), want (0,1,1)", p, c, x)
	}
	if e.Cancel(999) {
		t.Fatalf("cancelled a nonexistent item")
	}
}

// checkHistory replays the event log against a model and verifies that every
// recorded PendingAfter snapshot is exactly what the linearized model
// produces, and that batch claims respect their k bound.
func checkHistory(t *testing.T, hist []Event, claimK map[int]int) {
	t.Helper()
	pending := []int{}
	terminal := map[int]State{}
	for i, ev := range hist {
		if ev.Seq != i {
			t.Fatalf("event seq = %d, want %d (gap in linearization)", ev.Seq, i)
		}
		switch ev.Op {
		case OpPut:
			if len(ev.IDs) != 1 {
				t.Fatalf("event %d: put affects %d ids", i, len(ev.IDs))
			}
			pending = append(pending, ev.IDs[0])
		case OpClaim:
			k := claimK[i]
			if len(ev.IDs) == 0 || len(ev.IDs) > k || len(ev.IDs) > len(pending) {
				t.Fatalf("event %d: claim of %d items violates k=%d over pending=%v", i, len(ev.IDs), k, pending)
			}
			if len(ev.IDs) != min(k, len(pending)) {
				t.Fatalf("event %d: claim took %d, want min(%d,%d)", i, len(ev.IDs), k, len(pending))
			}
			for j, id := range ev.IDs {
				if pending[j] != id {
					t.Fatalf("event %d: claim not FIFO prefix of %v", i, pending)
				}
				terminal[id] = Claimed
			}
			pending = pending[len(ev.IDs):]
		case OpClaimTimeout:
			if len(ev.IDs) != 0 {
				t.Fatalf("event %d: timeout claim carried items", i)
			}
		case OpCancel:
			idx := indexOf(pending, ev.IDs[0])
			if idx < 0 {
				t.Fatalf("event %d: cancel of non-pending id %d", i, ev.IDs[0])
			}
			terminal[ev.IDs[0]] = Cancelled
			pending = append(pending[:idx], pending[idx+1:]...)
		case OpCancelMiss:
			if indexOf(pending, ev.IDs[0]) >= 0 {
				t.Fatalf("event %d: cancel-miss of pending id %d", i, ev.IDs[0])
			}
		}
		if fmt.Sprint(ev.PendingAfter) != fmt.Sprint(pending) {
			t.Fatalf("event %d: recorded pending %v, model says %v", i, ev.PendingAfter, pending)
		}
	}
	// Conservation: every item ever put is pending or in exactly one terminal state.
	for id := range terminal {
		if indexOf(pending, id) >= 0 {
			t.Fatalf("item %d both pending and %s", id, terminal[id])
		}
	}
}

func indexOf(s []int, v int) int {
	for i, x := range s {
		if x == v {
			return i
		}
	}
	return -1
}

// TestEnumerationConservation enumerates every operation sequence up to a
// small length and verifies conservation + history consistency for each.
func TestEnumerationConservation(t *testing.T) {
	type op struct {
		kind byte // 'P' put, 'C' claim, 'X' cancel
		arg  int  // k for claim, id for cancel
	}
	alphabet := []op{{'P', 0}, {'C', 1}, {'C', 2}, {'X', 0}, {'X', 1}}
	const maxLen = 6

	seq := make([]op, 0, maxLen)
	checked := 0
	var rec func()
	rec = func() {
		e := New()
		claimK := map[int]int{}
		puts := 0
		for _, o := range seq {
			switch o.kind {
			case 'P':
				e.Put(puts)
				puts++
			case 'C':
				got := e.Claim(o.arg, 0)
				if len(got) > o.arg {
					t.Fatalf("seq %v: claim k=%d returned %d items", seq, o.arg, len(got))
				}
			case 'X':
				e.Cancel(o.arg)
			}
		}
		hist := e.History()
		// Recover the k used by each claim event by replaying the sequence.
		{
			claimIdx := 0
			claims := []int{}
			for _, o := range seq {
				if o.kind == 'C' {
					claims = append(claims, o.arg)
				}
			}
			_ = claimIdx
			n := 0
			for i, ev := range hist {
				if ev.Op == OpClaim || ev.Op == OpClaimTimeout {
					_ = i
					n++
				}
			}
			if n != len(claims) {
				t.Fatalf("seq %v: %d claim events but %d claim ops", seq, n, len(claims))
			}
			n = 0
			for i, ev := range hist {
				if ev.Op == OpClaim {
					claimK[i] = claims[n]
				}
				if ev.Op == OpClaim || ev.Op == OpClaimTimeout {
					n++
				}
			}
		}
		checkHistory(t, hist, claimK)
		p, c, x := e.Counts()
		if p+c+x != puts {
			t.Fatalf("seq %v: conservation broken: puts=%d pending=%d claimed=%d cancelled=%d",
				seq, puts, p, c, x)
		}
		checked++
		if len(seq) < maxLen {
			for _, o := range alphabet {
				seq = append(seq, o)
				rec()
				seq = seq[:len(seq)-1]
			}
		}
	}
	rec()
	t.Logf("enumeration checked %d operation sequences (length 0..%d over %d ops)", checked, maxLen, len(alphabet))
}

// TestConcurrentLinearization races claims, puts, and cancels, then verifies
// the recorded history is a consistent linearization and items are conserved.
func TestConcurrentLinearization(t *testing.T) {
	e := New()
	const items = 200
	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(base int) {
			defer wg.Done()
			for i := 0; i < items/4; i++ {
				e.Put(base*items/4 + i)
			}
		}(w)
	}
	for w := 0; w < 3; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				got := e.Claim(3, 5*time.Millisecond)
				if got == nil {
					return
				}
				time.Sleep(time.Millisecond) // give cancellers a chance to race
			}
		}()
	}
	for w := 0; w < 2; w++ {
		wg.Add(1)
		go func(step int) {
			defer wg.Done()
			for id := step; id < items; id += 2 {
				e.Cancel(id)
			}
		}(w)
	}
	wg.Wait()
	// Drain whatever the cancellers left behind (same k as workers).
	for len(e.Claim(3, 0)) > 0 {
	}

	hist := e.History()
	claimK := map[int]int{}
	for i, ev := range hist {
		if ev.Op == OpClaim {
			claimK[i] = 3
		}
	}
	checkHistory(t, hist, claimK)
	p, c, x := e.Counts()
	if p != 0 || c+x != items {
		t.Fatalf("conservation broken: pending=%d claimed=%d cancelled=%d total=%d", p, c, x, items)
	}
	t.Logf("linearized %d events; claimed=%d cancelled=%d", len(hist), c, x)
}

func TestHistorySnapshot(t *testing.T) {
	e := New()
	e.Put("x")
	e.Put("y")
	e.Claim(1, 0)
	e.Cancel(1)
	e.Claim(1, 5*time.Millisecond)
	t.Logf("state history:\n%s", e.String())
}
