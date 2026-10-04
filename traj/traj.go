// Package traj maintains a trajectory point library and links points into
// segments. Two points that are adjacent in time order are linked into the
// same segment iff their time difference is at most g and their squared
// distance is at most r^2. All arithmetic is integer-only; no square roots.
package traj

import "sort"

// Point is a single trajectory sample. Coordinates and time are integers.
type Point struct {
	ID int
	T  int64
	X  int64
	Y  int64
}

// Edge connects two adjacent linked points, earlier (by T, then ID) first.
type Edge struct {
	From int
	To   int
}

// Segment is a maximal run of linked points. MinID is the stable identity
// of the segment: the smallest member ID, independent of update order.
type Segment struct {
	MinID int
	Edges []Edge
}

// Store keeps points ordered by (T, ID) and derives segments on demand.
type Store struct {
	g     int64
	r2    int64
	pts   map[int]Point
	order []int // point IDs sorted by (T, ID)
}

// New creates a Store linking adjacent points with time gap <= g and
// squared distance <= r2.
func New(g, r2 int64) *Store {
	return &Store{g: g, r2: r2, pts: make(map[int]Point)}
}

// Linked reports whether two points may be connected, using integer math
// only: |dt| <= g and dx*dx+dy*dy <= r2.
func Linked(a, b Point, g, r2 int64) bool {
	dt := a.T - b.T
	if dt < 0 {
		dt = -dt
	}
	if dt > g {
		return false
	}
	dx := a.X - b.X
	dy := a.Y - b.Y
	return dx*dx+dy*dy <= r2
}

func less(a, b Point) bool {
	if a.T != b.T {
		return a.T < b.T
	}
	return a.ID < b.ID
}

// Upsert inserts a new point or corrects an existing one. A correction can
// split a segment (point moved away from its neighbours) or merge segments
// (point moved to bridge a gap).
func (s *Store) Upsert(p Point) {
	if old, ok := s.pts[p.ID]; ok {
		s.removeFromOrder(old)
	}
	s.pts[p.ID] = p
	i := sort.Search(len(s.order), func(i int) bool {
		return !less(s.pts[s.order[i]], p)
	})
	s.order = append(s.order, 0)
	copy(s.order[i+1:], s.order[i:])
	s.order[i] = p.ID
}

// Remove deletes a point, potentially splitting its segment.
func (s *Store) Remove(id int) {
	p, ok := s.pts[id]
	if !ok {
		return
	}
	s.removeFromOrder(p)
	delete(s.pts, id)
}

func (s *Store) removeFromOrder(p Point) {
	i := sort.Search(len(s.order), func(i int) bool {
		return !less(s.pts[s.order[i]], p)
	})
	if i < len(s.order) && s.order[i] == p.ID {
		s.order = append(s.order[:i], s.order[i+1:]...)
	}
}

// Segments returns the current segments ordered by MinID, with edges in
// time order. The output is deterministic for a given point set.
func (s *Store) Segments() []Segment {
	var segs []Segment
	for k, id := range s.order {
		if k > 0 && Linked(s.pts[s.order[k-1]], s.pts[id], s.g, s.r2) {
			seg := &segs[len(segs)-1]
			seg.Edges = append(seg.Edges, Edge{From: s.order[k-1], To: id})
			if id < seg.MinID {
				seg.MinID = id
			}
		} else {
			segs = append(segs, Segment{MinID: id})
		}
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].MinID < segs[j].MinID })
	return segs
}

// Build constructs a Store from scratch over the given points. It is the
// reference against which incremental updates are checked.
func Build(points []Point, g, r2 int64) *Store {
	s := New(g, r2)
	sorted := append([]Point(nil), points...)
	sort.Slice(sorted, func(i, j int) bool { return less(sorted[i], sorted[j]) })
	for _, p := range sorted {
		s.pts[p.ID] = p
		s.order = append(s.order, p.ID)
	}
	return s
}
