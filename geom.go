// Package geomlib maintains a dynamic set of integer points addressed by
// integer IDs, and answers convex hull / convex layer (onion peeling)
// queries. Snapshots are immutable and persistent: every update returns a
// new Snapshot while old ones stay valid, with internal structure shared
// between versions.
package geomlib

// Point is a 2D integer point.
type Point struct {
	X, Y int64
}

func lessPoint(a, b Point) bool {
	if a.X != b.X {
		return a.X < b.X
	}
	return a.Y < b.Y
}

func pointPrio(p Point) uint64 {
	return mix64(uint64(p.X)*0x9e3779b97f4a7c15 ^ mix64(uint64(p.Y)))
}

func idPrio(id int64) uint64 { return mix64(uint64(id)) }

func lessID(a, b int64) bool { return a < b }

// cross returns (b-a) x (c-a).
func cross(a, b, c Point) int64 {
	return (b.X-a.X)*(c.Y-a.Y) - (b.Y-a.Y)*(c.X-a.X)
}

// Layer is one convex layer of the point set. Rank 1 is the outermost
// layer. Hull lists the layer vertices counterclockwise starting from the
// lexicographically smallest vertex, with collinear points on edges kept
// out (endpoints only). Area2 is twice the signed area (always >= 0).
type Layer struct {
	Rank  int
	Hull  []Point
	Area2 int64
}

// state is immutable; Snapshot values share it.
type state struct {
	byCoord pmap[Point, []int64] // coordinate -> sorted source IDs
	byID    pmap[int64, Point]   // ID -> coordinate
}

func newState() state {
	return state{
		byCoord: newPmap[Point, []int64](lessPoint, pointPrio),
		byID:    newPmap[int64, Point](lessID, idPrio),
	}
}

// Snapshot is an immutable version of the point set. The zero value is
// ready to use as an empty set.
type Snapshot struct {
	st state
}

// New returns an empty Snapshot.
func New() Snapshot { return Snapshot{st: newState()} }

func (s Snapshot) state() state {
	if s.st.byCoord.less == nil {
		return newState()
	}
	return s.st
}

// Add inserts id at p and returns the new Snapshot. If id already exists it
// is moved to p (a correction). If other IDs already sit at p, id joins
// their group: the geometric point still appears only once.
func (s Snapshot) Add(id int64, p Point) Snapshot {
	st := s.state()
	if old, ok := st.byID.get(id); ok {
		if old == p {
			return s
		}
		st = removeSource(st, old, id)
	}
	st = addSource(st, p, id)
	st.byID = st.byID.put(id, p)
	return Snapshot{st: st}
}

// Remove deletes id and returns the new Snapshot. The geometric point
// disappears only when its last source ID is removed.
func (s Snapshot) Remove(id int64) Snapshot {
	st := s.state()
	p, ok := st.byID.get(id)
	if !ok {
		return s
	}
	st = removeSource(st, p, id)
	st.byID = st.byID.del(id)
	return Snapshot{st: st}
}

// Contains reports whether id is present.
func (s Snapshot) Contains(id int64) bool {
	_, ok := s.state().byID.get(id)
	return ok
}

// Point returns the coordinate of id.
func (s Snapshot) Point(id int64) (Point, bool) {
	return s.state().byID.get(id)
}

// Sources returns the sorted IDs currently grouped at coordinate p.
func (s Snapshot) Sources(p Point) []int64 {
	ids, ok := s.state().byCoord.get(p)
	if !ok {
		return nil
	}
	out := make([]int64, len(ids))
	copy(out, ids)
	return out
}

// Len returns the number of distinct geometric points.
func (s Snapshot) Len() int { return s.state().byCoord.len() }

// IDs returns the number of tracked IDs.
func (s Snapshot) IDs() int { return s.state().byID.len() }

func addSource(st state, p Point, id int64) state {
	ids, _ := st.byCoord.get(p)
	ids = insertID(ids, id)
	st.byCoord = st.byCoord.put(p, ids)
	return st
}

