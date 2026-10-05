// Package raster rasterizes integer directed closed loops into rows of
// pixel spans, using either the non-zero winding rule or the even-odd rule.
//
// Geometry model:
//   - Loop vertices have integer coordinates; a loop is closed implicitly
//     (an edge connects the last vertex back to the first).
//   - Pixel (x, y) is the unit square [x, x+1) x [y, y+1); its sample point
//     is the pixel center (x+0.5, y+0.5). A pixel is filled iff its center
//     is inside the loops under the chosen fill rule.
//   - Holes are expressed as additional loops: with NonZero a hole loop must
//     wind opposite to its shell; with EvenOdd orientation is irrelevant.
//
// Edge rules (the "special rules" that make the fill well defined):
//   - Horizontal edges never produce ray crossings. They are skipped
//     entirely; the fill state across them is determined by the
//     non-horizontal edges alone.
//   - Each non-horizontal edge owns the half-open y-interval
//     [min(y0,y1), max(y0,y1)): it includes its lower endpoint and excludes
//     its upper endpoint. A vertex shared by two edges is therefore counted
//     exactly once (by the edge for which it is the lower endpoint), never
//     twice; a local extremum is counted 0 or 2 times, preserving parity.
//   - A pixel center lying exactly on an edge is resolved by a strict
//     comparison: the ray starting at that point does not count the
//     crossing at its own origin.
//
// All predicates are evaluated with exact integer arithmetic (coordinates
// are scaled by 2 so pixel centers become odd integers). Vertex coordinates
// must satisfy |v| <= 1<<30 so that the 128-bit products used internally
// cannot overflow.
package raster

import (
	"math/bits"
	"sort"
)

// Point is an integer vertex.
type Point struct {
	X, Y int
}

// Loop is a directed closed polyline. The edge from the last vertex back to
// the first is implicit. Loops with fewer than 2 distinct points contribute
// nothing.
type Loop []Point

// Polygon is a shell loop together with hole loops, a convenience wrapper
// around the loop list accepted by Fill and Contains.
type Polygon struct {
	Shell Loop
	Holes []Loop
}

// Loops returns the shell followed by the holes as a single loop list.
func (p Polygon) Loops() []Loop {
	loops := make([]Loop, 0, 1+len(p.Holes))
	loops = append(loops, p.Shell)
	return append(loops, p.Holes...)
}

// FillRule selects the inside test.
type FillRule int

const (
	// NonZero fills pixels whose winding number is non-zero.
	NonZero FillRule = iota
	// EvenOdd fills pixels crossed an odd number of times from outside.
	EvenOdd
)

func (r FillRule) inside(w int64) bool {
	if r == EvenOdd {
		return w&1 != 0
	}
	return w != 0
}

// Span is one horizontal run of filled pixels on row Y: pixels
// (X0, Y) .. (X1, Y) inclusive.
type Span struct {
	Y      int
	X0, X1 int
}

// edge is a non-horizontal loop edge in doubled coordinates.
type edge struct {
	x0, y0, x1, y1 int64
}

// edges extracts the non-horizontal edges of all loops, scaled by 2.
// Horizontal and zero-length edges are dropped here (they never cross a
// scanline at half-integer height).
func edges(loops []Loop) []edge {
	var es []edge
	for _, l := range loops {
		n := len(l)
		for i := 0; i < n; i++ {
			a, b := l[i], l[(i+1)%n]
			if a.Y == b.Y {
				continue // horizontal or degenerate edge: no crossings
			}
			es = append(es, edge{
				x0: 2 * int64(a.X), y0: 2 * int64(a.Y),
				x1: 2 * int64(b.X), y1: 2 * int64(b.Y),
			})
		}
	}
	return es
}

// crossing is the intersection of one edge with one scanline, stored as the
// exact rational doubled x-coordinate num/den (den > 0) plus the winding
// delta (+1 upward, -1 downward).
type crossing struct {
	num, den int64
	delta    int64
}

// mul128 returns the signed 128-bit product a*b as (hi, lo).
func mul128(a, b int64) (int64, uint64) {
	hi, lo := bits.Mul64(uint64(a), uint64(b))
	if a < 0 {
		hi -= uint64(b)
	}
	if b < 0 {
		hi -= uint64(a)
	}
	return int64(hi), lo
}

// cmpFrac compares n1/d1 with n2/d2 (d1, d2 > 0) exactly and returns
// -1, 0 or +1.
func cmpFrac(n1, d1, n2, d2 int64) int {
	h1, l1 := mul128(n1, d2)
	h2, l2 := mul128(n2, d1)
	switch {
	case h1 != h2:
		if h1 < h2 {
			return -1
		}
		return 1
	case l1 != l2:
		if l1 < l2 {
			return -1
		}
		return 1
	}
	return 0
}

