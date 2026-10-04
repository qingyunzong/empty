package ctxlib

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func isDone(c Context) bool {
	select {
	case <-c.Done():
		return true
	default:
		return false
	}
}

func TestDeadlineInheritAndTighten(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	clk := NewVirtualClock(base)

	root, cancelRoot := WithDeadline(Background(), base.Add(10*time.Second), clk)
	defer cancelRoot()

	// Tightens: earlier than parent.
	tight, cancelTight := WithDeadline(root, base.Add(4*time.Second), clk)
	defer cancelTight()
	if d, ok := tight.Deadline(); !ok || !d.Equal(base.Add(4*time.Second)) {
		t.Fatalf("tightening child deadline = %v, %v; want %v", d, ok, base.Add(4*time.Second))
	}

	// Cannot loosen: later than parent keeps parent's deadline.
	loose, cancelLoose := WithDeadline(root, base.Add(time.Minute), clk)
	defer cancelLoose()
	if d, ok := loose.Deadline(); !ok || !d.Equal(base.Add(10*time.Second)) {
		t.Fatalf("loosening child deadline = %v, %v; want inherited %v", d, ok, base.Add(10*time.Second))
	}

	// Grandchild inherits the tightened deadline through the chain.
	grand, cancelGrand := WithDeadline(loose, base.Add(7*time.Second), clk)
	defer cancelGrand()
	if d, ok := grand.Deadline(); !ok || !d.Equal(base.Add(7*time.Second)) {
		t.Fatalf("grandchild deadline = %v, %v; want %v", d, ok, base.Add(7*time.Second))
	}
	grand2, cancelGrand2 := WithDeadline(loose, base.Add(time.Hour), clk)
	defer cancelGrand2()
	if d, ok := grand2.Deadline(); !ok || !d.Equal(base.Add(10*time.Second)) {
		t.Fatalf("grandchild2 deadline = %v, %v; want inherited %v", d, ok, base.Add(10*time.Second))
	}

	// Plain WithCancel child inherits the deadline unchanged.
	plain, cancelPlain := WithCancel(root)
	defer cancelPlain()
	if d, ok := plain.Deadline(); !ok || !d.Equal(base.Add(10*time.Second)) {
		t.Fatalf("WithCancel child deadline = %v, %v; want inherited %v", d, ok, base.Add(10*time.Second))
	}

	if _, ok := Background().Deadline(); ok {
		t.Fatal("Background must not report a deadline")
	}
}

func TestParentCancelPropagatesOnce(t *testing.T) {
	root, cancelRoot := WithCancel(Background())
	var nodes []Context
	var counts []int32
	add := func(parent Context) Context {
		c, _ := WithCancel(parent)
		idx := len(nodes)
		nodes = append(nodes, c)
		counts = append(counts, 0)
		c.AfterFunc(func() { atomic.AddInt32(&counts[idx], 1) })
		return c
	}
	a := add(root)
	b := add(root)
	c1 := add(a)
	add(b)
	add(c1)

	cancelRoot()
	cancelRoot() // idempotent: must not double-fire anything

	for i, n := range nodes {
		if !isDone(n) {
			t.Fatalf("node %d not done after root cancel", i)
		}
		if got := atomic.LoadInt32(&counts[i]); got != 1 {
			t.Fatalf("node %d callback fired %d times, want exactly 1", i, got)
		}
		if n.Err() != Canceled {
			t.Fatalf("node %d err = %v, want Canceled", i, n.Err())
		}
	}
}

func TestChildCancelLeavesSiblingsAndParent(t *testing.T) {
	root, cancelRoot := WithCancel(Background())
	defer cancelRoot()
	a, cancelA := WithCancel(root)
	b, _ := WithCancel(root)
	a1, _ := WithCancel(a)
	b1, _ := WithCancel(b)

	cancelA()

	if !isDone(a) || !isDone(a1) {
		t.Fatal("cancelled subtree must be done")
	}
	for _, s := range []struct {
		name string
		ctx  Context
	}{{"root", root}, {"sibling", b}, {"sibling child", b1}} {
		if isDone(s.ctx) {
			t.Fatalf("%s must survive sibling cancellation", s.name)
		}
		if s.ctx.Err() != nil {
			t.Fatalf("%s err = %v, want nil", s.name, s.ctx.Err())
		}
	}
}

