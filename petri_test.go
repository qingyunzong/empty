package petri

import "testing"

func mk(vals ...uint8) Marking {
	var m Marking
	copy(m[:], vals)
	return m
}

// moveNet: one token shuttled between two places.
func moveNet() *Net {
	n := NewNet(2)
	n.Transitions = []Transition{
		{Name: "t01", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{0, 1}},
		{Name: "t10", Consume: [MaxPlaces]uint8{0, 1}, Produce: [MaxPlaces]uint8{1}},
	}
	return n
}

func TestShortestPathCertificate(t *testing.T) {
	n := moveNet()
	initial, target := mk(1, 0), mk(0, 1)
	closure, cert := n.Reach(initial, &target)
	if !cert.Found {
		t.Fatal("target should be reachable")
	}
	if len(cert.Path) != 1 || cert.Path[0] != 0 {
		t.Fatalf("shortest path = %v, want [0]", cert.Path)
	}
	if err := cert.Verify(n, initial); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
	if closure.Len() != 2 {
		t.Fatalf("partial closure size = %d, want 2", closure.Len())
	}
}

func TestCapacityOverflowBlocksFiring(t *testing.T) {
	n := NewNet(1)
	n.Transitions = []Transition{
		{Name: "produce", Produce: [MaxPlaces]uint8{1}},
	}
	closure, _ := n.Reach(mk(0), nil)
	if closure.Len() != int(DefaultCapacity)+1 {
		t.Fatalf("closure size = %d, want %d (cap 4 blocks firing at 4)",
			closure.Len(), DefaultCapacity+1)
	}
	for tok := uint8(0); tok <= DefaultCapacity; tok++ {
		if !closure.Contains(mk(tok)) {
			t.Fatalf("marking %d missing from closure", tok)
		}
	}
	// Firing at capacity must be rejected.
	if _, ok := n.Fire(mk(DefaultCapacity), 0); ok {
		t.Fatal("firing at full capacity should be blocked")
	}
}

func TestUnreachableTargetYieldsFullClosure(t *testing.T) {
	n := moveNet() // conserves the single token
	initial := mk(1, 0)
	target := mk(2, 0) // impossible
	closure, cert := n.Reach(initial, &target)
	if cert.Found {
		t.Fatal("target must be unreachable")
	}
	if closure.Len() != 2 {
		t.Fatalf("full closure size = %d, want 2", closure.Len())
	}
	// Cross-check against the independent enumerator.
	indep := n.EnumerateIndependently(initial)
	if len(indep) != closure.Len() {
		t.Fatalf("independent enumeration has %d states, closure has %d",
			len(indep), closure.Len())
	}
	for _, m := range closure.States {
		if !indep[m] {
			t.Fatalf("state %v missing from independent enumeration", m)
		}
	}
}

func TestClosureDeduplicatesStates(t *testing.T) {
	n := moveNet()
	closure, _ := n.Reach(mk(1, 0), nil)
	seen := map[Marking]bool{}
	for _, m := range closure.States {
		if seen[m] {
			t.Fatalf("duplicate state %v in closure", m)
		}
		seen[m] = true
	}
}

func TestPrioritySemantics(t *testing.T) {
	n := NewNet(1)
	n.Transitions = []Transition{
		{Name: "low", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{2}, Priority: 0},
		{Name: "high", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{1}, Priority: 1},
	}
	// Both transitions are enabled at (1), but only the high-priority one
	// may fire.
	f := n.Fireable(mk(1))
	if len(f) != 1 || f[0].Transition != 1 {
		t.Fatalf("fireable at (1) = %v, want only high", f)
	}
	closure, _ := n.Reach(mk(1), nil)
	if closure.Contains(mk(2)) {
		t.Fatal("low-priority transition fired while high-priority was enabled")
	}
	// Once the high-priority transition is not enabled, low may fire.
	n2 := NewNet(1)
	n2.Transitions = []Transition{
		{Name: "low", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{2}, Priority: 0},
		{Name: "high", Consume: [MaxPlaces]uint8{3}, Produce: [MaxPlaces]uint8{3}, Priority: 1},
	}
	if _, ok := n2.Fire(mk(1), 0); !ok {
		t.Fatal("low-priority transition should fire when high is not enabled")
	}
}

func TestResetArcAfterUnifiedConsumption(t *testing.T) {
	n := NewNet(2)
	n.Transitions = []Transition{
		{
			Name:    "t",
			Consume: [MaxPlaces]uint8{1, 1}, // consume one token from each place
			Reset:   [MaxPlaces]bool{false, true},
			Produce: [MaxPlaces]uint8{1, 0},
		},
	}
	// Unified consumption first: (2,3) -> (1,2); reset p1 -> (1,0);
	// production -> (2,0).
	got, ok := n.Fire(mk(2, 3), 0)
	if !ok {
		t.Fatal("transition should be fireable")
	}
	if want := mk(2, 0); got != want {
		t.Fatalf("after reset firing got %v, want %v", got, want)
	}
}

