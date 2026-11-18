package formal

import (
	"errors"
	"net/netip"
)

// Reflection loop errors.
var (
	ErrOriginatorLoop = errors.New("formal: route reflected back to its originator")
	ErrClusterLoop    = errors.New("formal: route reflected back to a route reflector cluster")
)

// CheckReflectionLoop rejects a reflected route when RFC 4456 loop-prevention
// attributes indicate it has returned to a cluster or router it belongs to.
// An absent ORIGINATOR_ID and empty CLUSTER_LIST mean no loop is present.
func CheckReflectionLoop(route *Route, localRouterID netip.Addr, localClusterID netip.Addr) error {
	if route.Attrs.OriginatorID.IsValid() &&
		localRouterID.IsValid() &&
		route.Attrs.OriginatorID == localRouterID {
		return ErrOriginatorLoop
	}

	if localClusterID.IsValid() {
		for _, cluster := range route.Attrs.ClusterList {
			if cluster == localClusterID {
				return ErrClusterLoop
			}
		}
	}
	return nil
}

// ReflectRoute applies an RR's outbound attribute changes to a route that is
// being reflected to IBGP client or non-client peers:
//
//   - ORIGINATOR_ID is set only when absent, preserving the original speaker.
//   - localClusterID is prepended to CLUSTER_LIST when configured.
//
// The input route is not modified; a cloned route is returned. EBGP-learned
// routes also receive the standard LOCAL_PREF default when none is present.
func ReflectRoute(route *Route, originator netip.Addr, localClusterID netip.Addr) (*Route, error) {
	if route == nil {
		return nil, errors.New("formal: cannot reflect nil route")
	}
	reflected := route.clone()

	if !reflected.Attrs.OriginatorID.IsValid() && originator.IsValid() {
		reflected.Attrs.OriginatorID = originator
	}

	if localClusterID.IsValid() {
		reflected.Attrs.ClusterList = append(
			[]netip.Addr{localClusterID}, reflected.Attrs.ClusterList...)
	}

	if reflected.Peer.Kind == PeerEBGP && reflected.Attrs.LocalPref == nil {
		localPref := DefaultLocalPref
		reflected.Attrs.LocalPref = &localPref
	}

	return reflected, nil
}

// Reflectable reports whether route should be advertised to neighbor under
// RFC 4456 route-reflector propagation rules. learnedFromClient records
// whether the route's IBGP originator is a client of this reflector:
//
//   - Locally originated and EBGP-learned routes go to every peer.
//   - A client-learned route goes to clients, non-clients and EBGP peers.
//   - A non-client IBGP-learned route goes only to clients and EBGP peers.
func Reflectable(route *Route, learnedFromClient bool, neighbor Neighbor, neighborIsClient bool) bool {
	if route == nil {
		return false
	}

	if neighbor.Kind == PeerEBGP || route.Peer.Kind == PeerLocal || route.Peer.Kind == PeerEBGP {
		return true
	}

	return learnedFromClient || neighborIsClient
}
