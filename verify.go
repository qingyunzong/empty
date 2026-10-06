package geom

import (
	"fmt"
	"sort"
)

// VerifyHull checks hull against pts with a naive O(n*h) supporting-line
// test, independent of the production monotone-chain code. It verifies:
//   - hull vertices are distinct and drawn from pts,
//   - the hull starts at the lexicographically smallest point of pts,
//   - consecutive vertices make strict left turns (no collinear edge points),
//   - every point of pts lies on or to the left of every directed hull edge
//     (each edge is a supporting line of the set),
//   - the polygon is counterclockwise (positive signed area),
//   - degenerate cases: empty set, single point, all-collinear set reduce to
//     [], the point itself, or the two extreme endpoints.
//
// pts may contain duplicates; they are ignored.
func VerifyHull(pts []Point, hull []Point) error {
	set := make(map[Point]bool, len(pts))
	uniq := make([]Point, 0, len(pts))
	for _, p := range pts {
		if !set[p] {
			set[p] = true
			uniq = append(uniq, p)
		}
	}
	sort.Slice(uniq, func(i, j int) bool { return lessPoint(uniq[i], uniq[j]) })

	switch len(uniq) {
	case 0:
		if len(hull) != 0 {
			return fmt.Errorf("empty set: want empty hull, got %v", hull)
		}
		return nil
	case 1:
		if len(hull) != 1 || hull[0] != uniq[0] {
			return fmt.Errorf("singleton set: want hull [%v], got %v", uniq[0], hull)
		}
		return nil
	}

	if len(hull) == 0 {
		return fmt.Errorf("non-empty set: hull is empty")
	}
	seen := make(map[Point]bool, len(hull))
	for _, v := range hull {
		if !set[v] {
			return fmt.Errorf("hull vertex %v not in point set", v)
		}
		if seen[v] {
			return fmt.Errorf("hull vertex %v repeated", v)
		}
		seen[v] = true
	}
	if hull[0] != uniq[0] {
		return fmt.Errorf("hull must start at lex-min %v, got %v", uniq[0], hull[0])
	}

	m := len(hull)
	if m == 2 {
		// All points must be collinear with, and between, the two endpoints.
		if hull[1] != uniq[len(uniq)-1] {
			return fmt.Errorf("2-vertex hull must end at lex-max %v, got %v", uniq[len(uniq)-1], hull[1])
		}
		for _, p := range uniq {
			if cross(hull[0], hull[1], p) != 0 {
				return fmt.Errorf("2-vertex hull but %v is off the line", p)
			}
		}
		return nil
	}

	var signed int64
	for i := 0; i < m; i++ {
		a, b := hull[i], hull[(i+1)%m]
		c := hull[(i+2)%m]
		if cross(a, b, c) <= 0 {
			return fmt.Errorf("non-strict left turn at %v -> %v -> %v", a, b, c)
		}
		for _, p := range uniq {
			if cross(a, b, p) < 0 {
				return fmt.Errorf("edge %v -> %v is not supporting: %v lies right of it", a, b, p)
			}
		}
		signed += a.X*b.Y - b.X*a.Y
	}
	if signed <= 0 {
		return fmt.Errorf("hull is not counterclockwise: signed area2 = %d", signed)
	}
	return nil
}
