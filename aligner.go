package statmatch

import (
	"fmt"
	"math/big"
	"sort"
)

// Side identifies one of the two series.
type Side int

const (
	SideA Side = iota
	SideB
)

// Aligner maintains two point series under a rational maximum gap.
// Every insertion or removal re-runs the one-to-one minimum-difference
// matching and updates the running statistics incrementally; a changed
// matching therefore always recomputes the correlation.
type Aligner struct {
	maxGap *big.Rat
	a, b   map[string]Point
	pairs  []Pair
	sums   *Sums
}

// NewAligner returns an empty Aligner with the given rational maximum
// matching gap.
func NewAligner(maxGap *big.Rat) *Aligner {
	return &Aligner{
		maxGap: new(big.Rat).Set(maxGap),
		a:      make(map[string]Point),
		b:      make(map[string]Point),
		sums:   NewSums(),
	}
}

// AddPoint inserts a point into the chosen series and re-matches.
func (al *Aligner) AddPoint(side Side, p Point) error {
	if p.T == nil {
		return fmt.Errorf("statmatch: point %q has nil time", p.ID)
	}
	m := al.series(side)
	if _, ok := m[p.ID]; ok {
		return fmt.Errorf("statmatch: duplicate point ID %q", p.ID)
	}
	if len(m) >= MaxPoints {
		return fmt.Errorf("statmatch: series already holds the maximum of %d points", MaxPoints)
	}
	m[p.ID] = p
	al.recompute()
	return nil
}

// RemovePoint deletes a point by ID from the chosen series and
// re-matches.
func (al *Aligner) RemovePoint(side Side, id string) error {
	m := al.series(side)
	if _, ok := m[id]; !ok {
		return fmt.Errorf("statmatch: unknown point ID %q", id)
	}
	delete(m, id)
	al.recompute()
	return nil
}

func (al *Aligner) series(side Side) map[string]Point {
	if side == SideB {
		return al.b
	}
	return al.a
}

func sortedPoints(m map[string]Point) []Point {
	ps := make([]Point, 0, len(m))
	for _, p := range m {
		ps = append(ps, p)
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].ID < ps[j].ID })
	return ps
}

// recompute re-runs the matching and applies only the pair-level delta
// to the running sums.
func (al *Aligner) recompute() {
	next := Match(sortedPoints(al.a), sortedPoints(al.b), al.maxGap)
	old := make(map[[2]string]Pair, len(al.pairs))
	for _, p := range al.pairs {
		old[[2]string{p.A.ID, p.B.ID}] = p
	}
	keep := make(map[[2]string]bool, len(next))
	for _, p := range next {
		k := [2]string{p.A.ID, p.B.ID}
		keep[k] = true
		if _, ok := old[k]; !ok {
			al.sums.AddPair(p.A.V, p.B.V)
		}
	}
	for k, p := range old {
		if !keep[k] {
			al.sums.SubPair(p.A.V, p.B.V)
		}
	}
	al.pairs = next
}

// Pairs returns the current matching in (difference, A ID, B ID) order.
func (al *Aligner) Pairs() []Pair {
	return append([]Pair(nil), al.pairs...)
}

// Sums returns a copy of the running power sums.
func (al *Aligner) Sums() *Sums {
	return al.sums.Clone()
}

// Stats returns the current exact statistics.
func (al *Aligner) Stats() Stats {
	return al.sums.Stats()
}

// Points returns both series sorted by ID.
func (al *Aligner) Points() (a, b []Point) {
	return sortedPoints(al.a), sortedPoints(al.b)
}
