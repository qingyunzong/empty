package formal

import (
	"fmt"
	"net/netip"
	"strings"
)

// Origin is the BGP ORIGIN attribute value. Lower values win best-path
// selection in the canonical order IGP < EGP < INCOMPLETE.
type Origin uint8

const (
	OriginIGP Origin = iota
	OriginEGP
	OriginIncomplete
)

// ASSegmentType distinguishes AS_SEQUENCE and AS_SET path segments.
type ASSegmentType uint8

const (
	ASSequence ASSegmentType = iota + 1
	ASSet
)

// ASSegment is one segment of an AS_PATH attribute.
type ASSegment struct {
	Type ASSegmentType
	ASes []uint32
}

// Default values applied when a well-known attribute is absent.
const (
	// DefaultLocalPref is the LOCAL_PREF used when the attribute is missing
	// (RFC 4271 section 5.1.5 recommends 100).
	DefaultLocalPref uint32 = 100
	// DefaultMED is the MULTI_EXIT_DISC used when the attribute is missing.
	DefaultMED uint32 = 0
)

// PathAttributes holds the BGP path attributes participating in best-path
// selection. Pointer fields distinguish "absent" from an explicit zero value.
type PathAttributes struct {
	LocalPref    *uint32
	ASPath       []ASSegment
	Origin       Origin
	MED          *uint32
	OriginatorID netip.Addr
	ClusterList  []netip.Addr
}

// EffectiveLocalPref returns the explicit LOCAL_PREF or DefaultLocalPref.
func (p PathAttributes) EffectiveLocalPref() uint32 {
	if p.LocalPref != nil {
		return *p.LocalPref
	}
	return DefaultLocalPref
}

// EffectiveMED returns the explicit MED or DefaultMED.
func (p PathAttributes) EffectiveMED() uint32 {
	if p.MED != nil {
		return *p.MED
	}
	return DefaultMED
}

// EffectiveOrigin returns the ORIGIN value, treating an unset attribute as
// IGP and any out-of-range encoding as INCOMPLETE.
func (p PathAttributes) EffectiveOrigin() Origin {
	if p.Origin > OriginIncomplete {
		return OriginIncomplete
	}
	return p.Origin
}

// ASPathLength is the AS_PATH length used by the path-length decision step.
// Every AS number in an AS_SEQUENCE segment counts individually; a non-empty
// AS_SET segment counts as one regardless of its member count.
func (p PathAttributes) ASPathLength() int {
	total := 0
	for _, segment := range p.ASPath {
		if len(segment.ASes) == 0 {
			continue
		}
		if segment.Type == ASSet {
			total++
			continue
		}
		total += len(segment.ASes)
	}
	return total
}

// stableKey is a deterministic last-resort ordering key. RIB-level selection
// never needs it because a RIB holds at most one route per (prefix, peer),
// but it keeps Compare a total order for standalone callers.
func (p PathAttributes) stableKey(peer netip.Addr) string {
	var b strings.Builder
	fmt.Fprintf(&b, "lp=%d asn=%d origin=%d med=%d orig=%s peer=%s",
		p.EffectiveLocalPref(),
		p.ASPathLength(),
		p.EffectiveOrigin(),
		p.EffectiveMED(),
		addrKey(p.OriginatorID),
		addrKey(peer),
	)
	for _, cluster := range p.ClusterList {
		b.WriteByte(' ')
		b.WriteString(addrKey(cluster))
	}
	return b.String()
}

func addrKey(addr netip.Addr) string {
	if !addr.IsValid() {
		return "invalid"
	}
	return addr.String()
}
