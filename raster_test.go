package raster

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// pixelsOf expands spans into the set of filled pixels.
func pixelsOf(spans []Span) map[Point]bool {
	m := make(map[Point]bool)
	for _, s := range spans {
		if s.X1 < s.X0 {
			panic(fmt.Sprintf("malformed span %+v", s))
		}
		for x := s.X0; x <= s.X1; x++ {
			p := Point{X: x, Y: s.Y}
			if m[p] {
				panic(fmt.Sprintf("pixel %v covered twice", p))
			}
			m[p] = true
		}
	}
	return m
}

// checkRayModel verifies Fill against the per-pixel exact ray-casting model
// (Contains) on every pixel of the loops' bounding box plus a margin.
func checkRayModel(t *testing.T, name string, loops []Loop, rule FillRule) {
	t.Helper()
	minX, minY, maxX, maxY := 0, 0, 0, 0
	first := true
	for _, l := range loops {
		for _, p := range l {
			if first || p.X < minX {
				minX = p.X
			}
			if first || p.X > maxX {
				maxX = p.X
			}
			if first || p.Y < minY {
				minY = p.Y
			}
			if first || p.Y > maxY {
				maxY = p.Y
			}
			first = false
		}
	}
	const margin = 2
	got := pixelsOf(Fill(loops, rule))
	want := make(map[Point]bool)
	for y := minY - margin; y <= maxY+margin; y++ {
		for x := minX - margin; x <= maxX+margin; x++ {
			if Contains(loops, rule, x, y) {
				want[Point{X: x, Y: y}] = true
			}
		}
	}
	if !reflect.DeepEqual(got, want) {
		var onlyFill, onlyRay []Point
		for p := range got {
			if !want[p] {
				onlyFill = append(onlyFill, p)
			}
		}
		for p := range want {
			if !got[p] {
				onlyRay = append(onlyRay, p)
			}
		}
		t.Errorf("%s: Fill/ray-model mismatch\n  only in Fill: %v\n  only in ray model: %v",
			name, onlyFill, onlyRay)
	}
}

func rules() []FillRule { return []FillRule{NonZero, EvenOdd} }

func TestSquareSpans(t *testing.T) {
	sq := Loop{{0, 0}, {4, 0}, {4, 4}, {0, 4}}
	want := []Span{
		{Y: 0, X0: 0, X1: 3},
		{Y: 1, X0: 0, X1: 3},
		{Y: 2, X0: 0, X1: 3},
		{Y: 3, X0: 0, X1: 3},
	}
	for _, r := range rules() {
		if got := Fill([]Loop{sq}, r); !reflect.DeepEqual(got, want) {
			t.Errorf("rule %v: got %v, want %v", r, got, want)
		}
	}
}

func TestHoleSpans(t *testing.T) {
	shell := Loop{{0, 0}, {8, 0}, {8, 8}, {0, 8}} // CCW
	hole := Loop{{2, 2}, {2, 6}, {6, 6}, {6, 2}}  // CW (reversed)
	want := []Span{
		{Y: 0, X0: 0, X1: 7},
		{Y: 1, X0: 0, X1: 7},
		{Y: 2, X0: 0, X1: 1}, {Y: 2, X0: 6, X1: 7},
		{Y: 3, X0: 0, X1: 1}, {Y: 3, X0: 6, X1: 7},
		{Y: 4, X0: 0, X1: 1}, {Y: 4, X0: 6, X1: 7},
		{Y: 5, X0: 0, X1: 1}, {Y: 5, X0: 6, X1: 7},
		{Y: 6, X0: 0, X1: 7},
		{Y: 7, X0: 0, X1: 7},
	}
	poly := Polygon{Shell: shell, Holes: []Loop{hole}}
	for _, r := range rules() {
		if got := Fill(poly.Loops(), r); !reflect.DeepEqual(got, want) {
			t.Errorf("rule %v: got %v, want %v", r, got, want)
		}
	}
}

