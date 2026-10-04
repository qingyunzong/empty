package tsfill

import (
	"math/big"
	"sort"
)

// Series is an incrementally maintained time series. The zero value is
// not usable; construct one with New.
type Series struct {
	m       int64
	idx     []int64            // observed indices, sorted ascending
	vals    map[int64]*big.Rat // observed values
	emitted map[int64]*big.Rat // currently emitted series (observed + filled)
}

// New returns an empty Series that fills internal missing segments of
// length at most m.
func New(m int64) *Series {
	return &Series{
		m:       m,
		vals:    map[int64]*big.Rat{},
		emitted: map[int64]*big.Rat{},
	}
}

// Add inserts a sample at index, or replaces the value of an existing
// sample. It returns the delta to the emitted series: previously
// emitted points that are retracted and new points that are added.
// The input value is copied and may be reused by the caller.
func (s *Series) Add(index int64, value *big.Rat) Delta {
	pos := sort.Search(len(s.idx), func(i int) bool { return s.idx[i] >= index })
	exists := pos < len(s.idx) && s.idx[pos] == index

	// Nearest observed neighbours of index, before the update.
	var lo, hi int64
	hasLo, hasHi := false, false
	if pos > 0 {
		lo, hasLo = s.idx[pos-1], true
	}
	if (!exists && pos < len(s.idx)) || (exists && pos+1 < len(s.idx)) {
		if exists {
			hi = s.idx[pos+1]
		} else {
			hi = s.idx[pos]
		}
		hasHi = true
	}

	// The update can only affect emitted points in the open interval
	// (lo, hi): fills are anchored at the nearest observed neighbours.
	before := s.regionEmitted(lo, hasLo, hi, hasHi, index, exists)

	value = new(big.Rat).Set(value)
	if exists {
		s.vals[index] = value
	} else {
		s.idx = append(s.idx, 0)
		copy(s.idx[pos+1:], s.idx[pos:])
		s.idx[pos] = index
		s.vals[index] = value
	}

	after := s.regionEmitted(lo, hasLo, hi, hasHi, index, true)

	delta := diff(before, after)
	s.apply(delta)
	return delta
}

// regionEmitted computes the emitted points inside the open interval
// (lo, hi), given that index is observed iff indexObserved. lo and hi
// themselves are excluded. Missing neighbours mean the interval is
// unbounded on that side, where nothing is ever emitted (leading or
// trailing missing indices are not filled).
func (s *Series) regionEmitted(lo int64, hasLo bool, hi int64, hasHi bool, index int64, indexObserved bool) map[int64]*big.Rat {
	out := map[int64]*big.Rat{}
	var anchors []int64
	if hasLo {
		anchors = append(anchors, lo)
	}
	if indexObserved {
		anchors = append(anchors, index)
		out[index] = s.vals[index]
	}
	if hasHi {
		anchors = append(anchors, hi)
	}
	for i := 0; i+1 < len(anchors); i++ {
		a, b := anchors[i], anchors[i+1]
		if b-a-1 <= s.m {
			for k := a + 1; k < b; k++ {
				out[k] = interp(s.vals[a], s.vals[b], a, b, k)
			}
		}
	}
	return out
}

// diff computes the delta turning the emitted points before into after.
func diff(before, after map[int64]*big.Rat) Delta {
	var d Delta
	for k, ov := range before {
		if nv, ok := after[k]; !ok || nv.Cmp(ov) != 0 {
			d.Retracted = append(d.Retracted, Point{k, ov})
		}
	}
	for k, nv := range after {
		if ov, ok := before[k]; !ok || ov.Cmp(nv) != 0 {
			d.Added = append(d.Added, Point{k, nv})
		}
	}
	sortPoints(d.Retracted)
	sortPoints(d.Added)
	return d
}

// apply folds a delta into the maintained emitted series.
func (s *Series) apply(d Delta) {
	for _, p := range d.Retracted {
		delete(s.emitted, p.Index)
	}
	for _, p := range d.Added {
		s.emitted[p.Index] = p.Value
	}
}

// Emitted returns the full currently emitted series, sorted by index.
func (s *Series) Emitted() []Point {
	out := make([]Point, 0, len(s.emitted))
	for i, v := range s.emitted {
		out = append(out, Point{i, new(big.Rat).Set(v)})
	}
	sortPoints(out)
	return out
}

func sortPoints(p []Point) {
	sort.Slice(p, func(i, j int) bool { return p[i].Index < p[j].Index })
}
