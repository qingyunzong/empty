package geom

// Entry associates a point ID with its coordinate.
type Entry struct {
	ID int64
	P  Point
}

// Snapshot is an immutable, persistent view of a set of points keyed by
// ID. All update methods return a new Snapshot that shares structure with
// the receiver; the receiver is never modified, so branches diverging from
// one ancestor never observe each other's edits.
type Snapshot struct {
	root *node
}

// New returns an empty snapshot.
func New() *Snapshot { return &Snapshot{} }

// Len returns the number of IDs in the snapshot.
func (s *Snapshot) Len() int { return sizeOf(s.root) }

// Add returns a new snapshot with id placed at p, replacing any previous
// coordinate for id. Correcting an interior point may change every layer.
func (s *Snapshot) Add(id int64, p Point) *Snapshot {
	return &Snapshot{root: insert(s.root, id, p)}
}

// Remove returns a new snapshot without id (a no-op if id is absent).
func (s *Snapshot) Remove(id int64) *Snapshot {
	return &Snapshot{root: remove(s.root, id)}
}

// Get returns the coordinate stored under id.
func (s *Snapshot) Get(id int64) (Point, bool) { return lookup(s.root, id) }

// Entries returns all ID/point pairs sorted by ID.
func (s *Snapshot) Entries() []Entry {
	out := make([]Entry, 0, s.Len())
	inOrder(s.root, func(id int64, p Point) { out = append(out, Entry{ID: id, P: p}) })
	return out
}

// Points returns the coordinates of all entries (duplicates kept, ordered
// by ID).
func (s *Snapshot) Points() []Point {
	out := make([]Point, 0, s.Len())
	inOrder(s.root, func(_ int64, p Point) { out = append(out, p) })
	return out
}

// UniquePoints returns the sorted distinct coordinates in the snapshot.
func (s *Snapshot) UniquePoints() []Point { return dedupeSorted(s.Points()) }

// Group returns the sorted IDs whose coordinate equals p: duplicate
// coordinates collapse to one geometric point but keep all source IDs.
func (s *Snapshot) Group(p Point) []int64 {
	var ids []int64
	inOrder(s.root, func(id int64, q Point) {
		if q == p {
			ids = append(ids, id)
		}
	})
	return ids
}

// Hull returns the convex hull of the snapshot's distinct coordinates:
// counterclockwise from the lexicographically smallest point, collinear
// edge points omitted, two endpoints when everything is collinear.
func (s *Snapshot) Hull() []Point { return convexHull(s.Points()) }

// Area2 returns twice the hull's area as an exact integer.
func (s *Snapshot) Area2() int64 { return area2(s.Hull()) }

// Layers returns the convex layers (onion peeling) of the snapshot's
// distinct coordinates, outermost first. Points lying on a layer's
// boundary (vertices and edge-collinear points) belong to that layer and
// are removed before the next peel.
func (s *Snapshot) Layers() [][]Point { return convexLayers(s.Points()) }

// LayerAreas2 returns the doubled area of every layer, outermost first.
func (s *Snapshot) LayerAreas2() []int64 {
	layers := s.Layers()
	out := make([]int64, len(layers))
	for i, l := range layers {
		out[i] = area2(l)
	}
	return out
}

// Rank returns the 0-based convex-layer index of the coordinate stored
// under id. The second result is false if id is not in the snapshot.
func (s *Snapshot) Rank(id int64) (int, bool) {
	p, ok := s.Get(id)
	if !ok {
		return 0, false
	}
	remaining := s.UniquePoints()
	for i := 0; ; i++ {
		h := convexHull(remaining)
		if onBoundary(h, p) {
			return i, true
		}
		next := remaining[:0]
		for _, q := range remaining {
			if !onBoundary(h, q) {
				next = append(next, q)
			}
		}
		remaining = next
	}
}

// Ranks returns the convex-layer index of every ID in the snapshot.
func (s *Snapshot) Ranks() map[int64]int {
	out := make(map[int64]int, s.Len())
	remaining := s.UniquePoints()
	for i := 0; len(remaining) > 0; i++ {
		h := convexHull(remaining)
		next := remaining[:0]
		for _, q := range remaining {
			if onBoundary(h, q) {
				for _, id := range s.Group(q) {
					out[id] = i
				}
			} else {
				next = append(next, q)
			}
		}
		remaining = next
	}
	return out
}
