package formal

import (
	"net/netip"
	"testing"
)

func TestAttributeEdgeDefaults(t *testing.T) {
	attrs := PathAttributes{Origin: Origin(99)}
	if got := attrs.EffectiveOrigin(); got != OriginIncomplete {
		t.Fatalf("out-of-range origin = %d, want INCOMPLETE", got)
	}

	emptySet := PathAttributes{ASPath: []ASSegment{
		{Type: ASSet, ASes: nil},
		{Type: ASSequence, ASes: []uint32{65001}},
		{Type: ASSet, ASes: []uint32{65002, 65003}},
	}}
	if got := emptySet.ASPathLength(); got != 2 {
		t.Fatalf("empty AS_SET must contribute zero, got length %d", got)
	}

	if got := (DecisionStep(0)).String(); got != "UNKNOWN" {
		t.Fatalf("unknown step string = %q", got)
	}

	if got := StepMED.String(); got != "MULTI_EXIT_DISC" {
		t.Fatalf("MED step string = %q", got)
	}
}

func TestRoutesForAndPrefixesAreSorted(t *testing.T) {
	prefixA := netip.MustParsePrefix("10.0.0.0/24")
	prefixB := netip.MustParsePrefix("10.0.1.0/24")
	rib := NewRIB()

	for _, address := range []string{"10.9.9.3", "10.9.9.1", "10.9.9.2"} {
		route := NewRoute(prefixA,
			Neighbor{Address: netip.MustParseAddr(address), Kind: PeerEBGP},
			PathAttributes{LocalPref: u32(100)})
		if err := rib.Update(route); err != nil {
			t.Fatalf("update: %v", err)
		}
	}
	if err := rib.Update(NewRoute(prefixB,
		Neighbor{Address: netip.MustParseAddr("10.9.9.9"), Kind: PeerEBGP},
		PathAttributes{})); err != nil {
		t.Fatalf("update: %v", err)
	}

	ordered := rib.RoutesFor(prefixA)
	if len(ordered) != 3 {
		t.Fatalf("RoutesFor returned %d routes", len(ordered))
	}
	for i := 1; i < len(ordered); i++ {
		if CompareRoutes(ordered[i-1], ordered[i]) >= 0 {
			t.Fatal("RoutesFor is not sorted by decision order")
		}
	}

	prefixes := rib.Prefixes()
	if len(prefixes) != 2 || prefixes[0] != prefixA || prefixes[1] != prefixB {
		t.Fatalf("Prefixes order wrong: %v", prefixes)
	}

	if routes := rib.RoutesFor(netip.MustParsePrefix("198.18.0.0/24")); routes != nil {
		t.Fatalf("unknown prefix must return nil, got %v", routes)
	}

	// Withdrawing the last route drops the prefix from the RIB.
	for _, address := range []string{"10.9.9.3", "10.9.9.1", "10.9.9.2"} {
		rib.Withdraw(prefixA, Neighbor{Address: netip.MustParseAddr(address), Kind: PeerEBGP})
	}
	if rib.Best(prefixA) != nil || len(rib.Prefixes()) != 1 {
		t.Fatal("drained prefix must disappear from Prefixes")
	}
}

func TestReflectNilAndUpdateValidation(t *testing.T) {
	if _, err := ReflectRoute(nil, netip.Addr{}, netip.Addr{}); err == nil {
		t.Fatal("reflecting nil route must fail")
	}
	if Reflectable(nil, true, Neighbor{}, true) {
		t.Fatal("nil route must not be reflectable")
	}

	rib := NewRIB()
	invalid := &Route{
		Prefix: netip.Prefix{},
		Peer:   Neighbor{Address: netip.MustParseAddr("10.0.0.1"), Kind: PeerEBGP},
	}
	if err := rib.Update(invalid); err == nil {
		t.Fatal("invalid prefix update must fail")
	}

	if err := rib.Apply(Event{
		Kind:  EventUpdate,
		Route: invalid,
	}); err == nil {
		t.Fatal("Apply must surface update errors with index")
	}
}
