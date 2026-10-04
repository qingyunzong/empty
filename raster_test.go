package raster

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// contains is the independent per-pixel reference model: it casts an exact
// ray in +x from the pixel center (x+1/2, y+1/2) and applies the fill rule.
// A center lying exactly on an edge is inside. Horizontal edges never cross
// the ray's half-integer height and are skipped. Vertices sit on integer y,
// so the ray never passes through one and no vertex can be counted twice.
func contains(loops [][]Point, rule FillRule, x, y int) bool {
	px := int64(2*x + 1) // doubled center coordinates
	py := int64(2*y + 1)
	winding, parity := 0, 0
	for _, loop := range loops {
		n := len(loop)
		for i := 0; i < n; i++ {
			a, b := loop[i], loop[(i+1)%n]
			ax, ay := int64(a.X), int64(a.Y)
			bx, by := int64(b.X), int64(b.Y)
			// Exact boundary test: is the doubled center on segment ab?
			cross := (px-2*ax)*(by-ay) - (py-2*ay)*(bx-ax)
			if cross == 0 &&
				between(px, 2*ax, 2*bx) && between(py, 2*ay, 2*by) {
				return true
			}
			if ay == by {
				continue // horizontal edge: no crossing
			}
			lo, hi := ay, by
			if lo > hi {
				lo, hi = hi, lo
			}
			if lo > int64(y) || hi < int64(y+1) {
				continue // does not straddle the scanline
			}
			dy := by - ay
			dx := bx - ax
			num := 2*ax*dy + (py-2*ay)*dx
			den := 2 * dy
			if den < 0 {
				num, den = -num, -den
			}
			// Crossing strictly right of the center: num/den > px/2.
			if 2*num > px*den {
				if by > ay {
					winding++
				} else {
					winding--
				}
				parity ^= 1
			}
		}
	}
	if rule == NonZero {
		return winding != 0
	}
	return parity != 0
}

func between(v, a, b int64) bool {
	if a > b {
		a, b = b, a
	}
	return a <= v && v <= b
}

// bruteForce rasterizes by evaluating contains at every pixel center of the
// bounding box (padded by 1) and builds the same Row/Span representation.
func bruteForce(loops [][]Point, rule FillRule) []Row {
	minX, minY, maxX, maxY := 0, 0, 0, 0
	first := true
	for _, loop := range loops {
		for _, p := range loop {
			if first {
				minX, maxX, minY, maxY = p.X, p.X, p.Y, p.Y
				first = false
				continue
			}
			minX = min(minX, p.X)
			maxX = max(maxX, p.X)
			minY = min(minY, p.Y)
			maxY = max(maxY, p.Y)
		}
	}
	if first {
		return nil
	}
	var rows []Row
	for y := minY - 1; y <= maxY; y++ {
		var spans []Span
		for x := minX - 1; x <= maxX; x++ {
			if !contains(loops, rule, x, y) {
				continue
			}
			if n := len(spans); n > 0 && spans[n-1].X1 == x-1 {
				spans[n-1].X1 = x
			} else {
				spans = append(spans, Span{X0: x, X1: x})
			}
		}
		if len(spans) > 0 {
			rows = append(rows, Row{Y: y, Spans: spans})
		}
	}
	return rows
}

func checkAgainstModel(t *testing.T, loops [][]Point) {
	t.Helper()
	for _, rule := range []FillRule{NonZero, EvenOdd} {
		got := Fill(loops, rule)
		want := bruteForce(loops, rule)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("rule=%v loops=%v\ngot:  %v\nwant: %v", rule, loops, got, want)
		}
	}
}

