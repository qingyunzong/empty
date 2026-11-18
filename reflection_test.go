package formal

import (
	"errors"
	"net/netip"
	"testing"
)

func TestCheckReflectionLoop(t *testing.T) {
	routerID := mustAddr(t, "192.0.2.1")
	clusterA := mustAddr(t, "192.0.2.10")
	clusterB := mustAddr(t, "192.0.2.11")

	route := &Route{
		Peer: Neighbor{Address: mustAddr(t, "10.0.0.2"), Kind: PeerIBGP},
		Attrs: PathAttributes{
			OriginatorID: routerID,
			ClusterList:  []netip.Addr{clusterB},
		},
	}

	if err := CheckReflectionLoop(route, mustAddr(t, "198.51.100.7"), clusterA); err != nil {
		t.Fatalf("unrelated router/cluster must pass: %v", err)
	}
	if err := CheckReflectionLoop(route, routerID, clusterA); !errors.Is(err, ErrOriginatorLoop) {
		t.Fatalf("originator loop expected, got %v", err)
	}
	if err := CheckReflectionLoop(route, mustAddr(t, "198.51.100.7"), clusterB); !errors.Is(err, ErrClusterLoop) {
		t.Fatalf("cluster loop expected, got %v", err)
	}
	if err := CheckReflectionLoop(&Route{Attrs: PathAttributes{}}, routerID, clusterA); err != nil {
		t.Fatalf("route without reflection attributes must pass: %v", err)
	}
}

func TestReflectRoute(t *testing.T) {
	originator := mustAddr(t, "192.0.2.50")
	clusterA := mustAddr(t, "192.0.2.10")
	clusterB := mustAddr(t, "192.0.2.11")

	t.Run("sets originator and prepends cluster without mutating input", func(t *testing.T) {
		original := &Route{
			Peer:  Neighbor{Address: mustAddr(t, "10.0.0.3"), Kind: PeerIBGP},
			Attrs: PathAttributes{ClusterList: []netip.Addr{clusterB}, LocalPref: u32(150)},
		}
		reflected, err := ReflectRoute(original, originator, clusterA)
		if err != nil {
			t.Fatalf("reflect: %v", err)
		}

		if reflected.Attrs.OriginatorID != originator {
			t.Fatalf("originator id = %s", reflected.Attrs.OriginatorID)
		}
		wantClusters := []netip.Addr{clusterA, clusterB}
		if len(reflected.Attrs.ClusterList) != len(wantClusters) {
			t.Fatalf("cluster list = %v", reflected.Attrs.ClusterList)
		}
		for i, want := range wantClusters {
			if reflected.Attrs.ClusterList[i] != want {
				t.Fatalf("cluster[%d] = %s, want %s", i, reflected.Attrs.ClusterList[i], want)
			}
		}
		if len(original.Attrs.ClusterList) != 1 || original.Attrs.OriginatorID.IsValid() {
			t.Fatalf("ReflectRoute mutated the input route: %+v", original.Attrs)
		}
	})

	t.Run("preserves existing originator and defaults EBGP local preference", func(t *testing.T) {
		existingOriginator := mustAddr(t, "198.51.100.5")
		ebgpRoute := &Route{
			Peer:  Neighbor{Address: mustAddr(t, "203.0.113.9"), Kind: PeerEBGP},
			Attrs: PathAttributes{OriginatorID: existingOriginator},
		}
		reflected, err := ReflectRoute(ebgpRoute, originator, clusterA)
		if err != nil {
			t.Fatalf("reflect: %v", err)
		}
		if reflected.Attrs.OriginatorID != existingOriginator {
			t.Fatalf("originator overwritten: %s", reflected.Attrs.OriginatorID)
		}
		if reflected.Attrs.LocalPref == nil || *reflected.Attrs.LocalPref != DefaultLocalPref {
			t.Fatalf("EBGP route missing default LOCAL_PREF: %+v", reflected.Attrs.LocalPref)
		}
		if ebgpRoute.Attrs.LocalPref != nil {
			t.Fatal("input EBGP route was mutated")
		}
	})
}

func TestReflectable(t *testing.T) {
	local := LocalRoute(netip.MustParsePrefix("10.0.0.0/24"), PathAttributes{})
	ebgpLearned := &Route{Peer: Neighbor{Address: mustAddr(t, "203.0.113.1"), Kind: PeerEBGP}}
	clientLearned := &Route{Peer: Neighbor{Address: mustAddr(t, "10.0.0.11"), Kind: PeerIBGP}}
	nonClientLearned := &Route{Peer: Neighbor{Address: mustAddr(t, "10.0.0.12"), Kind: PeerIBGP}}

	ebgpNbr := Neighbor{Address: mustAddr(t, "203.0.113.2"), Kind: PeerEBGP}
	clientNbr := Neighbor{Address: mustAddr(t, "10.0.0.21"), Kind: PeerIBGP}
	nonClientNbr := Neighbor{Address: mustAddr(t, "10.0.0.22"), Kind: PeerIBGP}

	cases := []struct {
		name              string
		route             *Route
		learnedFromClient bool
		neighbor          Neighbor
		neighborIsClient  bool
		want              bool
	}{
		{"local to ibgp", local, false, clientNbr, true, true},
		{"ebgp learned to non-client", ebgpLearned, false, nonClientNbr, false, true},
		{"client learned to non-client", clientLearned, true, nonClientNbr, false, true},
		{"client learned to ebgp", clientLearned, true, ebgpNbr, false, true},
		{"non-client learned to non-client blocked", nonClientLearned, false, nonClientNbr, false, false},
		{"non-client learned to client allowed", nonClientLearned, false, clientNbr, true, true},
		{"non-client learned to ebgp allowed", nonClientLearned, false, ebgpNbr, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Reflectable(tc.route, tc.learnedFromClient, tc.neighbor, tc.neighborIsClient); got != tc.want {
				t.Fatalf("Reflectable = %v, want %v", got, tc.want)
			}
		})
	}
}
