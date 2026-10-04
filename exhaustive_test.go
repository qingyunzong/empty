package opctx

import (
	"testing"
	"time"
)

// Exhaustive verification over virtual time: enumerate every tree shape
// with n nodes, every per-node deadline assignment, and every single
// cancel/release action at two distinct virtual times, then check the
// resulting state of every node against an independent model.
//
// Invariants checked per scenario:
//   - Deadline() equals the earliest deadline on the node's ancestor chain.
//   - Parent cancel/timeout propagates to the whole subtree exactly once.
//   - Child cancel/release never affects siblings or ancestors.
//   - Every OnCancel callback fires exactly once iff its node is canceled,
//     and zero times otherwise (released nodes drop theirs silently).
//   - Done is closed iff the node is canceled.
//   - After releasing the whole tree, no timers remain on the clock.

const exhN = 4

var exhDeadline = map[int]time.Duration{1: 10 * time.Second, 2: 20 * time.Second}

const (
	actNone = iota
	actCancel
	actRelease
)

type exhAction struct {
	kind int
	node int
	at   time.Duration
}

func exhActions() []exhAction {
	acts := []exhAction{{kind: actNone}}
	for node := 0; node < exhN; node++ {
		for _, at := range []time.Duration{5 * time.Second, 15 * time.Second} {
			acts = append(acts,
				exhAction{kind: actCancel, node: node, at: at},
				exhAction{kind: actRelease, node: node, at: at},
			)
		}
	}
	return acts
}

func TestExhaustiveTreeCancelAndRelease(t *testing.T) {
	parent := make([]int, exhN)
	dl := make([]int, exhN)
	scenarios := 0
	forEachTree(parent, 0, func() {
		forEachDeadline(dl, 0, func() {
			for _, act := range exhActions() {
				runScenario(t, parent, dl, act)
				scenarios++
			}
		})
	})
	t.Logf("verified %d tree/cancel/release scenarios", scenarios)
}

// forEachTree enumerates rooted trees: node 0 is the root, node i's parent
// is any earlier node.
func forEachTree(parent []int, i int, fn func()) {
	if i == len(parent) {
		fn()
		return
	}
	if i == 0 {
		parent[0] = -1
		forEachTree(parent, 1, fn)
		return
	}
	for p := 0; p < i; p++ {
		parent[i] = p
		forEachTree(parent, i+1, fn)
	}
}

// forEachDeadline enumerates deadline assignments: 0 = none, 1 = +10s,
// 2 = +20s.
func forEachDeadline(dl []int, i int, fn func()) {
	if i == len(dl) {
		fn()
		return
	}
	for d := 0; d <= 2; d++ {
		dl[i] = d
		forEachDeadline(dl, i+1, fn)
	}
}

