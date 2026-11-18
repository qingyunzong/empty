package formal

import "net/netip"

// PeerKind classifies the adjacency over which a route was learned.
type PeerKind uint8

const (
	// PeerIBGP marks a route learned from an internal BGP peer.
	PeerIBGP PeerKind = iota
	// PeerEBGP marks a route learned from an external BGP peer.
	PeerEBGP
	// PeerLocal marks a route locally originated (network/redistribution).
	PeerLocal
)

// Neighbor is a stable BGP adjacency identified by its transport address.
type Neighbor struct {
	Address netip.Addr
	Kind    PeerKind
	// RouterID optionally identifies the remote BGP router. It is stored for
	// callers but does not participate in the configured decision order.
	RouterID uint32
}

// LocalNeighbor builds the canonical neighbor used for locally originated
// routes. Its address is the unspecified address and compares deterministically
// ahead of any real peer address in the neighbor-address tie-break.
func LocalNeighbor() Neighbor {
	return Neighbor{Address: netip.Addr{}, Kind: PeerLocal}
}
