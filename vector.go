package dataeng

import (
	"fmt"
	"sort"
	"strings"
)

// Ordering describes the causal relationship between two version vectors.
type Ordering int

const (
	// Equal means the two vectors carry the same causal history.
	Equal Ordering = iota
	// Before means the receiver is causally older; the argument dominates it.
	Before
	// After means the receiver causally dominates the argument.
	After
	// Concurrent means neither vector dominates the other.
	Concurrent
)

// VersionVector is a per-region monotonically increasing counter map.
// It is the sole authority used for merge adjudication; wall-clock
// timestamps never participate in comparison.
//
// The zero value (nil map) is a valid empty vector.
type VersionVector map[string]uint64

// NewVersionVector returns an empty, non-nil version vector.
func NewVersionVector() VersionVector {
	return VersionVector{}
}

func (v VersionVector) clone() VersionVector {
	next := make(VersionVector, len(v))
	for region, counter := range v {
		next[region] = counter
	}
	return next
}

// Inc returns a copy of v with the counter for region incremented by one.
// It panics when region is empty so causal metadata can never be anonymous.
func (v VersionVector) Inc(region string) VersionVector {
	if region == "" {
		panic("dataeng: version vector increment requires a non-empty region id")
	}
	next := v.clone()
	next[region]++
	return next
}

// Merge returns the component-wise maximum of v and other as a new vector.
func (v VersionVector) Merge(other VersionVector) VersionVector {
	next := v.clone()
	for region, counter := range other {
		if counter > next[region] {
			next[region] = counter
		}
	}
	return next
}

// Compare reports how v relates causally to other.
func (v VersionVector) Compare(other VersionVector) Ordering {
	regions := make(map[string]struct{}, len(v)+len(other))
	for region := range v {
		regions[region] = struct{}{}
	}
	for region := range other {
		regions[region] = struct{}{}
	}

	hasGreater, hasLess := false, false
	for region := range regions {
		switch {
		case v[region] > other[region]:
			hasGreater = true
		case v[region] < other[region]:
			hasLess = true
		}
	}

	switch {
	case !hasGreater && !hasLess:
		return Equal
	case hasGreater && !hasLess:
		return After
	case !hasGreater && hasLess:
		return Before
	default:
		return Concurrent
	}
}

// Dominates reports whether v causally dominates other.
func (v VersionVector) Dominates(other VersionVector) bool {
	return v.Compare(other) == After
}

// String renders the vector in deterministic region order, e.g. "eu:2,us:1".
func (v VersionVector) String() string {
	regions := make([]string, 0, len(v))
	for region := range v {
		regions = append(regions, region)
	}
	sort.Strings(regions)

	parts := make([]string, 0, len(regions))
	for _, region := range regions {
		parts = append(parts, fmt.Sprintf("%s:%d", region, v[region]))
	}
	return strings.Join(parts, ",")
}