func TestHoleOrientationNonZero(t *testing.T) {
	shell := Loop{{0, 0}, {8, 0}, {8, 8}, {0, 8}}
	holeCW := Loop{{2, 2}, {2, 6}, {6, 6}, {6, 2}}
	holeCCW := Loop{{2, 2}, {6, 2}, {6, 6}, {2, 6}}
	// Same-orientation inner loop under NonZero: winding 2, still filled.
	if Contains([]Loop{shell, holeCCW}, NonZero, 3, 3) != true {
		t.Error("NonZero: same-orientation hole should stay filled")
	}
	if Contains([]Loop{shell, holeCW}, NonZero, 3, 3) != false {
		t.Error("NonZero: reversed hole should be empty")
	}
	// EvenOdd ignores orientation entirely.
	for _, h := range []Loop{holeCW, holeCCW} {
		if Contains([]Loop{shell, h}, EvenOdd, 3, 3) != false {
			t.Error("EvenOdd: hole should be empty regardless of orientation")
		}
	}
}

func TestBoundaryConvention(t *testing.T) {
	// Hypotenuse x+y=4 passes exactly through pixel centers with x+y=3.
	tri := Loop{{0, 0}, {4, 0}, {0, 4}}
	for _, r := range rules() {
		// Centers strictly below the hypotenuse are inside.
		if !Contains([]Loop{tri}, r, 0, 0) {
			t.Errorf("rule %v: (0,0) should be inside", r)
		}
		// Centers exactly on the hypotenuse are excluded (strict rule).
		for _, p := range []Point{{0, 3}, {1, 2}, {2, 1}, {3, 0}} {
			if Contains([]Loop{tri}, r, p.X, p.Y) {
				t.Errorf("rule %v: pixel %v on the edge should be outside", r, p)
			}
		}
	}
}

func TestDegenerateLoops(t *testing.T) {
	degenerate := []Loop{
		{},                                       // empty
		{{3, 3}},                                 // single point
		{{0, 0}, {5, 5}},                         // two points (out and back)
		{{1, 1}, {1, 1}, {1, 1}},                 // repeated vertices
		{{0, 0}, {4, 0}, {4, 0}, {0, 0}},         // zero-length edge in the chain
		{{0, 0}, {2, 0}, {4, 0}, {4, 4}},         // collinear consecutive edges
		{{0, 0}, {6, 0}, {3, 0}, {6, 6}, {0, 6}}, // spike along the base
	}
	for i, l := range degenerate {
		for _, r := range rules() {
			checkRayModel(t, fmt.Sprintf("degenerate[%d]", i), []Loop{l}, r)
		}
	}
}

func TestShapesAgainstRayModel(t *testing.T) {
	shapes := map[string][]Loop{
		"unit square":     {{{0, 0}, {1, 0}, {1, 1}, {0, 1}}},
		"triangle":        {{{0, 0}, {7, 1}, {2, 5}}},
		"concave arrow":   {{{0, 0}, {6, 0}, {6, 4}, {3, 2}, {0, 4}}},
		"star":            {{{4, 0}, {5, 3}, {8, 3}, {6, 5}, {7, 8}, {4, 6}, {1, 8}, {2, 5}, {0, 3}, {3, 3}}},
		"negative coords": {{{-5, -3}, {2, -4}, {4, 1}, {-1, 3}, {-4, 1}}},
		"with hole": {
			{{0, 0}, {10, 0}, {10, 10}, {0, 10}},
			{{3, 3}, {3, 7}, {7, 7}, {7, 3}},
		},
		"nested same orientation": {
			{{0, 0}, {10, 0}, {10, 10}, {0, 10}},
			{{3, 3}, {7, 3}, {7, 7}, {3, 7}},
		},
		"self overlapping bowtie": {{{0, 0}, {6, 6}, {6, 0}, {0, 6}}},
		"touching boxes": {
			{{0, 0}, {4, 0}, {4, 4}, {0, 4}},
			{{4, 0}, {8, 0}, {8, 4}, {4, 4}},
		},
	}
	for name, loops := range shapes {
		for _, r := range rules() {
			checkRayModel(t, name, loops, r)
		}
	}
}

// TestFuzzRayModel cross-checks Fill against the per-pixel exact ray model
// on random loop sets, including random holes.
func TestFuzzRayModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for iter := 0; iter < 300; iter++ {
		nLoops := 1 + rng.Intn(3)
		loops := make([]Loop, 0, nLoops)
		for k := 0; k < nLoops; k++ {
			n := 3 + rng.Intn(8)
			l := make(Loop, n)
			for i := range l {
				l[i] = Point{X: rng.Intn(17) - 8, Y: rng.Intn(17) - 8}
			}
			loops = append(loops, l)
		}
		for _, r := range rules() {
			checkRayModel(t, fmt.Sprintf("fuzz iter %d rule %d", iter, r), loops, r)
		}
	}
}
