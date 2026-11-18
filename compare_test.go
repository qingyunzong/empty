package formal

import (
	"net/netip"
	"testing"
)

func u32(v uint32) *uint32 { return &v }

func mustAddr(t *testing.T, value string) netip.Addr {
	t.Helper()
	addr, err := netip.ParseAddr(value)
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return addr
}

func testRoute(peer string, attrs PathAttributes) *Route {
	return &Route{
		Prefix: netip.MustParsePrefix("10.0.0.0/24"),
		Peer:   Neighbor{Address: netip.MustParseAddr(peer), Kind: PeerEBGP},
		Attrs:  attrs,
	}
}

func TestCompareDecisionOrder(t *testing.T) {
	prefix := netip.MustParsePrefix("10.0.0.0/24")

	t.Run("higher local preference wins regardless of later attributes", func(t *testing.T) {
		weak := NewRoute(prefix, Neighbor{Address: netip.MustParseAddr("1.1.1.1"), Kind: PeerEBGP}, PathAttributes{
			LocalPref: u32(200),
			ASPath:    []ASSegment{{Type: ASSequence, ASes: []uint32{65001, 65002}}},
			Origin:    OriginIGP,
			MED:       u32(0),
		})
		strong := NewRoute(prefix, Neighbor{Address: netip.MustParseAddr("2.2.2.2"), Kind: PeerEBGP}, PathAttributes{
			LocalPref: u32(300),
			ASPath:    []ASSegment{{Type: ASSequence, ASes: []uint32{65001, 65002, 65003}}},
			Origin:    OriginIncomplete,
			MED:       u32(900),
		})
		assertPreferred(t, strong, weak, StepLocalPref)
	})

	t.Run("local origin outranks learned route on equal local preference", func(t *testing.T) {
		local := LocalRoute(prefix, PathAttributes{
			LocalPref: u32(100),
			ASPath:    []ASSegment{{Type: ASSequence, ASes: []uint32{65001}}},
			Origin:    OriginIncomplete,
		})
		learned := NewRoute(prefix, Neighbor{Address: netip.MustParseAddr("10.0.0.9"), Kind: PeerEBGP}, PathAttributes{
			LocalPref: u32(100),
			ASPath:    []ASSegment{{Type: ASSequence, ASes: []uint32{65001}}},
			Origin:    OriginIGP,
		})
		assertPreferred(t, local, learned, StepLocalOrigin)
	})

	t.Run("shorter AS path wins", func(t *testing.T) {
		short := testRoute("1.1.1.1", PathAttributes{
			ASPath: []ASSegment{{Type: ASSequence, ASes: []uint32{65001}}},
			Origin: OriginIncomplete,
			MED:    u32(999),
		})
		long := testRoute("2.2.2.2", PathAttributes{
			ASPath: []ASSegment{{Type: ASSequence, ASes: []uint32{65001, 65002}}},
			Origin: OriginIGP,
			MED:    u32(1),
		})
		assertPreferred(t, short, long, StepASPathLength)
	})

	t.Run("AS_SET counts as one", func(t *testing.T) {
		setRoute := testRoute("1.1.1.1", PathAttributes{
			ASPath: []ASSegment{
				{Type: ASSequence, ASes: []uint32{65001}},
				{Type: ASSet, ASes: []uint32{65002, 65003, 65004}},
			},
		})
		sequenceRoute := testRoute("2.2.2.2", PathAttributes{
			ASPath: []ASSegment{
				{Type: ASSequence, ASes: []uint32{65001, 65009}},
			},
		})
		if setRoute.Attrs.ASPathLength() != 2 || sequenceRoute.Attrs.ASPathLength() != 2 {
			t.Fatal("both paths must report length 2")
		}
		if _, step := CompareRoutesWithStep(setRoute, sequenceRoute); step == StepASPathLength {
			t.Fatal("AS_PATH_LENGTH must not distinguish equal-length paths")
		}
	})

	t.Run("origin IGP beats EGP beats incomplete", func(t *testing.T) {
		igp := testRoute("1.1.1.1", PathAttributes{Origin: OriginIGP})
		egp := testRoute("2.2.2.2", PathAttributes{Origin: OriginEGP})
		incomplete := testRoute("3.3.3.3", PathAttributes{Origin: OriginIncomplete})
		assertPreferred(t, igp, egp, StepOrigin)
		assertPreferred(t, egp, incomplete, StepOrigin)
		assertPreferred(t, igp, incomplete, StepOrigin)
	})

	t.Run("lower MED wins", func(t *testing.T) {
		low := testRoute("1.1.1.1", PathAttributes{Origin: OriginIGP, MED: u32(10)})
		high := testRoute("2.2.2.2", PathAttributes{Origin: OriginIGP, MED: u32(20)})
		assertPreferred(t, low, high, StepMED)
	})

	t.Run("missing attributes take documented defaults", func(t *testing.T) {
		peer := "1.1.1.1"
		defaults := testRoute(peer, PathAttributes{})
		explicit := testRoute(peer, PathAttributes{
			LocalPref: u32(DefaultLocalPref),
			Origin:    OriginIGP,
			MED:       u32(DefaultMED),
		})
		result, step := CompareRoutesWithStep(defaults, explicit)
		if result != 0 {
			t.Fatalf("defaults must tie explicit default values, got %d at %s", result, step)
		}
		if step != StepStableKey {
			t.Fatalf("expected all rules to tie, got %s", step)
		}
	})

	t.Run("neighbor address breaks full attribute tie", func(t *testing.T) {
		lowAddress := testRoute("10.0.0.1", PathAttributes{Origin: OriginIGP, MED: u32(5)})
		highAddress := testRoute("10.0.0.2", PathAttributes{Origin: OriginIGP, MED: u32(5)})
		assertPreferred(t, lowAddress, highAddress, StepNeighborAddress)

		v6 := testRoute("2001:db8::1", PathAttributes{Origin: OriginIGP, MED: u32(5)})
		assertPreferred(t, lowAddress, v6, StepNeighborAddress)
	})

	t.Run("local unspecified address precedes real peer addresses", func(t *testing.T) {
		local := LocalRoute(prefix, PathAttributes{
			LocalPref: u32(100),
			ASPath:    []ASSegment{{Type: ASSequence, ASes: []uint32{65001}}},
			Origin:    OriginIGP,
			MED:       u32(7),
		})
		peerRoute := testRoute("10.0.0.1", PathAttributes{
			LocalPref: u32(100),
			ASPath:    []ASSegment{{Type: ASSequence, ASes: []uint32{65001}}},
			Origin:    OriginIGP,
			MED:       u32(7),
		})
		// Peer kinds differ first, so force equal kind by comparing only the
		// address rule through two IBGP peers.
		local.Peer.Kind = PeerIBGP
		assertPreferred(t, local, peerRoute, StepNeighborAddress)
	})
}