func TestAfterFuncStopAndLateRegistration(t *testing.T) {
	ctx, cancel := WithCancel(Background())

	fired := 0
	stop := ctx.AfterFunc(func() { fired++ })
	if !stop() {
		t.Fatal("stop before cancel must report true")
	}
	if stop() {
		t.Fatal("second stop must report false")
	}
	cancel()
	if fired != 0 {
		t.Fatal("stopped callback must not run")
	}

	// Registration after cancellation runs immediately, exactly once.
	late := 0
	lateStop := ctx.AfterFunc(func() { late++ })
	if late != 1 {
		t.Fatalf("late-registered callback ran %d times, want 1", late)
	}
	if lateStop() {
		t.Fatal("stop after the callback ran must report false")
	}
}

func TestAfterFuncRacesCancel(t *testing.T) {
	for i := 0; i < 2000; i++ {
		ctx, cancel := WithCancel(Background())
		var fired int32
		var stop func() bool
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); cancel() }()
		go func() { defer wg.Done(); stop = ctx.AfterFunc(func() { atomic.AddInt32(&fired, 1) }) }()
		wg.Wait()
		stopped := stop()
		n := atomic.LoadInt32(&fired)
		if stopped && n != 0 {
			t.Fatalf("iter %d: stop removed callback yet it fired %d times", i, n)
		}
		if !stopped && n != 1 {
			t.Fatalf("iter %d: callback lost: stop=false but fired %d times", i, n)
		}
	}
}

func TestRealClockTimeout(t *testing.T) {
	ctx, cancel := WithTimeout(Background(), 10*time.Millisecond, nil)
	defer cancel()
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("timeout did not fire")
	}
	if ctx.Err() != DeadlineExceeded {
		t.Fatalf("err = %v, want DeadlineExceeded", ctx.Err())
	}
}

// treeSpec describes a fixed six-node tree used by the exhaustive test.
//
//	n0 (no deadline)
//	├── n1 (dl +10s)
//	│   ├── n3 (no own deadline)
//	│   └── n4 (dl +5s, tightens)
//	└── n2 (dl +20s)
//	    └── n5 (dl +30s, cannot loosen)
func buildTree(clk *VirtualClock, base time.Time) ([]Context, []CancelFunc) {
	ctxs := make([]Context, 6)
	cancels := make([]CancelFunc, 6)
	var d time.Duration
	_ = d
	ctxs[0], cancels[0] = WithCancel(Background())
	ctxs[1], cancels[1] = WithDeadline(ctxs[0], base.Add(10*time.Second), clk)
	ctxs[2], cancels[2] = WithDeadline(ctxs[0], base.Add(20*time.Second), clk)
	ctxs[3], cancels[3] = WithCancel(ctxs[1])
	ctxs[4], cancels[4] = WithDeadline(ctxs[1], base.Add(5*time.Second), clk)
	ctxs[5], cancels[5] = WithDeadline(ctxs[2], base.Add(30*time.Second), clk)
	return ctxs, cancels
}

var treeParent = []int{-1, 0, 0, 1, 1, 2}

func TestExhaustiveTreeCancelRelease(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	end := base.Add(100 * time.Second)

	// Expected effective deadlines: earliest on the path to the root.
	wantEff := map[int]time.Time{
		1: base.Add(10 * time.Second),
		2: base.Add(20 * time.Second),
		3: base.Add(10 * time.Second),
		4: base.Add(5 * time.Second),
		5: base.Add(20 * time.Second),
	}

	// Cancel funcs of nodes 0..3 are exercised; every subset and every
	// permutation of each subset is applied before time advances.
	cancelable := []int{0, 1, 2, 3}
	scenarios := 0
	for mask := 0; mask < 1<<len(cancelable); mask++ {
		var subset []int
		for i, id := range cancelable {
			if mask&(1<<i) != 0 {
				subset = append(subset, id)
			}
		}
		permute(subset, func(perm []int) {
			scenarios++
			runScenario(t, base, end, wantEff, perm)
		})
	}
	t.Logf("exhausted %d cancel scenarios", scenarios)
}

