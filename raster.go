// Package raster converts integer directed closed loops into filled pixel
// rows. Pixel (x, y) covers the unit square [x, x+1) x [y, y+1); its center
// is (x+1/2, y+1/2). A pixel is filled when its center is inside the loops
// under the chosen fill rule; a center lying exactly on an edge counts as
// inside.
//
// Scanlines run at half-integer y, so they never pass through integer
// vertices: a shared vertex can never be counted twice, and every
// non-horizontal edge contributes at most one crossing per row. Horizontal
// edges (y1 == y2) lie on integer y and never intersect a scanline, so they
// are excluded from crossing computation entirely.
//
// All crossing arithmetic is exact rational arithmetic on int64. Coordinates
// should stay well within int32 range so intermediate products
// (O(coord * height^2)) cannot overflow int64.
package raster

import "sort"

// Point is an integer vertex of a loop.
type Point struct{ X, Y int }

// FillRule selects the interior test.
type FillRule int

const (
	// NonZero fills pixels whose winding number is non-zero. Hole loops
	// must wind opposite to their outer loop.
	NonZero FillRule = iota
	// EvenOdd fills pixels whose crossing count is odd. Orientation is
	// irrelevant; any loop nested inside another becomes a hole.
	EvenOdd
)

// Span is an inclusive run of pixels [X0, X1] on one row.
type Span struct{ X0, X1 int }

// Row lists the filled spans of pixel row Y.
type Row struct {
	Y     int
	Spans []Span
}

// edge is a non-horizontal directed loop edge.
type edge struct{ x1, y1, x2, y2 int64 }

// crossing is the intersection of one edge with one scanline.
// x = num/den with den > 0; wind is +1 for upward edges, -1 for downward.
type crossing struct {
	num, den int64
	wind     int
}

// Fill rasterizes the given closed loops (each loop is implicitly closed
// from its last vertex back to its first) and returns the filled rows in
// increasing Y order, each with sorted, merged, inclusive spans.
func Fill(loops [][]Point, rule FillRule) []Row {
	var edges []edge
	minY, maxY := int64(0), int64(0)
	for _, loop := range loops {
		n := len(loop)
		for i := 0; i < n; i++ {
			a, b := loop[i], loop[(i+1)%n]
			if a.Y == b.Y {
				continue // horizontal edge: never crosses a scanline
			}
			e := edge{int64(a.X), int64(a.Y), int64(b.X), int64(b.Y)}
			edges = append(edges, e)
			lo, hi := minMax(e.y1, e.y2)
			if len(edges) == 1 || lo < minY {
				minY = lo
			}
			if len(edges) == 1 || hi > maxY {
				maxY = hi
			}
		}
	}
	if len(edges) == 0 {
		return nil
	}

	var rows []Row
	for y := minY; y < maxY; y++ {
		// Scanline cy = y + 1/2. Edge straddles it iff min(y1,y2) <= y
		// and max(y1,y2) >= y+1 (half-open in y, so a vertex shared by
		// two edges is never double counted).
		var xs []crossing
		for _, e := range edges {
			lo, hi := minMax(e.y1, e.y2)
			if lo > y || hi < y+1 {
				continue
			}
			dy := e.y2 - e.y1
			dx := e.x2 - e.x1
			// crossX = x1 + (cy - y1) * dx/dy, with 2*cy = 2y+1:
			num := 2*e.x1*dy + (2*y+1-2*e.y1)*dx
			den := 2 * dy
			wind := 1
			if den < 0 {
				num, den = -num, -den
				wind = -1
			}
			xs = append(xs, crossing{num, den, wind})
		}
		if len(xs) == 0 {
			continue
		}
		sort.Slice(xs, func(i, j int) bool {
			return xs[i].num*xs[j].den < xs[j].num*xs[i].den
		})

		var spans []Span
		winding, parity := 0, 0
		inside := false
		var start crossing
		for _, c := range xs {
			if inside {
				spans = appendSpan(spans, start, c)
			}
			winding += c.wind
			parity ^= 1
			if rule == NonZero {
				inside = winding != 0
			} else {
				inside = parity != 0
			}
			if inside {
				start = c
			}
		}
		if len(spans) > 0 {
			rows = append(rows, Row{Y: int(y), Spans: spans})
		}
	}
	return rows
}

// appendSpan converts the interval [a, b] between two crossings into the
// span of pixel centers a <= x+1/2 <= b (inclusive: a center exactly on an
// edge is inside) and merges it with the previous span when contiguous.
func appendSpan(spans []Span, a, b crossing) []Span {
	x0 := ceilHalf(a.num, a.den)
	x1 := floorHalf(b.num, b.den)
	if x0 > x1 {
		return spans
	}
	if n := len(spans); n > 0 && x0 <= int64(spans[n-1].X1)+1 {
		if int(x1) > spans[n-1].X1 {
			spans[n-1].X1 = int(x1)
		}
		return spans
	}
	return append(spans, Span{X0: int(x0), X1: int(x1)})
}

// ceilHalf returns the smallest integer x with x+1/2 >= num/den (den > 0).
func ceilHalf(num, den int64) int64 {
	return ceilDiv(2*num-den, 2*den)
}

// floorHalf returns the largest integer x with x+1/2 <= num/den (den > 0).
func floorHalf(num, den int64) int64 {
	return floorDiv(2*num-den, 2*den)
}

func floorDiv(a, b int64) int64 { // b > 0
	q := a / b
	if a%b != 0 && a < 0 {
		q--
	}
	return q
}

func ceilDiv(a, b int64) int64 { return -floorDiv(-a, b) } // b > 0

func minMax(a, b int64) (int64, int64) {
	if a < b {
		return a, b
	}
	return b, a
}
