package formal

import (
	"math/rand/v2"
	"net/netip"
	"sort"
	"testing"
)

// referenceRoute keeps only the decision-relevant fields and recomputes
// defaults independently from the library under test.
type referenceRoute struct {
	id         int
	peer       netip.Addr
	local      bool
	localPref  uint32
	hasLP      bool
	pathLength int
	origin     Origin
	med        uint32
	hasMED     bool
}

func referenceEffectiveLP(rr referenceRoute) uint32 {
	if rr.hasLP {
		return rr.localPref
	}
	return 100
}

func referenceEffectiveMED(rr referenceRoute) uint32 {
	if rr.hasMED {
		return rr.med
	}
	return 0
}

// referenceCompare is a literal, rule-by-rule reimplementation of the
// documented decision order.
func referenceCompare(a, b referenceRoute) int {
	if lpA, lpB := referenceEffectiveLP(a), referenceEffectiveLP(b); lpA != lpB {
		if lpA > lpB {
			return -1
		}
		return 1
	}

	if a.local != b.local {
		if a.local {
			return -1
		}
		return 1
	}

	if a.pathLength != b.pathLength {
		if a.pathLength < b.pathLength {
			return -1
		}
		return 1
	}

	if a.origin != b.origin {
		if a.origin < b.origin {
			return -1
		}
		return 1
	}

	if medA, medB := referenceEffectiveMED(a), referenceEffectiveMED(b); medA != medB {
		if medA < medB {
			return -1
		}
		return 1
	}

	if cmp := compareAddr(a.peer, b.peer); cmp != 0 {
		return cmp
	}

	// A RIB holds one route per peer, so equal peers describe the same
	// effective route and must compare exactly equal.
	return 0
}

func TestExhaustiveAttributeSpace(t *testing.T) {
	localPrefs := []*uint32{nil, u32(50), u32(100), u32(200)}
	pathLengths := []int{0, 1, 2, 3}
	origins := []Origin{OriginIGP, OriginEGP, OriginIncomplete}
	meds := []*uint32{nil, u32(0), u32(100), u32(4294967295)}
	addresses := make([]netip.Addr, 12)
	for i := range addresses {
		addresses[i] = netip.AddrFrom4([4]byte{10, byte(i / 254), 0, byte(i + 1)})
	}

	prefix := netip.MustParsePrefix("172.16.0.0/24")
	var libraryRoutes []*Route
	var referenceRoutes []referenceRoute
	id := 0

	for addrIndex, addr := range addresses {
		for _, lp := range localPrefs {
			for _, length := range pathLengths {
				for _, origin := range origins {
					for _, med := range meds {
						kind := PeerEBGP
						reference := referenceRoute{
							id:         id,
							peer:       addr,
							pathLength: length,
							origin:     origin,
							hasMED:     med != nil,
							hasLP:      lp != nil,
						}
						if lp != nil {
							reference.localPref = *lp
						}
						if med != nil {
							reference.med = *med
						}

						attrs := PathAttributes{
							LocalPref: lp,
							ASPath:    sequencePath(length),
							Origin:    origin,
							MED:       med,
						}
						// One peer contributes local routes; its address is
						// unique so address ordering stays clean.
						if addrIndex == len(addresses)-1 && length == 0 && origin == OriginIGP {
							kind = PeerLocal
							reference.local = true
						}
						libraryRoutes = append(libraryRoutes, NewRoute(prefix,
							Neighbor{Address: addr, Kind: kind}, attrs))
						referenceRoutes = append(referenceRoutes, reference)
						id++
					}
				}
			}
		}
	}

	t.Run("every pairwise comparison matches the reference", func(t *testing.T) {
		for i := range libraryRoutes {
			for j := range libraryRoutes {
				got := CompareRoutes(libraryRoutes[i], libraryRoutes[j])
				want := referenceCompare(referenceRoutes[i], referenceRoutes[j])
				if sign(got) != sign(want) {
					t.Fatalf("pair (%d,%d): library=%d reference=%d", i, j, got, want)
				}
			}
		}
	})

	t.Run("RIB winner matches reference on focused subsets", func(t *testing.T) {
		// Ten focused routes spanning every rule: enumerate all 1024 subsets.
		focused := pickFocusedRoutes(t, libraryRoutes, referenceRoutes, 10)
		for mask := 1; mask < 1<<len(focused); mask++ {
			rib := NewRIB()
			var refs []referenceRoute
			for bit, item := range focused {
				if mask&(1<<bit) == 0 {
					continue
				}
				if err := rib.Update(item.library); err != nil {
					t.Fatalf("update: %v", err)
				}
				refs = append(refs, item.reference)
			}

			sort.Slice(refs, func(i, j int) bool {
				return referenceCompare(refs[i], refs[j]) < 0
			})
			best := rib.Best(prefix)
			if best == nil || best.Peer.Address != refs[0].peer {
				t.Fatalf("mask %b: winner mismatch", mask)
			}
		}
	})

	t.Run("RIB winner matches reference on random subsets and orderings", func(t *testing.T) {
		rng := rand.New(rand.NewPCG(0x1234abcd, 0x9e3779b9))
		for trial := 0; trial < 300; trial++ {
			rib := NewRIB()
			order := rng.Perm(len(libraryRoutes))
			// RIB updates replace by peer, so mirror that with a peer-keyed map.
			refsByPeer := make(map[netip.Addr]referenceRoute)
			for _, index := range order {
				if rng.IntN(2) == 0 {
					continue
				}
				if err := rib.Update(libraryRoutes[index]); err != nil {
					t.Fatalf("update: %v", err)
				}
				refsByPeer[referenceRoutes[index].peer] = referenceRoutes[index]
			}
			refs := make([]referenceRoute, 0, len(refsByPeer))
			for _, ref := range refsByPeer {
				refs = append(refs, ref)
			}
			if len(refs) == 0 {
				if rib.Best(prefix) != nil {
					t.Fatal("empty RIB must have no best route")
				}
				continue
			}
			sort.Slice(refs, func(i, j int) bool {
				return referenceCompare(refs[i], refs[j]) < 0
			})
			best := rib.Best(prefix)
			if best == nil || best.Peer.Address != refs[0].peer {
				t.Fatalf("trial %d: winner mismatch", trial)
			}
		}
	})
}

type focusedRoute struct {
	library   *Route
	reference referenceRoute
}

func pickFocusedRoutes(t *testing.T, libraryRoutes []*Route, referenceRoutes []referenceRoute, count int) []focusedRoute {
	t.Helper()
	if len(libraryRoutes) < count {
		t.Fatalf("not enough routes: %d", len(libraryRoutes))
	}
	// Deterministic spread across the attribute space, using unique peers so
	// every subset is a valid RIB state.
	picked := make([]focusedRoute, 0, count)
	seenPeers := make(map[netip.Addr]bool)
	step := len(libraryRoutes) / count
	for i := 0; len(picked) < count && i < len(libraryRoutes); i += step {
		if seenPeers[libraryRoutes[i].Peer.Address] {
			continue
		}
		seenPeers[libraryRoutes[i].Peer.Address] = true
		picked = append(picked, focusedRoute{
			library:   libraryRoutes[i],
			reference: referenceRoutes[i],
		})
	}
	if len(picked) != count {
		t.Fatalf("only picked %d unique-peer routes", len(picked))
	}
	return picked
}

func sign(v int) int {
	switch {
	case v < 0:
		return -1
	case v > 0:
		return 1
	default:
		return 0
	}
}
