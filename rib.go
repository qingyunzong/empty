package formal

import (
	"errors"
	"fmt"
	"net/netip"
	"sort"
)

// EventKind selects between a route update and a route withdrawal.
type EventKind uint8

const (
	EventUpdate EventKind = iota + 1
	EventWithdraw
)

// Event is one RIB mutation, enabling interleaved update/withdraw streams
// used to exercise convergence.
type Event struct {
	Kind   EventKind
	Prefix netip.Prefix
	Peer   Neighbor
	// Route is required for EventUpdate and ignored for EventWithdraw.
	Route *Route
}

// RIB is a per-prefix Adj-RIB-In keyed by the advertising neighbor. All
// decision results are recomputed from scratch, so the outcome of any event
// sequence depends only on the surviving routes and never on event order.
type RIB struct {
	routes map[netip.Prefix]map[netip.Addr]*Route
}

// NewRIB returns an empty route information base.
func NewRIB() *RIB {
	return &RIB{routes: make(map[netip.Prefix]map[netip.Addr]*Route)}
}

// Update inserts or replaces the route advertised by its peer for its prefix.
func (r *RIB) Update(route *Route) error {
	if route == nil {
		return errors.New("formal: cannot update nil route")
	}
	if !route.Prefix.IsValid() {
		return errors.New("formal: route has invalid prefix")
	}
	if !route.Peer.Address.IsValid() && route.Peer.Kind != PeerLocal {
		return errors.New("formal: route peer has invalid address")
	}

	peers, ok := r.routes[route.Prefix]
	if !ok {
		peers = make(map[netip.Addr]*Route)
		r.routes[route.Prefix] = peers
	}
	peers[route.Peer.Address] = route.clone()
	return nil
}

// Withdraw removes the route that peer currently holds for prefix. A missing
// entry is a no-op and reports no error.
func (r *RIB) Withdraw(prefix netip.Prefix, peer Neighbor) {
	peers, ok := r.routes[prefix]
	if !ok {
		return
	}
	delete(peers, peer.Address)
	if len(peers) == 0 {
		delete(r.routes, prefix)
	}
}

// Best returns the selected route for prefix, or nil when no candidate
// remains.
func (r *RIB) Best(prefix netip.Prefix) *Route {
	best, _ := r.BestWithReason(prefix)
	return best
}

// BestWithReason returns the selected route and the first decision rule that
// distinguished it from the remaining candidates. It returns (nil, 0) for a
// prefix with no route.
func (r *RIB) BestWithReason(prefix netip.Prefix) (*Route, DecisionStep) {
	peers, ok := r.routes[prefix]
	if !ok || len(peers) == 0 {
		return nil, 0
	}

	var best *Route
	reason := StepStableKey
	for _, candidate := range peers {
		if best == nil {
			best = candidate
			continue
		}
		result, step := CompareRoutesWithStep(candidate, best)
		if result < 0 {
			best = candidate
			reason = step
		}
	}
	return best.clone(), reason
}

// Prefixes returns every prefix holding at least one route in sorted order.
func (r *RIB) Prefixes() []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(r.routes))
	for prefix, peers := range r.routes {
		if len(peers) > 0 {
			prefixes = append(prefixes, prefix)
		}
	}
	sortPrefixes(prefixes)
	return prefixes
}

// RoutesFor returns all candidate routes for prefix in deterministic order,
// sorted by the same total order used by best-path selection.
func (r *RIB) RoutesFor(prefix netip.Prefix) []*Route {
	peers, ok := r.routes[prefix]
	if !ok {
		return nil
	}
	routes := make([]*Route, 0, len(peers))
	for _, route := range peers {
		routes = append(routes, route.clone())
	}
	sort.Slice(routes, func(i, j int) bool {
		return CompareRoutes(routes[i], routes[j]) < 0
	})
	return routes
}

// Snapshot returns a point-in-time copy of the RIB that shares no mutable
// state with the original.
func (r *RIB) Snapshot() *RIB {
	snapshot := NewRIB()
	for prefix, peers := range r.routes {
		copied := make(map[netip.Addr]*Route, len(peers))
		for address, route := range peers {
			copied[address] = route.clone()
		}
		snapshot.routes[prefix] = copied
	}
	return snapshot
}

// RestoreSnapshot replaces the RIB contents with an independent copy of
// snapshot.
func (r *RIB) RestoreSnapshot(snapshot *RIB) error {
	if snapshot == nil {
		return errors.New("formal: cannot restore nil snapshot")
	}
	restored := snapshot.Snapshot()
	r.routes = restored.routes
	return nil
}

// Apply replays a sequence of interleaved updates and withdrawals. It stops
// at the first invalid event and returns its zero-based index.
func (r *RIB) Apply(events ...Event) error {
	for i, event := range events {
		switch event.Kind {
		case EventUpdate:
			if err := r.Update(event.Route); err != nil {
				return fmt.Errorf("formal: event %d update failed: %w", i, err)
			}
		case EventWithdraw:
			r.Withdraw(event.Prefix, event.Peer)
		default:
			return fmt.Errorf("formal: event %d has unknown kind %d", i, event.Kind)
		}
	}
	return nil
}

// recompute re-selects every prefix. Selection is already derived from
// current map state, so this is an explicit verification entry point for
// convergence tests and returns the best route per prefix.
func (r *RIB) recompute() map[netip.Prefix]*Route {
	selected := make(map[netip.Prefix]*Route, len(r.routes))
	for prefix := range r.routes {
		if best := r.Best(prefix); best != nil {
			selected[prefix] = best
		}
	}
	return selected
}

func sortPrefixes(prefixes []netip.Prefix) {
	sort.Slice(prefixes, func(i, j int) bool {
		if prefixes[i].Addr().Is4() != prefixes[j].Addr().Is4() {
			return prefixes[i].Addr().Is4()
		}
		left := prefixes[i].Addr().As16()
		right := prefixes[j].Addr().As16()
		for k := range left {
			if left[k] != right[k] {
				return left[k] < right[k]
			}
		}
		return prefixes[i].Bits() < prefixes[j].Bits()
	})
}
