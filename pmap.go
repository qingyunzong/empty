package preimage

import (
	"errors"
	"fmt"
	"sort"
)

// Piece is one affine branch of a Map, valid on the half-open domain Dom.
type Piece struct {
	Dom Interval
	F   Affine
}

// Map is a piecewise affine map on a finite half-open integer domain.
// Pieces are sorted by Dom.Lo, non-overlapping, and contiguously cover
// the whole domain. Maps are immutable once constructed.
type Map struct {
	dom    Interval
	pieces []Piece
}

// NewMap validates pieces and builds a Map. Pieces must be non-empty,
// non-overlapping, and gap-free after sorting.
func NewMap(pieces []Piece) (Map, error) {
	if len(pieces) == 0 {
		return Map{}, errors.New("preimage: map needs at least one piece")
	}
	ps := make([]Piece, len(pieces))
	copy(ps, pieces)
	for _, p := range ps {
		if p.Dom.Empty() {
			return Map{}, fmt.Errorf("preimage: empty piece domain %v", p.Dom)
		}
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].Dom.Lo < ps[j].Dom.Lo })
	for i := 1; i < len(ps); i++ {
		if ps[i].Dom.Lo != ps[i-1].Dom.Hi {
			return Map{}, fmt.Errorf("preimage: pieces not contiguous at %v and %v",
				ps[i-1].Dom, ps[i].Dom)
		}
	}
	dom := Interval{Lo: ps[0].Dom.Lo, Hi: ps[len(ps)-1].Dom.Hi}
	return Map{dom: dom, pieces: ps}, nil
}

// Domain returns the half-open domain covered by the map.
func (m Map) Domain() Interval { return m.dom }

// Pieces returns a copy of the map pieces in domain order.
func (m Map) Pieces() []Piece {
	out := make([]Piece, len(m.pieces))
	copy(out, m.pieces)
	return out
}

// Eval applies the map to x. The second result is false if x lies
// outside the map domain.
func (m Map) Eval(x int64) (int64, bool) {
	i := sort.Search(len(m.pieces), func(i int) bool { return m.pieces[i].Dom.Hi > x })
	if i >= len(m.pieces) || !m.pieces[i].Dom.Contains(x) {
		return 0, false
	}
	return m.pieces[i].F.Eval(x), true
}

// Preimage returns the canonical set of input intervals whose image under
// the map lies inside the half-open output interval y.
func (m Map) Preimage(y Interval) []Interval {
	if y.Empty() {
		return nil
	}
	var out []Interval
	for _, p := range m.pieces {
		if iv := p.F.preimage(y.Lo, y.Hi, p.Dom); !iv.Empty() {
			out = append(out, iv)
		}
	}
	return Canonicalize(out)
}