func TestSquare(t *testing.T) {
	sq := [][]Point{{{0, 0}, {4, 0}, {4, 4}, {0, 4}}}
	checkAgainstModel(t, sq)
	want := []Row{
		{Y: 0, Spans: []Span{{0, 3}}},
		{Y: 1, Spans: []Span{{0, 3}}},
		{Y: 2, Spans: []Span{{0, 3}}},
		{Y: 3, Spans: []Span{{0, 3}}},
	}
	if got := Fill(sq, NonZero); !reflect.DeepEqual(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestHole(t *testing.T) {
	// Outer CCW square with a CW square hole inside.
	loops := [][]Point{
		{{0, 0}, {8, 0}, {8, 8}, {0, 8}},
		{{2, 2}, {2, 6}, {6, 6}, {6, 2}},
	}
	checkAgainstModel(t, loops)
	got := Fill(loops, NonZero)
	want := []Row{
		{Y: 0, Spans: []Span{{0, 7}}},
		{Y: 1, Spans: []Span{{0, 7}}},
		{Y: 2, Spans: []Span{{0, 1}, {6, 7}}},
		{Y: 3, Spans: []Span{{0, 1}, {6, 7}}},
		{Y: 4, Spans: []Span{{0, 1}, {6, 7}}},
		{Y: 5, Spans: []Span{{0, 1}, {6, 7}}},
		{Y: 6, Spans: []Span{{0, 7}}},
		{Y: 7, Spans: []Span{{0, 7}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("nonzero hole:\ngot  %v\nwant %v", got, want)
	}
	// EvenOdd ignores orientation: same result with both loops CCW.
	sameDir := [][]Point{
		{{0, 0}, {8, 0}, {8, 8}, {0, 8}},
		{{2, 2}, {6, 2}, {6, 6}, {2, 6}},
	}
	if got := Fill(sameDir, EvenOdd); !reflect.DeepEqual(got, want) {
		t.Errorf("evenodd hole:\ngot  %v\nwant %v", got, want)
	}
	// NonZero with same-direction loops must NOT punch a hole.
	solid := Fill(sameDir, NonZero)
	for _, r := range solid {
		if len(r.Spans) != 1 || r.Spans[0] != (Span{0, 7}) {
			t.Fatalf("nonzero same-direction should be solid, got %v", solid)
		}
	}
}

func TestTriangleVertexRows(t *testing.T) {
	// Apex and base vertices must not be double counted.
	tri := [][]Point{{{0, 0}, {6, 0}, {3, 4}}}
	checkAgainstModel(t, tri)
	// Reversed orientation.
	tri2 := [][]Point{{{3, 4}, {6, 0}, {0, 0}}}
	checkAgainstModel(t, tri2)
}

func TestBoundaryPixelCenter(t *testing.T) {
	// Edge (0,0)-(2,2) passes exactly through pixel center (0.5, 0.5):
	// the boundary pixel (0,0) counts as inside.
	poly := [][]Point{{{0, 0}, {2, 2}, {2, 0}}}
	checkAgainstModel(t, poly)
	got := Fill(poly, NonZero)
	want := []Row{
		{Y: 0, Spans: []Span{{0, 1}}},
		{Y: 1, Spans: []Span{{1, 1}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestDegenerate(t *testing.T) {
	cases := [][][]Point{
		nil,
		{{}},
		{{{1, 1}}},
		{{{0, 0}, {3, 0}}},         // zero-area horizontal
		{{{0, 0}, {0, 5}}},         // zero-area vertical
		{{{0, 0}, {2, 2}, {0, 0}}}, // back and forth
		{{{0, 0}, {4, 0}, {4, 0}, {4, 4}, {0, 4}}}, // repeated vertex
	}
	for _, loops := range cases {
		checkAgainstModel(t, loops)
	}
}

func TestSelfTouchingAndSharedEdges(t *testing.T) {
	cases := [][][]Point{
		// Figure-eight (self-touching at a vertex).
		{{{0, 0}, {4, 0}, {4, 4}, {0, 4}, {0, 0}, {-4, 0}, {-4, 4}, {0, 4}}},
		// Two loops touching at one vertex.
		{{{0, 0}, {4, 0}, {4, 4}, {0, 4}}, {{4, 4}, {8, 4}, {8, 8}, {4, 8}}},
		// Two loops sharing an edge segment (adjacent rectangles).
		{{{0, 0}, {4, 0}, {4, 4}, {0, 4}}, {{4, 0}, {8, 0}, {8, 4}, {4, 4}}},
		// Nested loops, three deep.
		{{{0, 0}, {12, 0}, {12, 12}, {0, 12}},
			{{2, 2}, {10, 2}, {10, 10}, {2, 10}},
			{{4, 4}, {8, 4}, {8, 8}, {4, 8}}},
		// Bowtie (self-intersecting).
		{{{0, 0}, {6, 6}, {6, 0}, {0, 6}}},
	}
	for _, loops := range cases {
		checkAgainstModel(t, loops)
	}
}

func TestRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for iter := 0; iter < 3000; iter++ {
		var loops [][]Point
		for k := 0; k < 1+rng.Intn(3); k++ {
			n := 3 + rng.Intn(8)
			loop := make([]Point, n)
			for i := range loop {
				loop[i] = Point{rng.Intn(13) - 6, rng.Intn(13) - 6}
			}
			loops = append(loops, loop)
		}
		for _, rule := range []FillRule{NonZero, EvenOdd} {
			got := Fill(loops, rule)
			want := bruteForce(loops, rule)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("iter=%d rule=%v loops=%v\ngot:  %v\nwant: %v",
					iter, rule, loops, got, want)
			}
		}
	}
}

func ExampleFill() {
	rows := Fill([][]Point{
		{{0, 0}, {8, 0}, {8, 8}, {0, 8}}, // outer, CCW
		{{2, 2}, {2, 6}, {6, 6}, {6, 2}}, // hole, CW
	}, NonZero)
	for _, r := range rows {
		fmt.Println(r.Y, r.Spans)
	}
	// Output:
	// 0 [{0 7}]
	// 1 [{0 7}]
	// 2 [{0 1} {6 7}]
	// 3 [{0 1} {6 7}]
	// 4 [{0 1} {6 7}]
	// 5 [{0 1} {6 7}]
	// 6 [{0 7}]
	// 7 [{0 7}]
}
