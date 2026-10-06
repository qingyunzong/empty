package geom

import "sort"

// dedupeSorted returns the sorted unique coordinates of pts.
func dedupeSorted(pts []Point) []Point {
	s := append([]Point(nil), pts...)
	sort.Slice(s, func(i, j int) bool { return lessPoint(s[i], s[j]) })
	out := s[:0]
	for i, p := range s {
		if i == 0 || p != s[i-1] {
			out = append(out, p)
		}
	}
	return out
}

// convexHull returns the convex hull of pts counterclockwise, starting at
// the lexicographically smallest point. Points collinear with an edge are
// omitted; if all points are collinear only the two endpoints remain.
func convexHull(pts []Point) []Point {
	s := dedupeSorted(pts)
	if len(s) <= 2 {
		return append([]Point(nil), s...)
	}
	lower := make([]Point, 0, len(s))
	for _, p := range s {
		for len(lower) >= 2 && cross(lower[len(lower)-2], lower[len(lower)-1], p) <= 0 {
			lower = lower[:len(lower)-1]
		}
		lower = append(lower, p)
	}
	upper := make([]Point, 0, len(s))
	for i := len(s) - 1; i >= 0; i-- {
		p := s[i]
		for len(upper) >= 2 && cross(upper[len(upper)-2], upper[len(upper)-1], p) <= 0 {
			upper = upper[:len(upper)-1]
		}
		upper = append(upper, p)
	}
	hull := make([]Point, 0, len(lower)+len(upper)-2)
	hull = append(hull, lower[:len(lower)-1]...)
	hull = append(hull, upper[:len(upper)-1]...)
	return hull
}

// area2 returns twice the signed area's absolute value of a polygon.
func area2(poly []Point) int64 {
	var sum int64
	for i := range poly {
		j := (i + 1) % len(poly)
		sum += poly[i].X*poly[j].Y - poly[j].X*poly[i].Y
	}
	if sum < 0 {
		sum = -sum
	}
	return sum
}

// onSegment reports whether p lies on the closed segment ab (p must be
// collinear with a and b for the result to be meaningful).
func onSegment(a, b, p Point) bool {
	return p.X >= min(a.X, b.X) && p.X <= max(a.X, b.X) &&
		p.Y >= min(a.Y, b.Y) && p.Y <= max(a.Y, b.Y)
}

// onBoundary reports whether p lies on the boundary of hull, including
// points collinear with an edge. Degenerate hulls (1 or 2 points) are
// treated as a point or a segment.
func onBoundary(hull []Point, p Point) bool {
	switch len(hull) {
	case 0:
		return false
	case 1:
		return p == hull[0]
	}
	for i := range hull {
		a, b := hull[i], hull[(i+1)%len(hull)]
		if cross(a, b, p) == 0 && onSegment(a, b, p) {
			return true
		}
	}
	return false
}

// convexLayers peels pts into convex layers from the outside in. Every
// layer is a hull in the same format as convexHull; points on a layer's
// boundary (vertices and edge-collinear points) are removed before the
// next layer is computed.
func convexLayers(pts []Point) [][]Point {
	remaining := dedupeSorted(pts)
	var layers [][]Point
	for len(remaining) > 0 {
		h := convexHull(remaining)
		layers = append(layers, h)
		next := remaining[:0]
		for _, p := range remaining {
			if !onBoundary(h, p) {
				next = append(next, p)
			}
		}
		remaining = next
	}
	return layers
}
