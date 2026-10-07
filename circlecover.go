// Package circlecover tracks sectors on a discretized circle and finds the
// longest arc covered by at least k sectors.
//
// Angle model:
//   - The circle is divided into mod integer units, numbered 0..mod-1
//     counterclockwise. Unit p is the half-open slice [p, p+1).
//   - A sector is the half-open arc [start, end) traversed counterclockwise:
//     it contains start and does NOT contain end (closed-open rule).
//   - If end <= start the arc crosses angle zero and is internally split
//     into [start, mod) and [0, end).
//   - start == end is rejected as degenerate; a full circle is encoded
//     separately via AddFull, never as a zero-length arc.
package circlecover

import (
	"errors"
	"fmt"
	"sort"
)

// ID identifies a sector within a Cover. IDs are never reused.
type ID int

// Sector is an arc on the circle. If Full is true the sector covers every
// unit and Start/End are meaningless. Otherwise it is the half-open arc
// [Start, End) counterclockwise, wrapping across zero when End < Start.
type Sector struct {
	Full  bool
	Start int64
	End   int64
}

// Segment is the result of MaxSegment: a longest arc whose every unit is
// covered by at least k sectors, together with the source sectors that
// contribute coverage to it.
//
// For a non-full segment the arc is [Start, End) counterclockwise; End may
// be smaller than Start when the arc wraps across zero. Length is always
// the number of covered units, i.e. (End-Start+mod)%mod.
//
// Sources lists the IDs of all sectors that cover at least one unit of the
// segment, sorted ascending. At every unit of the segment at least k of the
// sources overlap.
type Segment struct {
	Full    bool
	Start   int64
	End     int64
	Length  int64
	Sources []ID
}

// ErrDegenerate is returned by Add when start == end. A zero-length arc is
// ambiguous with a full circle, which must be encoded via AddFull instead.
var ErrDegenerate = errors.New("circlecover: start must differ from end; use AddFull for a full circle")

// Cover is a set of sectors on a circle of mod integer units.
type Cover struct {
	mod   int64
	seq   ID
	sects map[ID]Sector
}

// New creates an empty Cover on a circle of mod units. mod must be >= 2.
func New(mod int64) (*Cover, error) {
	if mod < 2 {
		return nil, fmt.Errorf("circlecover: modulus must be >= 2, got %d", mod)
	}
	return &Cover{mod: mod, sects: make(map[ID]Sector)}, nil
}

// Mod returns the number of integer units per revolution.
func (c *Cover) Mod() int64 { return c.mod }

// Add inserts the half-open arc [start, end) traversed counterclockwise.
// Both endpoints must lie in [0, mod) and differ; when end < start the arc
// crosses angle zero. It returns the new sector's ID.
func (c *Cover) Add(start, end int64) (ID, error) {
	if start < 0 || start >= c.mod || end < 0 || end >= c.mod {
		return 0, fmt.Errorf("circlecover: endpoints must be in [0, %d), got (%d, %d)", c.mod, start, end)
	}
	if start == end {
		return 0, ErrDegenerate
	}
	return c.put(Sector{Start: start, End: end}), nil
}

// AddFull inserts a sector covering the whole circle. The full circle is
// encoded separately from arcs and never results from Add.
func (c *Cover) AddFull() ID {
	return c.put(Sector{Full: true})
}

func (c *Cover) put(s Sector) ID {
	c.seq++
	c.sects[c.seq] = s
	return c.seq
}

// Remove deletes the sector with the given ID, reporting whether it existed.
func (c *Cover) Remove(id ID) bool {
	if _, ok := c.sects[id]; ok {
		delete(c.sects, id)
		return true
	}
	return false
}

// Len returns the number of sectors currently stored.
func (c *Cover) Len() int { return len(c.sects) }

// pieces splits s into non-wrapping half-open intervals on [0, mod).
// This is the explicit zero-crossing split: an arc with End < Start becomes
// [Start, mod) and [0, End).
func (c *Cover) pieces(s Sector) [][2]int64 {
	if s.Full {
		return [][2]int64{{0, c.mod}}
	}
	if s.Start < s.End {
		return [][2]int64{{s.Start, s.End}}
	}
	return [][2]int64{{s.Start, c.mod}, {0, s.End}}
}

// contains reports whether unit p lies in sector s (closed-open rule).
func (c *Cover) contains(s Sector, p int64) bool {
	if s.Full {
		return p >= 0 && p < c.mod
	}
	if s.Start < s.End {
		return p >= s.Start && p < s.End
	}
	return p >= s.Start || p < s.End
}

