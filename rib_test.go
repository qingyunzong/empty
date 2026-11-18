package formal

import (
	"net/netip"
	"testing"
)

func TestRIBBestWithReasonAndWithdraw(t *testing.T) {
	prefix := netip.MustParsePrefix("10.4.0.0/24")
	peerA := Neighbor{Address: netip.MustParseAddr("172.0.0.1"), Kind: PeerEBGP}
	peerB := Neighbor{Address: netip.MustParseAddr("172.0.0.2"), Kind: PeerEBGP}

	routeA := NewRoute(prefix, peerA, PathAttributes{
		LocalPref: u32(100),
		ASPath:    sequencePath(3),
		Origin:    OriginIGP,
		MED:       u32(20),
	})
	routeB := NewRoute(prefix, peerB, PathAttributes{
		LocalPref: u32(100),
		ASPath:    sequencePath(1),
		Origin:    OriginIncomplete,
		MED:       u32(80),
	})

	rib := NewRIB()
	if best, step := rib.BestWithReason(prefix); best != nil || step != 0 {
		t.Fatalf("empty RIB returned best=%v step=%v", best, step)
	}

	if err := rib.Update(routeA); err != nil {
		t.Fatalf("update A: %v", err)
	}
	if err := rib.Update(routeB); err != nil {
		t.Fatalf("update B: %v", err)
	}

	best, reason := rib.BestWithReason(prefix)
	if best == nil || best.Peer.Address != peerB.Address {
		t.Fatalf("expected peerB best, got %+v", best)
	}
	if reason != StepASPathLength {
		t.Fatalf("expected AS_PATH_LENGTH reason, got %s", reason)
	}

	rib.Withdraw(prefix, peerB)
	best, reason = rib.BestWithReason(prefix)
	if best == nil || best.Peer.Address != peerA.Address {
		t.Fatalf("expected peerA after withdraw, got %+v", best)
	}
	if reason != StepStableKey {
		t.Fatalf("sole survivor must end at stable key, got %s", reason)
	}

	rib.Withdraw(prefix, peerA)
	if best := rib.Best(prefix); best != nil {
		t.Fatalf("expected no route after full withdrawal, got %+v", best)
	}
}

func TestRIBUpdateReplacesAndDefendsSlices(t *testing.T) {
	prefix := netip.MustParsePrefix("10.5.0.0/24")
	peer := Neighbor{Address: netip.MustParseAddr("172.1.1.1"), Kind: PeerEBGP}

	med := uint32(10)
	original := NewRoute(prefix, peer, PathAttributes{
		MED:         &med,
		ASPath:      []ASSegment{{Type: ASSequence, ASes: []uint32{65001}}},
		ClusterList: []netip.Addr{netip.MustParseAddr("192.0.2.10")},
	})
	rib := NewRIB()
	if err := rib.Update(original); err != nil {
		t.Fatalf("update: %v", err)
	}

	// Mutate caller-owned backing arrays; the stored copy must stay intact.
	med = 999
	original.Attrs.ASPath[0].ASes[0] = 11111
	original.Attrs.ClusterList[0] = netip.MustParseAddr("198.51.100.99")

	stored := rib.Best(prefix)
	if stored.Attrs.EffectiveMED() != 10 {
		t.Fatalf("MED aliased through pointer: %d", stored.Attrs.EffectiveMED())
	}
	if stored.Attrs.ASPath[0].ASes[0] != 65001 {
		t.Fatalf("AS_PATH slice aliased: %v", stored.Attrs.ASPath)
	}
	if stored.Attrs.ClusterList[0] != netip.MustParseAddr("192.0.2.10") {
		t.Fatalf("cluster list aliased: %v", stored.Attrs.ClusterList)
	}

	replacement := NewRoute(prefix, peer, PathAttributes{LocalPref: u32(400)})
	if err := rib.Update(replacement); err != nil {
		t.Fatalf("replace: %v", err)
	}
	routes := rib.RoutesFor(prefix)
	if len(routes) != 1 {
		t.Fatalf("replacement created duplicate entry, got %d routes", len(routes))
	}
	if routes[0].Attrs.EffectiveLocalPref() != 400 {
		t.Fatalf("replacement did not take effect")
	}
}

func TestRIBRejectsInvalidInputs(t *testing.T) {
	rib := NewRIB()
	if err := rib.Update(nil); err == nil {
		t.Fatal("nil update must fail")
	}
	invalidPeer := Neighbor{Address: netip.Addr{}, Kind: PeerEBGP}
	if err := rib.Update(NewRoute(netip.MustParsePrefix("10.6.0.0/24"), invalidPeer, PathAttributes{})); err == nil {
		t.Fatal("invalid peer address must fail")
	}
	if err := rib.Apply(Event{Kind: 99}); err == nil {
		t.Fatal("unknown event kind must fail")
	}
	if err := rib.RestoreSnapshot(nil); err == nil {
		t.Fatal("nil snapshot restore must fail")
	}
}
