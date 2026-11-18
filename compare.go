package formal

import (
	"cmp"
	"net/netip"
)

// DecisionStep names one rule of the configured best-path decision order.
type DecisionStep uint8

const (
	StepLocalPref DecisionStep = iota + 1
	StepLocalOrigin
	StepASPathLength
	StepOrigin
	StepMED
	StepNeighborAddress
	StepStableKey
)

// String returns the rule's canonical name.
func (s DecisionStep) String() string {
	switch s {
	case StepLocalPref:
		return "LOCAL_PREF"
	case StepLocalOrigin:
		return "LOCAL_ORIGIN"
	case StepASPathLength:
		return "AS_PATH_LENGTH"
	case StepOrigin:
		return "ORIGIN"
	case StepMED:
		return "MULTI_EXIT_DISC"
	case StepNeighborAddress:
		return "NEIGHBOR_ADDRESS"
	case StepStableKey:
		return "STABLE_KEY"
	default:
		return "UNKNOWN"
	}
}

// CompareRoutes applies the configured decision order to two routes. It
// returns a negative number when a is preferred, a positive number when b is
// preferred, and zero only if the routes are indistinguishable under every
// rule. Missing attributes take their documented default values.
func CompareRoutes(a, b *Route) int {
	result, _ := CompareRoutesWithStep(a, b)
	return result
}

// CompareRoutesWithStep behaves like CompareRoutes and additionally reports
// the first decision rule that distinguished the routes. A zero result
// returns StepStableKey to indicate that every rule tied.
func CompareRoutesWithStep(a, b *Route) (int, DecisionStep) {
	if result := cmp.Compare(b.Attrs.EffectiveLocalPref(), a.Attrs.EffectiveLocalPref()); result != 0 {
		return result, StepLocalPref
	}

	if result := cmp.Compare(localOriginRank(a), localOriginRank(b)); result != 0 {
		return result, StepLocalOrigin
	}

	if result := cmp.Compare(a.Attrs.ASPathLength(), b.Attrs.ASPathLength()); result != 0 {
		return result, StepASPathLength
	}

	if result := cmp.Compare(a.Attrs.EffectiveOrigin(), b.Attrs.EffectiveOrigin()); result != 0 {
		return result, StepOrigin
	}

	if result := cmp.Compare(a.Attrs.EffectiveMED(), b.Attrs.EffectiveMED()); result != 0 {
		return result, StepMED
	}

	if result := compareAddr(a.Peer.Address, b.Peer.Address); result != 0 {
		return result, StepNeighborAddress
	}

	return cmp.Compare(a.Attrs.stableKey(a.Peer.Address), b.Attrs.stableKey(b.Peer.Address)), StepStableKey
}

// localOriginRank gives locally originated routes precedence over any route
// learned from a peer.
func localOriginRank(route *Route) int {
	if route.Peer.Kind == PeerLocal {
		return 0
	}
	return 1
}

// compareAddr orders stable neighbor addresses by their raw byte
// representation; the unspecified address (used for local routes) sorts first.
func compareAddr(a, b netip.Addr) int {
	switch {
	case !a.IsValid() && !b.IsValid():
		return 0
	case !a.IsValid():
		return -1
	case !b.IsValid():
		return 1
	}

	a4 := a.Is4()
	b4 := b.Is4()
	if a4 != b4 {
		if a4 {
			return -1
		}
		return 1
	}

	ab := a.As16()
	bb := b.As16()
	for i := range ab {
		if ab[i] != bb[i] {
			return cmp.Compare(ab[i], bb[i])
		}
	}
	return 0
}
