package pieceaffine

import "fmt"

// Piece is one affine piece of a Map. For x in Dom it computes
//
//	f(x) = floor((A*x + B) / C)
//
// where the division rounds toward negative infinity. A may be positive,
// negative (orientation flip) or zero (constant piece); C must be > 0.
type Piece struct {
	Dom Interval `json:"dom"`
	A   int64    `json:"a"`
	B   int64    `json:"b"`
	C   int64    `json:"c"`
}

// value evaluates the piece at x; x must lie in Dom.
func (p Piece) value(x int64) int64 {
	return floorDiv(p.A*x+p.B, p.C)
}

// Map is a piecewise affine map on a bounded half-open integer domain.
// Pieces must partition Dom contiguously, in ascending order.
type Map struct {
	Dom    Interval `json:"dom"`
	Pieces []Piece  `json:"pieces"`
}

// NewMap builds a Map from a half-open domain and its pieces, validating
// that the pieces exactly partition the domain.
func NewMap(dom Interval, pieces ...Piece) (Map, error) {
	m := Map{Dom: dom, Pieces: append([]Piece(nil), pieces...)}
	if err := m.Validate(); err != nil {
		return Map{}, err
	}
	return m, nil
}

// NewAffine builds a single-piece Map f(x) = floor((a*x + b) / c) on dom.
func NewAffine(dom Interval, a, b, c int64) (Map, error) {
	return NewMap(dom, Piece{Dom: dom, A: a, B: b, C: c})
}

// Validate checks domain sanity and that pieces partition Dom contiguously.
func (m Map) Validate() error {
	if m.Dom.Empty() {
		return fmt.Errorf("pieceaffine: empty map domain %v", m.Dom)
	}
	if len(m.Pieces) == 0 {
		return fmt.Errorf("pieceaffine: map has no pieces")
	}
	cursor := m.Dom.Lo
	for i, p := range m.Pieces {
		if p.C <= 0 {
			return fmt.Errorf("pieceaffine: piece %d has non-positive divisor C=%d", i, p.C)
		}
		if p.Dom.Empty() {
			return fmt.Errorf("pieceaffine: piece %d has empty domain %v", i, p.Dom)
		}
		if p.Dom.Lo != cursor {
			return fmt.Errorf("pieceaffine: piece %d starts at %d, expected %d (gap or overlap)", i, p.Dom.Lo, cursor)
		}
		cursor = p.Dom.Hi
	}
	if cursor != m.Dom.Hi {
		return fmt.Errorf("pieceaffine: pieces end at %d, domain ends at %d", cursor, m.Dom.Hi)
	}
	return nil
}

// Eval evaluates the map at x. The second return value is false when x
// lies outside the map domain.
func (m Map) Eval(x int64) (int64, bool) {
	if !m.Dom.Contains(x) {
		return 0, false
	}
	for _, p := range m.Pieces {
		if p.Dom.Contains(x) {
			return p.value(x), true
		}
	}
	return 0, false
}

// Preimage returns the canonical set of input intervals x in Dom such that
// Eval(x) lies in the half-open output interval y.
func (m Map) Preimage(y Interval) []Interval {
	var out []Interval
	for _, p := range m.Pieces {
		out = append(out, preimagePiece(p, y)...)
	}
	return Canonical(out)
}

// PreimageSet returns the canonical preimage of a set of output intervals.
func (m Map) PreimageSet(ys []Interval) []Interval {
	var out []Interval
	for _, y := range ys {
		for _, p := range m.Pieces {
			out = append(out, preimagePiece(p, y)...)
		}
	}
	return Canonical(out)
}

// preimagePiece solves floor((A*x + B)/C) in [y.Lo, y.Hi) for x in p.Dom.
//
// The membership test is exact integer arithmetic:
//
//	y.Lo*C <= A*x + B <= y.Hi*C - 1
//
// which is then solved for x, flipping the inequalities when A < 0.
func preimagePiece(p Piece, y Interval) []Interval {
	if y.Empty() || p.Dom.Empty() {
		return nil
	}
	if p.A == 0 {
		if y.Contains(floorDiv(p.B, p.C)) {
			return []Interval{p.Dom}
		}
		return nil
	}
	lo := y.Lo*p.C - p.B     // A*x >= lo
	hi := y.Hi*p.C - 1 - p.B // A*x <= hi
	var xLo, xHi int64
	if p.A > 0 {
		xLo = ceilDiv(lo, p.A)
		xHi = floorDiv(hi, p.A)
	} else {
		// Dividing by a negative coefficient flips the inequalities.
		xLo = ceilDiv(hi, p.A)
		xHi = floorDiv(lo, p.A)
	}
	iv := intersect(p.Dom, Interval{Lo: xLo, Hi: xHi + 1})
	if iv.Empty() {
		return nil
	}
	return []Interval{iv}
}
