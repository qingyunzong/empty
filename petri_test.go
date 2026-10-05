package petri

import (
	"math/rand"
	"testing"
)

// vec builds a token vector from (place, count) pairs.
func vec(pairs ...int) [MaxPlaces]uint8 {
	var v [MaxPlaces]uint8
	for i := 0; i < len(pairs); i += 2 {
		v[pairs[i]] = uint8(pairs[i+1])
	}
	return v
}

func mark(pairs ...int) Marking { return Marking(vec(pairs...)) }

func resets(places ...int) [MaxPlaces]bool {
	var r [MaxPlaces]bool
	for _, p := range places {
		r[p] = true
	}
	return r
}

// replayCert replays a certificate path and checks every step.
func replayCert(t *testing.T, n *Net, initial Marking, cert Certificate) {
	t.Helper()
	m := initial
	if cert.States[0] != initial {
		t.Fatalf("certificate does not start at initial marking")
	}
	for k, ti := range cert.Path {
		if ti < 0 || ti >= len(n.Transitions) {
			t.Fatalf("step %d: bad transition index %d", k, ti)
		}
		next, ok := n.Transitions[ti].Fire(m)
		if !ok {
			t.Fatalf("step %d: transition %s not fireable at %v", k, n.Transitions[ti].Name, m)
		}
		m = next
		if m != cert.States[k+1] {
			t.Fatalf("step %d: state mismatch got %v want %v", k, m, cert.States[k+1])
		}
	}
}

func setOf(list []Marking) map[Marking]bool {
	out := make(map[Marking]bool, len(list))
	for _, m := range list {
		out[m] = true
	}
	return out
}

func TestShortestTrajectory(t *testing.T) {
	// Line of 4 places: tokens move p0 -> p1 -> p2 -> p3.
	n := &Net{Places: 4, Transitions: []Transition{
		{Name: "t0", Consume: vec(0, 1), Produce: vec(1, 1)},
		{Name: "t1", Consume: vec(1, 1), Produce: vec(2, 1)},
		{Name: "t2", Consume: vec(2, 1), Produce: vec(3, 1)},
	}}
	initial := mark(0, 1)
	target := mark(3, 1)
	cert := n.Search(initial, target)
	if !cert.Reachable {
		t.Fatal("target should be reachable")
	}
	if len(cert.Path) != 3 {
		t.Fatalf("shortest path length = %d, want 3", len(cert.Path))
	}
	replayCert(t, n, initial, cert)
	if d := n.NaiveShortestDistance(initial, target); d != len(cert.Path) {
		t.Fatalf("naive distance %d != certificate length %d", d, len(cert.Path))
	}
}

func TestCapacityOverflowBlocksFiring(t *testing.T) {
	// One place, capacity 4; t adds 2 tokens. Reachable: 0, 2, 4.
	n := &Net{Places: 1, Transitions: []Transition{
		{Name: "add2", Produce: vec(0, 2)},
	}}
	initial := mark()
	if _, ok := n.Transitions[0].Fire(mark(0, 3)); ok {
		t.Fatal("firing at 3 tokens must overflow capacity 4 and be blocked")
	}
	cert := n.Search(initial, mark(0, 3))
	if cert.Reachable {
		t.Fatal("marking with 3 tokens must be unreachable")
	}
	want := map[Marking]bool{mark(): true, mark(0, 2): true, mark(0, 4): true}
	if got := setOf(cert.Closure); len(got) != len(want) {
		t.Fatalf("closure = %v, want %v", got, want)
	} else {
		for m := range want {
			if !got[m] {
				t.Fatalf("closure missing %v", m)
			}
		}
	}
}

func TestDeduplication(t *testing.T) {
	// Diamond: two independent token movers; interleavings must dedup.
	n := &Net{Places: 4, Transitions: []Transition{
		{Name: "a", Consume: vec(0, 1), Produce: vec(1, 1)},
		{Name: "b", Consume: vec(2, 1), Produce: vec(3, 1)},
	}}
	initial := mark(0, 1, 2, 1)
	closure := n.Closure(initial)
	if len(closure) != 4 {
		t.Fatalf("closure size = %d, want 4 (dedup failed?)", len(closure))
	}
	if len(setOf(closure)) != 4 {
		t.Fatal("closure contains duplicate states")
	}
}