func permute(s []int, f func([]int)) {
	if len(s) == 0 {
		f(s)
		return
	}
	var rec func(k int)
	rec = func(k int) {
		if k == len(s) {
			f(s)
			return
		}
		for i := k; i < len(s); i++ {
			s[k], s[i] = s[i], s[k]
			rec(k + 1)
			s[k], s[i] = s[i], s[k]
		}
	}
	rec(0)
}

func runScenario(t *testing.T, base, end time.Time, wantEff map[int]time.Time, perm []int) {
	t.Helper()
	name := fmt.Sprintf("cancel order %v", perm)
	clk := NewVirtualClock(base)
	ctxs, cancels := buildTree(clk, base)

	// Earliest-deadline check before any cancellation.
	for id, want := range wantEff {
		if got, ok := ctxs[id].Deadline(); !ok || !got.Equal(want) {
			t.Fatalf("%s: node %d deadline = %v,%v want %v", name, id, got, ok, want)
		}
	}
	if _, ok := ctxs[0].Deadline(); ok {
		t.Fatalf("%s: root must have no deadline", name)
	}

	fired := make([]int, len(ctxs))
	for i, c := range ctxs {
		i := i
		c.AfterFunc(func() { fired[i]++ })
	}

	// Apply cancellations; each cancel func is invoked twice to prove
	// idempotence (propagation happens exactly once).
	for _, id := range perm {
		cancels[id]()
		cancels[id]()
	}

	// Let every deadline expire.
	clk.AdvanceTo(end)

	cancelled := make(map[int]bool, len(perm))
	for _, id := range perm {
		cancelled[id] = true
	}

	for i, c := range ctxs {
		// Done iff some ancestor (or self) was cancelled, or the effective
		// deadline passed.
		wantDone := false
		cancelledByAncestor := false
		for j := i; j >= 0; j = treeParent[j] {
			if cancelled[j] {
				wantDone, cancelledByAncestor = true, true
				break
			}
		}
		if !wantDone {
			if eff, ok := ctxs[i].Deadline(); ok && !eff.After(end) {
				wantDone = true
			}
		}

		if got := isDone(c); got != wantDone {
			t.Fatalf("%s: node %d done=%v want %v", name, i, got, wantDone)
		}
		if want := 1; wantDone && fired[i] != want {
			t.Fatalf("%s: node %d callback fired %d times, want exactly 1", name, i, fired[i])
		}
		if !wantDone && fired[i] != 0 {
			t.Fatalf("%s: node %d live but callback fired %d times", name, i, fired[i])
		}
		switch err := c.Err(); {
		case !wantDone && err != nil:
			t.Fatalf("%s: node %d err=%v, want nil", name, i, err)
		case wantDone && cancelledByAncestor && err != Canceled:
			t.Fatalf("%s: node %d err=%v, want Canceled", name, i, err)
		case wantDone && !cancelledByAncestor && err != DeadlineExceeded:
			t.Fatalf("%s: node %d err=%v, want DeadlineExceeded", name, i, err)
		}
	}

	// Release check: every non-root node ended (all deadlines < end), so it
	// must have detached from its parent and disarmed its timer.
	for i, c := range ctxs {
		n := c.(*node)
		n.mu.Lock()
		kids := len(n.children)
		timer := n.timer
		n.mu.Unlock()
		if kids != 0 {
			t.Fatalf("%s: node %d still holds %d children after release", name, i, kids)
		}
		if timer != nil {
			t.Fatalf("%s: node %d timer not released", name, i)
		}
	}
	// Releasing the root (possibly after its deadline already fired) must
	// detach it from background, leaving no residue for the next scenario.
	cancels[0]()
	background.mu.Lock()
	bgKids := len(background.children)
	background.mu.Unlock()
	if bgKids != 0 {
		t.Fatalf("%s: background holds %d children after root release, want 0", name, bgKids)
	}
}
