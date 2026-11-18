package formal

import "net/netip"

// Route is one candidate path for a prefix, paired with the adjacency that
// advertised it.
type Route struct {
	Prefix   netip.Prefix
	Peer     Neighbor
	Attrs    PathAttributes
	Received int64
}

// NewRoute constructs a route for prefix from peer with the given attributes.
func NewRoute(prefix netip.Prefix, peer Neighbor, attrs PathAttributes) *Route {
	return &Route{
		Prefix: prefix,
		Peer:   peer,
		Attrs:  attrs,
	}
}

// LocalRoute constructs a locally originated route using LocalNeighbor.
func LocalRoute(prefix netip.Prefix, attrs PathAttributes) *Route {
	return NewRoute(prefix, LocalNeighbor(), attrs)
}

// clone returns a deep enough copy so RIB updates cannot alias caller-owned
// slices or pointers.
func (r *Route) clone() *Route {
	if r == nil {
		return nil
	}
	copyRoute := *r
	if r.Attrs.LocalPref != nil {
		localPref := *r.Attrs.LocalPref
		copyRoute.Attrs.LocalPref = &localPref
	}
	if r.Attrs.MED != nil {
		med := *r.Attrs.MED
		copyRoute.Attrs.MED = &med
	}
	if r.Attrs.ASPath != nil {
		copyRoute.Attrs.ASPath = append([]ASSegment(nil), r.Attrs.ASPath...)
		for i := range copyRoute.Attrs.ASPath {
			copyRoute.Attrs.ASPath[i].ASes = append(
				[]uint32(nil), r.Attrs.ASPath[i].ASes...)
		}
	}
	if r.Attrs.ClusterList != nil {
		copyRoute.Attrs.ClusterList = append(
			[]netip.Addr(nil), r.Attrs.ClusterList...)
	}
	return &copyRoute
}
