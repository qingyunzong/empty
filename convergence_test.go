package formal

import (
	"math/rand/v2"
	"net/netip"
	"testing"
)

type selectedRoute struct {
	prefix netip.Prefix
	peer   netip.Addr
}

func selectedMap(rib *RIB) map[selectedRoute]bool {
	selected := make(map[selectedRoute]bool)
	for _, prefix := range rib.Prefixes() {
		best := rib.Best(prefix)
		if best == nil {
			continue
		}
		selected[selectedRoute{prefix: prefix, peer: best.Peer.Address}] = true
	}
	return selected
}

func sameSelection(a, b map[selectedRoute]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for key := range a {
		if !b[key] {
			return false
		}
	}
	return true
}

func TestConvergenceUnderInterleavedEvents(t *testing.T) {
	rng := rand.New(rand.NewPCG(0x51ed270b, 0x0b15ed27))

	const peerCount = 6
	const prefixCount = 4

	peers := make([]Neighbor, peerCount)
	for i := range peers {
		peers[i] = Neighbor{
			Address: netip.AddrFrom4([4]byte{192, 0, 2, byte(i + 1)}),
			Kind:    PeerIBGP,
		}
	}

	prefixes := make([]netip.Prefix, prefixCount)
	for i := range prefixes {
		prefixes[i] = netip.PrefixFrom(
			netip.AddrFrom4([4]byte{10, byte(i), 0, 0}), 24)
	}

	generateRoute := func(sequence int) *Route {
		peer := peers[rng.IntN(peerCount)]
		prefix := prefixes[rng.IntN(prefixCount)]
		attrs := PathAttributes{
			LocalPref: u32(uint32(50 + rng.IntN(201))),
			ASPath:    sequencePath(rng.IntN(4)),
			Origin:    Origin(rng.IntN(3)),
			MED:       u32(uint32(rng.IntN(1000))),
		}
		route := NewRoute(prefix, peer, attrs)
		route.Received = int64(sequence)
		return route
	}

	rib := NewRIB()
	// active tracks the current authoritative route per (prefix, peer).
	active := make(map[selectedRoute]*Route)

	for step := 0; step < 400; step++ {
		if len(active) == 0 || rng.IntN(3) > 0 {
			route := generateRoute(step)
			if err := rib.Update(route); err != nil {
				t.Fatalf("step %d update: %v", step, err)
			}
			active[selectedRoute{prefix: route.Prefix, peer: route.Peer.Address}] = route
		} else {
			var keys []selectedRoute
			for key := range active {
				keys = append(keys, key)
			}
			key := keys[rng.IntN(len(keys))]
			rib.Withdraw(key.prefix, Neighbor{Address: key.peer, Kind: PeerIBGP})
			delete(active, key)
		}

		// 1. Recomputing from the same state is idempotent and deterministic.
		first := selectedMap(rib)
		recomputed := rib.recompute()
		if len(recomputed) != len(first) {
			t.Fatalf("step %d: recompute changed selection size", step)
		}
		for prefix, route := range recomputed {
			if !first[selectedRoute{prefix: prefix, peer: route.Peer.Address}] {
				t.Fatalf("step %d: recompute selected different route for %s", step, prefix)
			}
		}

		// 2. Every selected route must belong to the active authoritative set.
		for selection := range first {
			if _, ok := active[selection]; !ok {
				t.Fatalf("step %d: selected route %v is not active", step, selection)
			}
			// 3. Selection must equal the rule order applied to all active routes.
			for key, candidate := range active {
				if key.prefix != selection.prefix {
					continue
				}
				current := active[selection]
				if CompareRoutes(candidate, current) < 0 {
					t.Fatalf("step %d: active route from %v beats selected route",
						step, candidate.Peer.Address)
				}
			}
		}

		// 4. Withdrawn prefixes must have no selection.
		for _, prefix := range prefixes {
			hasActive := false
			for key := range active {
				if key.prefix == prefix {
					hasActive = true
					break
				}
			}
			if !hasActive && rib.Best(prefix) != nil {
				t.Fatalf("step %d: best route exists for drained prefix %s", step, prefix)
			}
		}
	}

	// 5. Fixed point: rebuilding a fresh RIB from the surviving routes in any
	// order yields exactly the final selection, proving event-order independence.
	finalSelection := selectedMap(rib)
	var survivors []*Route
	for _, route := range active {
		survivors = append(survivors, route)
	}

	for trial := 0; trial < 8; trial++ {
		rebuilt := NewRIB()
		order := rng.Perm(len(survivors))
		for _, index := range order {
			if err := rebuilt.Update(survivors[index]); err != nil {
				t.Fatalf("rebuild update: %v", err)
			}
		}
		if !sameSelection(finalSelection, selectedMap(rebuilt)) {
			t.Fatalf("trial %d: selection depends on event order", trial)
		}
	}

	// 6. Convergence: withdraw everything, then re-add survivors; the final
	// selection after the identical state returns must match.
	drained := NewRIB()
	if err := drained.RestoreSnapshot(rib.Snapshot()); err != nil {
		t.Fatalf("restore snapshot: %v", err)
	}
	for _, prefix := range prefixes {
		for key := range active {
			if key.prefix == prefix {
				drained.Withdraw(prefix, Neighbor{Address: key.peer, Kind: PeerIBGP})
			}
		}
	}
	if len(drained.Prefixes()) != 0 {
		t.Fatalf("drained RIB still contains prefixes: %v", drained.Prefixes())
	}
	for _, route := range survivors {
		if err := drained.Update(route); err != nil {
			t.Fatalf("re-add: %v", err)
		}
	}
	if !sameSelection(finalSelection, selectedMap(drained)) {
		t.Fatal("selection failed to converge after drain and re-add")
	}
}

func TestApplyAndSnapshotConvergence(t *testing.T) {
	prefix := netip.MustParsePrefix("10.9.0.0/24")
	peerA := Neighbor{Address: netip.MustParseAddr("192.0.2.1"), Kind: PeerEBGP}
	peerB := Neighbor{Address: netip.MustParseAddr("192.0.2.2"), Kind: PeerEBGP}

	rib := NewRIB()
	events := []Event{
		{Kind: EventUpdate, Route: NewRoute(prefix, peerA, PathAttributes{LocalPref: u32(100), MED: u32(50)})},
		{Kind: EventUpdate, Route: NewRoute(prefix, peerB, PathAttributes{LocalPref: u32(200), MED: u32(90)})},
		{Kind: EventUpdate, Route: NewRoute(prefix, peerA, PathAttributes{LocalPref: u32(300), MED: u32(90)})},
		{Kind: EventWithdraw, Prefix: prefix, Peer: peerB},
		{Kind: EventWithdraw, Prefix: prefix, Peer: peerB},
	}
	if err := rib.Apply(events...); err != nil {
		t.Fatalf("apply: %v", err)
	}
	best := rib.Best(prefix)
	if best == nil || best.Peer.Address != peerA.Address {
		t.Fatalf("unexpected best route: %+v", best)
	}

	snapshot := rib.Snapshot()
	rib.Withdraw(prefix, peerA)
	if rib.Best(prefix) != nil {
		t.Fatal("withdraw did not remove the route")
	}
	if err := rib.RestoreSnapshot(snapshot); err != nil {
		t.Fatalf("restore: %v", err)
	}
	restored := rib.Best(prefix)
	if restored == nil || restored.Peer.Address != peerA.Address ||
		restored.Attrs.EffectiveLocalPref() != 300 {
		t.Fatalf("snapshot restore lost state: %+v", restored)
	}
}