func runScenario(t *testing.T, parent []int, dl []int, act exhAction) {
	t.Helper()
	clk := NewVirtualClock(t0)
	root := BackgroundWithClock(clk)

	ctxs := make([]Context, exhN)
	cancels := make([]CancelFunc, exhN)
	for i := 0; i < exhN; i++ {
		p := root
		if parent[i] >= 0 {
			p = ctxs[parent[i]]
		}
		if dl[i] == 0 {
			ctxs[i], cancels[i] = WithCancel(p)
		} else {
			ctxs[i], cancels[i] = WithDeadline(p, t0.Add(exhDeadline[dl[i]]))
		}
	}

	var fired [exhN][2]int
	for i := 0; i < exhN; i++ {
		for k := 0; k < 2; k++ {
			i, k := i, k
			ctxs[i].OnCancel(func() { fired[i][k]++ })
		}
	}

	// Earliest-deadline invariant, checked before any action.
	eff := effectiveDeadlines(parent, dl)
	for i := 0; i < exhN; i++ {
		got, ok := ctxs[i].Deadline()
		if eff[i] == infDuration {
			if ok {
				t.Fatalf("parent=%v dl=%v: node %d has deadline %v; want none", parent, dl, i, got)
			}
			continue
		}
		if want := t0.Add(eff[i]); !ok || !got.Equal(want) {
			t.Fatalf("parent=%v dl=%v: node %d deadline = %v,%v; want %v,true",
				parent, dl, i, got, ok, want)
		}
	}

	if act.kind != actNone {
		clk.AdvanceTo(t0.Add(act.at))
		switch act.kind {
		case actCancel:
			cancels[act.node]()
		case actRelease:
			Release(ctxs[act.node])
		}
	}
	clk.AdvanceTo(t0.Add(100 * time.Second))

	want := simulate(parent, dl, act)
	for i := 0; i < exhN; i++ {
		if got := ctxs[i].Err(); got != want[i] {
			t.Fatalf("parent=%v dl=%v act=%+v: node %d err = %v; want %v",
				parent, dl, act, i, got, want[i])
		}
		for k := 0; k < 2; k++ {
			wantFired := 0
			if want[i] != nil {
				wantFired = 1
			}
			if fired[i][k] != wantFired {
				t.Fatalf("parent=%v dl=%v act=%+v: node %d callback %d fired %d times; want %d",
					parent, dl, act, i, k, fired[i][k], wantFired)
			}
		}
		select {
		case <-ctxs[i].Done():
			if want[i] == nil {
				t.Fatalf("parent=%v dl=%v act=%+v: node %d Done closed but err is nil",
					parent, dl, act, i)
			}
		default:
			if want[i] != nil {
				t.Fatalf("parent=%v dl=%v act=%+v: node %d canceled but Done open",
					parent, dl, act, i)
			}
		}
	}

	// Releasing the whole tree must leave no timers behind.
	for i := 0; i < exhN; i++ {
		Release(ctxs[i])
	}
	if n := clk.Pending(); n != 0 {
		t.Fatalf("parent=%v dl=%v act=%+v: %d pending timers after full release",
			parent, dl, act, n)
	}
}

const infDuration = time.Duration(1<<62 - 1)

// effectiveDeadlines returns the earliest deadline on each node's ancestor
// chain (including itself), or infDuration when the chain has none.
func effectiveDeadlines(parent []int, dl []int) []time.Duration {
	eff := make([]time.Duration, len(parent))
	for i := range parent {
		self := infDuration
		if dl[i] != 0 {
			self = exhDeadline[dl[i]]
		}
		if parent[i] < 0 {
			eff[i] = self
			continue
		}
		if eff[parent[i]] < self {
			eff[i] = eff[parent[i]]
		} else {
			eff[i] = self
		}
	}
	return eff
}

// simulate is an independent model of the library semantics: it computes
// each node's final Err after the action and all virtual-time timeouts.
func simulate(parent []int, dl []int, act exhAction) []error {
	n := len(parent)
	errs := make([]error, n)
	released := make([]bool, n)
	eff := effectiveDeadlines(parent, dl)

	var cancelSubtree func(m int, err error)
	cancelSubtree = func(m int, err error) {
		if released[m] {
			return // detached: nothing propagates into or through it
		}
		if errs[m] == nil {
			errs[m] = err
		}
		for j := range parent {
			if parent[j] == m {
				cancelSubtree(j, err)
			}
		}
	}

	// A node arms its own timer only when its deadline is strictly earlier
	// than its parent's effective deadline.
	ownTimer := func(i int) bool {
		if dl[i] == 0 {
			return false
		}
		parentEff := infDuration
		if parent[i] >= 0 {
			parentEff = eff[parent[i]]
		}
		return exhDeadline[dl[i]] < parentEff
	}

	applyAction := func() {
		switch act.kind {
		case actCancel:
			cancelSubtree(act.node, Canceled)
		case actRelease:
			if errs[act.node] == nil {
				released[act.node] = true
			}
		}
	}

	acted := act.kind == actNone
	for _, tick := range []time.Duration{10 * time.Second, 20 * time.Second} {
		if !acted && act.at < tick {
			applyAction()
			acted = true
		}
		for i := 0; i < n; i++ {
			if ownTimer(i) && exhDeadline[dl[i]] == tick && errs[i] == nil && !released[i] {
				cancelSubtree(i, DeadlineExceeded)
			}
		}
	}
	if !acted {
		applyAction()
	}
	return errs
}