func TestGuard(t *testing.T) {
	n := NewNet(2)
	n.Transitions = []Transition{
		{
			Name:    "guarded",
			Produce: [MaxPlaces]uint8{0, 1},
			Guard:   func(m Marking) bool { return m[0] >= 2 },
		},
	}
	if _, ok := n.Fire(mk(1, 0), 0); ok {
		t.Fatal("guard m[0]>=2 must block firing at (1,0)")
	}
	if got, ok := n.Fire(mk(2, 0), 0); !ok || got != mk(2, 1) {
		t.Fatalf("guard should pass at (2,0), got %v ok=%v", got, ok)
	}
}

func TestFairCycleFound(t *testing.T) {
	n := moveNet()
	closure, cert := n.FairCycle(mk(1, 0))
	if !cert.Found {
		t.Fatal("expected a fair cycle in the two-place shuttle net")
	}
	if err := cert.Verify(n, mk(1, 0)); err != nil {
		t.Fatalf("cycle certificate does not verify: %v", err)
	}
	if closure.Len() != 2 {
		t.Fatalf("closure size = %d, want 2", closure.Len())
	}
}

func TestFairCycleWithSelfLoop(t *testing.T) {
	// t1 shuttles p0->p1, t2 shuttles p1->p0, t3 is a self-loop on p0.
	// A fair run must fire all three infinitely often.
	n := NewNet(2)
	n.Transitions = []Transition{
		{Name: "t1", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{0, 1}},
		{Name: "t2", Consume: [MaxPlaces]uint8{0, 1}, Produce: [MaxPlaces]uint8{1}},
		{Name: "t3", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{1}},
	}
	_, cert := n.FairCycle(mk(1, 0))
	if !cert.Found {
		t.Fatal("expected a fair cycle covering t1, t2 and t3")
	}
	if err := cert.Verify(n, mk(1, 0)); err != nil {
		t.Fatalf("cycle certificate does not verify: %v", err)
	}
	fired := map[int]bool{}
	for _, tr := range cert.Cycle {
		fired[tr] = true
	}
	for i := 0; i < 3; i++ {
		if !fired[i] {
			t.Fatalf("fair cycle never fires transition %d", i)
		}
	}
}

func TestNoFairCycleWhenExitIsOneWay(t *testing.T) {
	// t1 self-loops on p0; t2 moves the token to p1 where it dies. Any
	// infinite run either stays at (1,0) ignoring t2 forever (unfair) or
	// takes t2 and terminates. No fair infinite run exists.
	n := NewNet(2)
	n.Transitions = []Transition{
		{Name: "stay", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{1}},
		{Name: "leave", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{0, 1}},
	}
	closure, cert := n.FairCycle(mk(1, 0))
	if cert.Found {
		t.Fatalf("no fair infinite run should exist, got %+v", cert)
	}
	if closure.Len() != 2 {
		t.Fatalf("closure size = %d, want 2", closure.Len())
	}
}

// crossCheckNet is a richer bounded net used to compare the optimized BFS
// against the naive baseline and the independent enumerator.
func crossCheckNet() *Net {
	n := NewNet(3)
	n.Transitions = []Transition{
		{Name: "a", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{0, 1}},
		{Name: "b", Consume: [MaxPlaces]uint8{0, 1}, Produce: [MaxPlaces]uint8{0, 0, 1}},
		{Name: "c", Consume: [MaxPlaces]uint8{0, 0, 1}, Produce: [MaxPlaces]uint8{1}},
		{Name: "d", Consume: [MaxPlaces]uint8{1}, Produce: [MaxPlaces]uint8{1, 1}, Priority: 1},
	}
	return n
}

func TestNaiveBFSAndIndependentEnumerationCrossCheck(t *testing.T) {
	n := crossCheckNet()
	initial := mk(2, 0, 0)

	closure, _ := n.Reach(initial, nil)
	naiveStates, naiveDist := n.NaiveReach(initial, nil)
	indep := n.EnumerateIndependently(initial)

	if len(naiveStates) != closure.Len() {
		t.Fatalf("naive BFS found %d states, optimized BFS found %d",
			len(naiveStates), closure.Len())
	}
	if len(indep) != closure.Len() {
		t.Fatalf("independent enumeration found %d states, closure has %d",
			len(indep), closure.Len())
	}
	for _, m := range closure.States {
		if !indep[m] {
			t.Fatalf("state %v missing from independent enumeration", m)
		}
		if _, ok := naiveDist[m]; !ok {
			t.Fatalf("state %v missing from naive BFS", m)
		}
	}

	// For every reachable target, the certificate path length must equal
	// the naive BFS distance (both are shortest).
	for _, m := range closure.States {
		target := m
		_, cert := n.Reach(initial, &target)
		if !cert.Found {
			t.Fatalf("state %v reported unreachable", m)
		}
		if err := cert.Verify(n, initial); err != nil {
			t.Fatalf("certificate for %v invalid: %v", m, err)
		}
		if got, want := len(cert.Path), naiveDist[m]; got != want {
			t.Fatalf("shortest path to %v: optimized %d, naive %d", m, got, want)
		}
	}
}

func TestCertificateRejectsTampering(t *testing.T) {
	n := moveNet()
	initial, target := mk(1, 0), mk(0, 1)
	_, cert := n.Reach(initial, &target)
	cert.Path = []int{1} // t10 is not fireable at (1,0)
	if err := cert.Verify(n, initial); err == nil {
		t.Fatal("tampered certificate should not verify")
	}
}
