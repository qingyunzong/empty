package pieceaffine

import "testing"

func mustMap(t *testing.T, dom Interval, pieces ...Piece) Map {
	t.Helper()
	m, err := NewMap(dom, pieces...)
	if err != nil {
		t.Fatalf("NewMap(%v): %v", dom, err)
	}
	return m
}

// bruteMapPreimage is the value-by-value reference: it enumerates every
// input of the (short) domain and keeps those whose image lands in y.
func bruteMapPreimage(m Map, y Interval) []Interval {
	var out []Interval
	for x := m.Dom.Lo; x < m.Dom.Hi; x++ {
		if v, ok := m.Eval(x); ok && y.Contains(v) {
			out = append(out, Interval{Lo: x, Hi: x + 1})
		}
	}
	return Canonical(out)
}

// bruteChainPreimage is the direct composite reference: it enumerates the
// chain input domain and evaluates the full composition per value.
func bruteChainPreimage(c *Chain, y Interval) []Interval {
	var out []Interval
	dom := c.Layers[0].Dom
	for x := dom.Lo; x < dom.Hi; x++ {
		if v, ok := c.Eval(x); ok && y.Contains(v) {
			out = append(out, Interval{Lo: x, Hi: x + 1})
		}
	}
	return Canonical(out)
}

func equalIntervals(a, b []Interval) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