func assertPreferred(t *testing.T, preferred, other *Route, wantStep DecisionStep) {
	t.Helper()
	result, step := CompareRoutesWithStep(preferred, other)
	if result >= 0 {
		t.Fatalf("expected preferred route to win, result=%d step=%s", result, step)
	}
	if step != wantStep {
		t.Fatalf("expected decision at %s, got %s", wantStep, step)
	}
	reverse, reverseStep := CompareRoutesWithStep(other, preferred)
	if reverse <= 0 || reverseStep != wantStep {
		t.Fatalf("reverse comparison inconsistent: result=%d step=%s", reverse, reverseStep)
	}
}

func TestCompareIsTotalOrder(t *testing.T) {
	prefix := netip.MustParsePrefix("10.1.0.0/24")
	addresses := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}
	localPrefs := []*uint32{nil, u32(50), u32(100)}
	pathLengths := []int{0, 1, 2}
	origins := []Origin{OriginIGP, OriginEGP, OriginIncomplete}
	meds := []*uint32{nil, u32(0), u32(42)}

	type key struct {
		address string
		lp      uint32
		length  int
		origin  Origin
		med     uint32
	}
	equivalence := make(map[key][]*Route)
	var routes []*Route
	for _, address := range addresses {
		for _, lp := range localPrefs {
			for _, length := range pathLengths {
				for _, origin := range origins {
					for _, med := range meds {
						route := NewRoute(prefix,
							Neighbor{Address: netip.MustParseAddr(address), Kind: PeerEBGP},
							PathAttributes{
								LocalPref: lp,
								ASPath:    sequencePath(length),
								Origin:    origin,
								MED:       med,
							})
						routes = append(routes, route)
						k := key{
							address: address,
							lp:      route.Attrs.EffectiveLocalPref(),
							length:  length,
							origin:  origin,
							med:     route.Attrs.EffectiveMED(),
						}
						equivalence[k] = append(equivalence[k], route)
					}
				}
			}
		}
	}

	// Routes differing only in attribute encoding (absent vs. explicit
	// default) are the same equivalence class and compare equal.
	for _, members := range equivalence {
		for _, a := range members {
			for _, b := range members {
				if CompareRoutes(a, b) != 0 {
					t.Fatalf("equivalent routes did not tie: %v vs %v", a, b)
				}
			}
		}
	}

	// Distinct effective states form an antisymmetric, transitive order.
	for i, a := range routes {
		for j := i + 1; j < len(routes); j++ {
			b := routes[j]
			left := CompareRoutes(a, b)
			right := CompareRoutes(b, a)
			if (left == 0) != (right == 0) {
				t.Fatalf("routes %d/%d inconsistent equality: %d vs %d", i, j, left, right)
			}
			if left != 0 && (left < 0) == (right < 0) {
				t.Fatalf("routes %d/%d violate antisymmetry: %d vs %d", i, j, left, right)
			}
		}
	}

	for i, a := range routes {
		for j, b := range routes {
			for k, c := range routes {
				if CompareRoutes(a, b) <= 0 && CompareRoutes(b, c) <= 0 && CompareRoutes(a, c) > 0 {
					t.Fatalf("transitivity violated at %d,%d,%d", i, j, k)
				}
			}
		}
	}
}

func sequencePath(length int) []ASSegment {
	if length == 0 {
		return nil
	}
	ases := make([]uint32, length)
	for i := range ases {
		ases[i] = uint32(65000 + i)
	}
	return []ASSegment{{Type: ASSequence, ASes: ases}}
}
