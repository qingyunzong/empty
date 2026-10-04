// Package circcov tracks coverage of a circle by angular sectors and
// finds the longest circular segment covered by at least k sectors.
//
// Encoding rules:
//
//   - Angles are integer units. A circle has exactly n units, addressed
//     0..n-1; any angle passed in is normalized into that range (mod n).
//   - Every sector is half-open [start, end): it covers the units
//     start, start+1, ..., end-1 and never covers its end unit.
//   - A sector whose normalized end is numerically smaller than its
//     start crosses angle zero and is stored split into the two
//     half-open intervals [start, n) and [0, end).
//   - The full circle is encoded separately (AddFull / Segment.Full);
//     it is never represented as [x, x). A sector with equal normalized
//     endpoints is rejected with ErrDegenerate.
package circcov

import (
	"errors"
	"sort"
)

// Angle is an integer angular unit on the circle.
type Angle = int64

// ErrDegenerate is returned by Add when the normalized start and end are
// equal, which would be ambiguous between an empty sector and the full
// circle. Use AddFull for the full circle.
var ErrDegenerate = errors.New("circcov: degenerate sector (start == end); use AddFull for the full circle")

// Segment is a half-open circular arc [Start, End). If Full is true the
// segment is the whole circle and Start/End are meaningless.
type Segment struct {
	Start Angle
	End   Angle // exclusive
	Full  bool
}

// Len returns the segment length in angular units.
func (s Segment) Len(n Angle) Angle {
	if s.Full {
		return n
	}
	return (s.End - s.Start + n) % n
}

type sector struct {
	full  bool
	parts [][2]Angle // 1 or 2 disjoint half-open intervals inside [0, n)
}

// Cover tracks a set of sectors on a circle of n angular units.
type Cover struct {
	n       Angle
	sectors map[int]sector
	next    int
}

// New returns a Cover for a circle of n angular units. n must be positive.
func New(n Angle) *Cover {
	if n <= 0 {
		panic("circcov: circle size must be positive")
	}
	return &Cover{n: n, sectors: make(map[int]sector)}
}

// Size returns the number of live sectors.
func (c *Cover) Size() int { return len(c.sectors) }

func (c *Cover) norm(a Angle) Angle {
	a %= c.n
	if a < 0 {
		a += c.n
	}
	return a
}

// Add inserts the half-open sector [start, end). Angles are normalized
// mod n; if the normalized end is smaller than the start the sector
// crosses angle zero and is split internally. It returns the sector id,
// or ErrDegenerate if the normalized endpoints are equal.
func (c *Cover) Add(start, end Angle) (int, error) {
	s, e := c.norm(start), c.norm(end)
	if s == e {
		return 0, ErrDegenerate
	}
	sec := sector{}
	if s < e {
		sec.parts = [][2]Angle{{s, e}}
	} else {
		sec.parts = [][2]Angle{{s, c.n}, {0, e}}
	}
	id := c.next
	c.next++
	c.sectors[id] = sec
	return id, nil
}

// AddFull inserts a sector covering the whole circle and returns its id.
func (c *Cover) AddFull() int {
	id := c.next
	c.next++
	c.sectors[id] = sector{full: true}
	return id
}

// Remove deletes the sector with the given id. It reports whether the
// id existed.
func (c *Cover) Remove(id int) bool {
	if _, ok := c.sectors[id]; !ok {
		return false
	}
	delete(c.sectors, id)
	return true
}

// MaxCovered returns the longest circular segment whose every unit is
// covered by at least k sectors, together with the source set: the ids
// of the sectors that cover the returned segment in full. ok is false
// when no unit reaches coverage k. Ties between equally long segments
// are broken by the smallest start angle. If k <= 0 the whole circle
// trivially qualifies and a full segment is returned.
func (c *Cover) MaxCovered(k int) (seg Segment, sources []int, ok bool) {
	if k <= 0 {
		seg = Segment{Full: true}
		return seg, c.sourceIDs(seg), true
	}

	diff := make(map[Angle]int)
	base := 0
	for _, sec := range c.sectors {
		if sec.full {
			base++
			continue
		}
		for _, p := range sec.parts {
			diff[p[0]]++
			if p[1] < c.n {
				diff[p[1]]--
			}
		}
	}
	if len(diff) == 0 {
		if base >= k {
			seg = Segment{Full: true}
			return seg, c.sourceIDs(seg), true
		}
		return Segment{}, nil, false
	}

	pts := make([]Angle, 0, len(diff))
	for p := range diff {
		pts = append(pts, p)
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i] < pts[j] })

	// Elementary arcs: arc i is [pts[i], pts[(i+1)%m]) circularly, so the
	// last arc wraps through angle zero. Coverage is constant on each arc.
	m := len(pts)
	cov := make([]int, m)
	run := base
	for i, p := range pts {
		run += diff[p]
		cov[i] = run
	}

	all := true
	for _, v := range cov {
		if v < k {
			all = false
			break
		}
	}
	if all {
		seg = Segment{Full: true}
		return seg, c.sourceIDs(seg), true
	}

	// Longest circular run of arcs with coverage >= k. Runs can only
	// start right after an arc below k, which also yields the
	// smallest-start tie-break for free.
	bestLen := Angle(0)
	bestStart, bestArcs := -1, 0
	for i := 0; i < m; i++ {
		if cov[i] < k || cov[(i-1+m)%m] >= k {
			continue
		}
		l := 0
		for l < m && cov[(i+l)%m] >= k {
			l++
		}
		length := (pts[(i+l)%m] - pts[i] + c.n) % c.n
		if length > bestLen || (length == bestLen && (bestStart < 0 || pts[i] < pts[bestStart])) {
			bestLen, bestStart, bestArcs = length, i, l
		}
	}
	if bestStart < 0 {
		return Segment{}, nil, false
	}
	seg = Segment{Start: pts[bestStart], End: pts[(bestStart+bestArcs)%m]}
	return seg, c.sourceIDs(seg), true
}

// sourceIDs returns the sorted ids of all sectors that cover seg in full.
func (c *Cover) sourceIDs(seg Segment) []int {
	var parts [][2]Angle
	if !seg.Full {
		if seg.End > seg.Start {
			parts = [][2]Angle{{seg.Start, seg.End}}
		} else {
			parts = [][2]Angle{{seg.Start, c.n}}
			if seg.End > 0 {
				parts = append(parts, [2]Angle{0, seg.End})
			}
		}
	}
	ids := []int{}
	for id, sec := range c.sectors {
		if sec.full {
			ids = append(ids, id)
			continue
		}
		if seg.Full {
			continue
		}
		covers := true
		for _, lp := range parts {
			if !contained(sec.parts, lp) {
				covers = false
				break
			}
		}
		if covers {
			ids = append(ids, id)
		}
	}
	sort.Ints(ids)
	return ids
}

// contained reports whether the half-open interval lp is contained in a
// single component of the disjoint interval set outer.
func contained(outer [][2]Angle, lp [2]Angle) bool {
	for _, p := range outer {
		if p[0] <= lp[0] && lp[1] <= p[1] {
			return true
		}
	}
	return false
}