func TestPriority(t *testing.T) {
	// Both transitions enabled at (1,0); only the high-priority one may fire.
	n := &Net{Places: 2, Transitions: []Transition{
		{Name: "low", Consume: vec(0, 1), Priority: 0},                      // deletes token
		{Name: "high", Consume: vec(0, 1), Produce: vec(1, 1), Priority: 1}, // moves token
	}}
	initial := mark(0, 1)
	closure := setOf(n.Closure(initial))
	if closure[mark()] {
		t.Fatal("low-priority transition fired while high-priority was enabled")
	}
	if !closure[mark(1, 1)] {
		t.Fatal("high-priority transition should have fired")
	}
	if len(closure) != 2 {
		t.Fatalf("closure size = %d, want 2", len(closure))
	}
	// Once the high-priority transition is disabled, the low one may fire.
	n2 := &Net{Places: 2, Transitions: []Transition{
		{Name: "low", Consume: vec(0, 1), Priority: 0},
		{Name: "high", Consume: vec(1, 1), Produce: vec(1, 1), Priority: 1},
	}}
	cert := n2.Search(initial, mark())
	if !cert.Reachable || len(cert.Path) != 1 || cert.Path[0] != 0 {
		t.Fatalf("low-priority transition should fire when high is disabled: %+v", cert)
	}
}

func TestResetArc(t *testing.T) {
	// t consumes 1 from p0, resets p1, then produces into p2.
	net := &Net{Places: 3, Transitions: []Transition{
		{Name: "t", Consume: vec(0, 1), Reset: resets(1), Produce: vec(2, 1)},
	}}
	got, ok := net.Transitions[0].Fire(mark(0, 1, 1, 3))
	if !ok {
		t.Fatal("transition should be fireable")
	}
	if want := mark(2, 1); got != want {
		t.Fatalf("after reset got %v, want %v", got, want)
	}
	// Reset happens after unified consumption and before production, so a
	// reset place can be refilled without overflowing capacity.
	net2 := &Net{Places: 1, Transitions: []Transition{
		{Name: "t", Consume: vec(0, 1), Reset: resets(0), Produce: vec(0, 4)},
	}}
	got, ok = net2.Transitions[0].Fire(mark(0, 4))
	if !ok || got != mark(0, 4) {
		t.Fatalf("reset+produce got %v ok=%v, want (4) ok=true", got, ok)
	}
}

func TestGuard(t *testing.T) {
	// Guard blocks firing once p1 holds 2 tokens, well below capacity.
	n := &Net{Places: 2, Transitions: []Transition{
		{Name: "t", Consume: vec(0, 1), Produce: vec(0, 1, 1, 1),
			Guard: func(m Marking) bool { return m[1] < 2 }},
	}}
	closure := setOf(n.Closure(mark(0, 1)))
	want := map[Marking]bool{mark(0, 1): true, mark(0, 1, 1, 1): true, mark(0, 1, 1, 2): true}
	if len(closure) != len(want) {
		t.Fatalf("closure = %v, want %v", closure, want)
	}
	for m := range want {
		if !closure[m] {
			t.Fatalf("closure missing %v", m)
		}
	}
}

// crossCheckNet compares all three implementations on one net.
func crossCheckNet(t *testing.T, n *Net, initial Marking) {
	t.Helper()
	fast := setOf(n.Closure(initial))
	naive := setOf(n.NaiveClosure(initial))
	indep := n.Enumerate(initial)
	if len(fast) != len(naive) || len(fast) != len(indep) {
		t.Fatalf("closure sizes differ: fast=%d naive=%d enum=%d", len(fast), len(naive), len(indep))
	}
	for m := range fast {
		if !naive[m] || !indep[m] {
			t.Fatalf("state %v missing from cross-check enumeration", m)
		}
	}
}

func TestCrossCheckImplementations(t *testing.T) {
	nets := []struct {
		name    string
		net     *Net
		initial Marking
	}{
		{"line", &Net{Places: 3, Transitions: []Transition{
			{Name: "t0", Consume: vec(0, 1), Produce: vec(1, 1)},
			{Name: "t1", Consume: vec(1, 1), Produce: vec(2, 1)},
		}}, mark(0, 2)},
		{"cycle-reset", &Net{Places: 2, Transitions: []Transition{
			{Name: "t0", Consume: vec(0, 1), Produce: vec(1, 1)},
			{Name: "t1", Consume: vec(1, 1), Reset: resets(0), Produce: vec(0, 2)},
		}}, mark(0, 1)},
		{"priority-guard", &Net{Places: 2, Transitions: []Transition{
			{Name: "lo", Consume: vec(0, 1), Produce: vec(1, 2)},
			{Name: "hi", Consume: vec(0, 1), Produce: vec(0, 1, 1, 1), Priority: 2,
				Guard: func(m Marking) bool { return m[1] < 3 }},
		}}, mark(0, 2)},
	}
	for _, tc := range nets {
		t.Run(tc.name, func(t *testing.T) { crossCheckNet(t, tc.net, tc.initial) })
	}
}