// CoverageAt returns how many sectors cover unit p.
func (c *Cover) CoverageAt(p int64) (int, error) {
	if p < 0 || p >= c.mod {
		return 0, fmt.Errorf("circlecover: unit %d out of range [0, %d)", p, c.mod)
	}
	n := 0
	for _, s := range c.sects {
		if c.contains(s, p) {
			n++
		}
	}
	return n, nil
}

// MaxSegment finds a longest arc whose every unit is covered by at least
// k sectors (k must be >= 1) and reports it together with its source set.
//
// The arc is maximal: it cannot be extended in either direction without
// dropping below k coverage. Qualifying runs adjacent across angle zero are
// merged, so the result may wrap (End < Start). If every unit of the circle
// qualifies, the result has Full set and Length == mod.
//
// Ties in length are broken by the smallest Start. The second return value
// is false when no unit reaches coverage k (or k < 1).
func (c *Cover) MaxSegment(k int) (Segment, bool) {
	if k < 1 {
		return Segment{}, false
	}

	// Difference array over event positions; full sectors raise the base
	// coverage everywhere. A decrement at mod never applies to any unit and
	// is omitted.
	diff := make(map[int64]int)
	base := 0
	for _, s := range c.sects {
		if s.Full {
			base++
			continue
		}
		for _, pc := range c.pieces(s) {
			diff[pc[0]]++
			if pc[1] < c.mod {
				diff[pc[1]]--
			}
		}
	}
	keys := make([]int64, 0, len(diff))
	for p := range diff {
		keys = append(keys, p)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })

	// Sweep constant-coverage runs and keep those reaching k.
	type run struct{ a, b int64 } // half-open [a, b) on [0, mod]
	var runs []run
	cur := base
	pos := int64(0)
	for _, key := range keys {
		if key > pos && cur >= k {
			runs = append(runs, run{pos, key})
		}
		cur += diff[key]
		pos = key
	}
	if pos < c.mod && cur >= k {
		runs = append(runs, run{pos, c.mod})
	}
	if len(runs) == 0 {
		return Segment{}, false
	}

	// Merge adjacent qualifying runs: coverage may change at an event while
	// staying >= k, so consecutive runs can be contiguous.
	merged := runs[:0]
	for _, r := range runs {
		if n := len(merged); n > 0 && merged[n-1].b == r.a {
			merged[n-1].b = r.b
			continue
		}
		merged = append(merged, r)
	}
	runs = merged

	// Whole circle qualifies: encode it as the separate full-circle segment.
	if len(runs) == 1 && runs[0].a == 0 && runs[0].b == c.mod {
		return Segment{Full: true, Length: c.mod, Sources: c.sources(true, 0, 0)}, true
	}

	// Merge runs adjacent across angle zero into a wrapping candidate.
	type cand struct {
		start, end int64 // arc [start, end) counterclockwise, may wrap
		length     int64
	}
	var cands []cand
	if len(runs) >= 2 && runs[0].a == 0 && runs[len(runs)-1].b == c.mod {
		last := runs[len(runs)-1]
		first := runs[0]
		cands = append(cands, cand{last.a, first.b, (c.mod - last.a) + first.b})
		runs = runs[1 : len(runs)-1]
	}
	for _, r := range runs {
		cands = append(cands, cand{r.a, r.b, r.b - r.a})
	}

	best := cands[0]
	for _, cd := range cands[1:] {
		if cd.length > best.length || (cd.length == best.length && cd.start < best.start) {
			best = cd
		}
	}
	return Segment{
		Start:   best.start,
		End:     best.end,
		Length:  best.length,
		Sources: c.sources(false, best.start, best.end),
	}, true
}

// sources lists the IDs of sectors covering at least one unit of the arc
// [start, end) (or of the whole circle when full is set), sorted ascending.
func (c *Cover) sources(full bool, start, end int64) []ID {
	var target [][2]int64
	if full {
		target = [][2]int64{{0, c.mod}}
	} else {
		target = c.pieces(Sector{Start: start, End: end})
	}
	var ids []ID
	for id, s := range c.sects {
		if intersects(c.pieces(s), target) {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// intersects reports whether two sets of half-open linear intervals share
// at least one integer unit.
func intersects(a, b [][2]int64) bool {
	for _, x := range a {
		for _, y := range b {
			if max(x[0], y[0]) < min(x[1], y[1]) {
				return true
			}
		}
	}
	return false
}