func removeSource(st state, p Point, id int64) state {
	ids, ok := st.byCoord.get(p)
	if !ok {
		return st
	}
	ids = removeID(ids, id)
	if len(ids) == 0 {
		st.byCoord = st.byCoord.del(p)
	} else {
		st.byCoord = st.byCoord.put(p, ids)
	}
	return st
}

func insertID(ids []int64, id int64) []int64 {
	i := 0
	for i < len(ids) && ids[i] < id {
		i++
	}
	if i < len(ids) && ids[i] == id {
		return ids
	}
	out := make([]int64, 0, len(ids)+1)
	out = append(out, ids[:i]...)
	out = append(out, id)
	out = append(out, ids[i:]...)
	return out
}

func removeID(ids []int64, id int64) []int64 {
	for i, v := range ids {
		if v == id {
			out := make([]int64, 0, len(ids)-1)
			out = append(out, ids[:i]...)
			out = append(out, ids[i+1:]...)
			return out
		}
	}
	return ids
}

// points returns the distinct coordinates in lexicographic order.
func (s Snapshot) points() []Point {
	st := s.state()
	pts := make([]Point, 0, st.byCoord.len())
	st.byCoord.each(func(p Point, _ []int64) {
		pts = append(pts, p)
	})
	return pts
}

// Hull returns the convex hull vertices counterclockwise, starting from the
// lexicographically smallest vertex. Points collinear with an edge are
// omitted (endpoints only). If all points are collinear the two extreme
// endpoints are returned; a single point is returned as-is.
func (s Snapshot) Hull() []Point {
	return convexHull(s.points())
}

// Area2 returns twice the area of the convex hull (0 for fewer than 3
// vertices).
func (s Snapshot) Area2() int64 {
	return area2(s.Hull())
}

// Layers peels the point set into convex layers (onion decomposition).
// Layer 1 is the convex hull; each subsequent layer is the convex hull of
// the remaining points. Deleting or correcting a point may change every
// layer. A final layer of one or two points has Area2 == 0.
func (s Snapshot) Layers() []Layer {
	pts := s.points()
	var layers []Layer
	for len(pts) > 0 {
		h := convexHull(pts)
		layers = append(layers, Layer{Rank: len(layers) + 1, Hull: h, Area2: area2(h)})
		inHull := make(map[Point]bool, len(h))
		for _, p := range h {
			inHull[p] = true
		}
		rest := pts[:0]
		for _, p := range pts {
			if !inHull[p] {
				rest = append(rest, p)
			}
		}
		pts = rest
	}
	return layers
}

// convexHull computes the hull of pts, which must be sorted lexicographically
// and free of duplicates (monotone chain).
func convexHull(pts []Point) []Point {
	n := len(pts)
	if n <= 1 {
		out := make([]Point, n)
		copy(out, pts)
		return out
	}
	h := make([]Point, 0, 2*n)
	for _, p := range pts { // lower hull, left to right
		for len(h) >= 2 && cross(h[len(h)-2], h[len(h)-1], p) <= 0 {
			h = h[:len(h)-1]
		}
		h = append(h, p)
	}
	lower := len(h)
	for i := n - 2; i >= 0; i-- { // upper hull, right to left
		p := pts[i]
		for len(h) > lower && cross(h[len(h)-2], h[len(h)-1], p) <= 0 {
			h = h[:len(h)-1]
		}
		h = append(h, p)
	}
	// Drop the final point: it duplicates h[0]. The loop above re-adds
	// pts[0] at the end, so trim it; degenerate (all-collinear) sets then
	// collapse to the two endpoints.
	if len(h) > 1 {
		h = h[:len(h)-1]
	}
	// Rotate so the lexicographically smallest vertex comes first.
	min := 0
	for i, p := range h {
		if lessPoint(p, h[min]) {
			min = i
		}
	}
	out := make([]Point, len(h))
	copy(out, h[min:])
	copy(out[len(h)-min:], h[:min])
	return out
}

// area2 returns twice the area of a simple polygon given in order.
func area2(poly []Point) int64 {
	if len(poly) < 3 {
		return 0
	}
	var a int64
	for i, p := range poly {
		q := poly[(i+1)%len(poly)]
		a += p.X*q.Y - q.X*p.Y
	}
	if a < 0 {
		a = -a
	}
	return a
}