// TestRandomCrossCheck generates deterministic pseudo-random nets and checks
// that all three enumerators agree, and that BFS distances match the naive
// ones for sampled targets.
func TestRandomCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 30; trial++ {
		places := 1 + rng.Intn(4)
		nt := 1 + rng.Intn(4)
		net := &Net{Places: places}
		for i := 0; i < nt; i++ {
			tr := Transition{Name: string(rune('a' + i)), Priority: rng.Intn(3) - 1}
			for p := 0; p < places; p++ {
				tr.Consume[p] = uint8(rng.Intn(2))
				tr.Produce[p] = uint8(rng.Intn(3))
				if rng.Intn(6) == 0 {
					tr.Reset[p] = true
				}
			}
			if rng.Intn(3) == 0 {
				p := rng.Intn(places)
				k := uint8(rng.Intn(3))
				tr.Guard = func(m Marking) bool { return m[p] >= k }
			}
			net.Transitions = append(net.Transitions, tr)
		}
		var initial Marking
		for p := 0; p < places; p++ {
			initial[p] = uint8(rng.Intn(3))
		}
		crossCheckNet(t, net, initial)
		// Distance cross-check on sampled reachable targets.
		for _, target := range net.Closure(initial) {
			fast := net.Search(initial, target)
			if !fast.Reachable {
				t.Fatalf("trial %d: reachable state %v reported unreachable", trial, target)
			}
			if d := net.NaiveShortestDistance(initial, target); d != len(fast.Path) {
				t.Fatalf("trial %d: distance to %v: fast=%d naive=%d", trial, target, len(fast.Path), d)
			}
		}
	}
}

func TestFairCycleSimple(t *testing.T) {
	// Token ping-pongs between p0 and p1; both transitions must fire.
	n := &Net{Places: 2, Transitions: []Transition{
		{Name: "t0", Consume: vec(0, 1), Produce: vec(1, 1)},
		{Name: "t1", Consume: vec(1, 1), Produce: vec(0, 1)},
	}}
	initial := mark(0, 1)
	cert := n.FairCycle(initial)
	if !cert.Found {
		t.Fatal("expected a fair cycle")
	}
	verifyLasso(t, n, initial, cert)
	if len(cert.Prefix) != 0 {
		t.Fatalf("prefix should be empty, got %v", cert.Prefix)
	}
	fired := map[int]bool{}
	for _, ti := range cert.Cycle {
		fired[ti] = true
	}
	if !fired[0] || !fired[1] {
		t.Fatalf("fair cycle must fire both transitions, got %v", cert.Cycle)
	}
}

func TestFairCycleWithDetour(t *testing.T) {
	// Main loop p0<->p1 plus a side loop p1->p2->p1. A fair run must
	// eventually take the detour, so the cycle must fire all 4 transitions.
	n := &Net{Places: 3, Transitions: []Transition{
		{Name: "t0", Consume: vec(0, 1), Produce: vec(1, 1)},
		{Name: "t1", Consume: vec(1, 1), Produce: vec(0, 1)},
		{Name: "t2", Consume: vec(1, 1), Produce: vec(2, 1)},
		{Name: "t3", Consume: vec(2, 1), Produce: vec(1, 1)},
	}}
	initial := mark(0, 1)
	cert := n.FairCycle(initial)
	if !cert.Found {
		t.Fatal("expected a fair cycle")
	}
	verifyLasso(t, n, initial, cert)
	fired := map[int]bool{}
	for _, ti := range cert.Cycle {
		fired[ti] = true
	}
	for i := 0; i < 4; i++ {
		if !fired[i] {
			t.Fatalf("fair cycle must fire transition %d, got %v", i, cert.Cycle)
		}
	}
}

func TestFairCycleNone(t *testing.T) {
	// Acyclic net: no infinite run exists.
	n := &Net{Places: 2, Transitions: []Transition{
		{Name: "t0", Consume: vec(0, 1), Produce: vec(1, 1)},
	}}
	if cert := n.FairCycle(mark(0, 1)); cert.Found {
		t.Fatalf("no cycle should exist, got %+v", cert)
	}
}

// verifyLasso replays prefix+cycle, checks the cycle closes, and checks the
// fairness condition.
func verifyLasso(t *testing.T, n *Net, initial Marking, cert LassoCertificate) {
	t.Helper()
	m := initial
	for k, ti := range cert.Prefix {
		next, ok := n.Transitions[ti].Fire(m)
		if !ok {
			t.Fatalf("prefix step %d not fireable", k)
		}
		m = next
		if m != cert.PrefixStates[k+1] {
			t.Fatalf("prefix state %d mismatch", k+1)
		}
	}
	start := m
	for k, ti := range cert.Cycle {
		next, ok := n.Transitions[ti].Fire(m)
		if !ok {
			t.Fatalf("cycle step %d not fireable", k)
		}
		m = next
		if m != cert.CycleStates[k+1] {
			t.Fatalf("cycle state %d mismatch", k+1)
		}
	}
	if m != start {
		t.Fatalf("cycle does not close: start %v end %v", start, m)
	}
	if len(cert.Cycle) == 0 {
		t.Fatal("cycle must be non-empty")
	}
	if !n.IsFairCycle(cert.CycleStates[:len(cert.CycleStates)-1], cert.Cycle) {
		t.Fatalf("cycle %v is not fair", cert.Cycle)
	}
}