// divFloor returns floor(n/d) for d > 0.
func divFloor(n, d int64) int64 {
	if n >= 0 {
		return n / d
	}
	return -((-n + d - 1) / d)
}

// divCeil returns ceil(n/d) for d > 0.
func divCeil(n, d int64) int64 {
	if n >= 0 {
		return (n + d - 1) / d
	}
	return -((-n) / d)
}

// ceilOdd returns the smallest odd integer >= num/den (den > 0).
func ceilOdd(num, den int64) int64 {
	c := divCeil(num, den)
	if c%2 == 0 {
		c++
	}
	return c
}

// floorOddBelow returns the largest odd integer strictly below num/den
// (den > 0).
func floorOddBelow(num, den int64) int64 {
	f := divFloor(num, den)
	if num == f*den {
		f-- // strict: exclude the boundary value itself
	}
	if f%2 == 0 {
		f--
	}
	return f
}

// Fill rasterizes the given loops (shells and holes in any mix) and
// returns the filled pixel spans, ordered by row and then by X0. Rows with
// no filled pixels are omitted.
func Fill(loops []Loop, rule FillRule) []Span {
	es := edges(loops)
	if len(es) == 0 {
		return nil
	}
	minY, maxY := es[0].y0, es[0].y0
	for _, e := range es {
		if e.y0 < minY {
			minY = e.y0
		}
		if e.y1 < minY {
			minY = e.y1
		}
		if e.y0 > maxY {
			maxY = e.y0
		}
		if e.y1 > maxY {
			maxY = e.y1
		}
	}
	// Pixel rows whose center cy = 2*Y+1 lies in [minY, maxY].
	yLo := minY / 2
	yHi := maxY/2 - 1

	var spans []Span
	for Y := yLo; Y <= yHi; Y++ {
		cy := 2*int64(Y) + 1
		var cr []crossing
		for _, e := range es {
			// Half-open y-interval: include the lower endpoint, exclude
			// the upper one, so shared vertices count exactly once.
			if (e.y0 <= cy) == (e.y1 <= cy) {
				continue
			}
			dy := e.y1 - e.y0
			num := e.x0*dy + (cy-e.y0)*(e.x1-e.x0)
			den := dy
			delta := int64(1)
			if den < 0 {
				num, den = -num, -den
				delta = -1
			}
			cr = append(cr, crossing{num: num, den: den, delta: delta})
		}
		if len(cr) == 0 {
			continue
		}
		sort.Slice(cr, func(i, j int) bool {
			return cmpFrac(cr[i].num, cr[i].den, cr[j].num, cr[j].den) < 0
		})
		// Sweep left to right. w is the winding accumulated over all
		// crossings at positions <= the current pixel center; because the
		// crossings of closed loops sum to zero, the inside test on w is
		// equivalent to the ray-casting test used by Contains, including
		// at pixel centers that lie exactly on a crossing.
		var w int64
		for i := 0; i < len(cr); {
			j := i
			for j < len(cr) && cmpFrac(cr[i].num, cr[i].den, cr[j].num, cr[j].den) == 0 {
				w += cr[j].delta
				j++
			}
			// Inside state w applies to pixel centers cx with
			// cr[i] <= cx < cr[j] (cx = 2*x+1, an odd integer).
			if rule.inside(w) && j < len(cr) {
				lo := ceilOdd(cr[i].num, cr[i].den)
				hi := floorOddBelow(cr[j].num, cr[j].den)
				if lo <= hi {
					x0, x1 := int((lo-1)/2), int((hi-1)/2)
					if n := len(spans); n > 0 && spans[n-1].Y == int(Y) && spans[n-1].X1+1 == x0 {
						spans[n-1].X1 = x1 // merge contiguous runs
					} else {
						spans = append(spans, Span{Y: int(Y), X0: x0, X1: x1})
					}
				}
			}
			i = j
		}
	}
	return spans
}

// Contains reports whether the center of pixel (px, py) is inside the loops
// under the given fill rule. It is a direct per-pixel exact ray-casting
// evaluation and serves as the reference model for Fill.
func Contains(loops []Loop, rule FillRule, px, py int) bool {
	cx := 2*int64(px) + 1
	cy := 2*int64(py) + 1
	var w int64
	for _, e := range edges(loops) {
		if (e.y0 <= cy) == (e.y1 <= cy) {
			continue
		}
		dy := e.y1 - e.y0
		// Sign of (xint - cx) where xint is the crossing x; computed as
		// num/den without division.
		num := (e.x0-cx)*dy + (cy-e.y0)*(e.x1-e.x0)
		if num == 0 {
			continue // ray origin exactly on the edge: not counted
		}
		if (num > 0) == (dy > 0) {
			if dy > 0 {
				w++
			} else {
				w--
			}
		}
	}
	return rule.inside(w)
}
