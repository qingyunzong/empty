// Package traj maintains a library of trajectory points and the connected
// segments formed by temporally adjacent points.
//
// Two points that are adjacent in (T, ID) order are linked by an edge when
// their time gap is at most g and their squared distance is at most r^2.
// A segment is a maximal run of linked points. All arithmetic is integer
// only: distances are compared as squares, so no floating-point square
// roots are ever taken.
//
// Coordinates and timestamps must stay within +/-2^31 so that squared
// distances fit in int64 without overflow.
package traj

import "sort"

// Point is a single trajectory observation.
type Point struct {
	ID int   // unique point identifier
	T  int64 // timestamp
	X  int64 // integer x coordinate
	Y  int64 // integer y coordinate
}

// Edge links two adjacent points of a segment; A precedes B in time order.
type Edge struct {
	A int
	B int
}

// Segment is a maximal run of linked points.
type Segment struct {
	MinID int    // smallest member ID; the stable identifier of the segment
	Size  int    // number of member points
	Edges []Edge // links between consecutive members, in time order
}

// Index incrementally maintains points and their segments.
type Index struct {
	g  int64
	r2 int64

	pts   map[int]Point // ID -> point
	order []int         // IDs sorted by (T, ID)
	pos   map[int]int   // ID -> index in order
	segOf map[int]int   // ID -> internal segment number (>= 1)
	mem   map[int][]int // internal segment number -> member IDs in time order
	next  int           // next internal segment number
}

// New returns an empty Index. Points adjacent in time order are linked when
// the time gap is at most g and the squared distance is at most r*r.
func New(g, r int64) *Index {
	if g < 0 {
		panic("traj: negative time gap")
	}
	if r < 0 {
		panic("traj: negative radius")
	}
	return &Index{
		g:     g,
		r2:    r * r,
		pts:   make(map[int]Point),
		pos:   make(map[int]int),
		segOf: make(map[int]int),
		mem:   make(map[int][]int),
		next:  1,
	}
}

// Len reports the number of points in the library.
func (ix *Index) Len() int { return len(ix.order) }

// Contains reports whether a point with the given ID exists.
func (ix *Index) Contains(id int) bool {
	_, ok := ix.pts[id]
	return ok
}

// Upsert adds a point or corrects an existing one. A correction may split
// one segment and merge others; only the affected neighborhood is
// resegmented.
func (ix *Index) Upsert(p Point) {
	if _, ok := ix.pts[p.ID]; ok {
		ix.erase(p.ID)
	}
	ix.pts[p.ID] = p
	i := sort.Search(len(ix.order), func(j int) bool {
		return !less(ix.pts[ix.order[j]], p)
	})
	ix.order = append(ix.order, 0)
	copy(ix.order[i+1:], ix.order[i:])
	ix.order[i] = p.ID
	for j := i; j < len(ix.order); j++ {
		ix.pos[ix.order[j]] = j
	}
	ix.resegment(i-1, i+1)
}

// Remove deletes a point. Removing a bridge point may split its segment;
// if its former neighbors link up instead, the segment stays whole.
func (ix *Index) Remove(id int) {
	if _, ok := ix.pts[id]; !ok {
		return
	}
	ix.erase(id)
}

func (ix *Index) erase(id int) {
	old := ix.segOf[id]
	i := ix.pos[id]
	delete(ix.pts, id)
	delete(ix.pos, id)
	delete(ix.segOf, id)
	delete(ix.mem, old) // stale if id was a singleton; rebuilt otherwise
	copy(ix.order[i:], ix.order[i+1:])
	ix.order = ix.order[:len(ix.order)-1]
	for j := i; j < len(ix.order); j++ {
		ix.pos[ix.order[j]] = j
	}
	ix.resegment(i-1, i) // former neighbors now sit at i-1 and i
}

// resegment rebuilds the segments intersecting order[lo:hi+1]. It expands
// the window to whole segments first, so splits and merges stay local.
func (ix *Index) resegment(lo, hi int) {
	n := len(ix.order)
	if n == 0 {
		return
	}
	if lo < 0 {
		lo = 0
	}
	if hi > n-1 {
		hi = n - 1
	}
	if lo > hi {
		return
	}
	for lo > 0 && ix.segOf[ix.order[lo]] == ix.segOf[ix.order[lo-1]] {
		lo--
	}
	for hi < n-1 && ix.segOf[ix.order[hi]] == ix.segOf[ix.order[hi+1]] {
		hi++
	}
	for i := lo; i <= hi; i++ {
		delete(ix.mem, ix.segOf[ix.order[i]])
	}
	cur := 0
	for i := lo; i <= hi; i++ {
		id := ix.order[i]
		if cur == 0 || !ix.linked(ix.order[i-1], id) {
			cur = ix.next
			ix.next++
		}
		ix.segOf[id] = cur
		ix.mem[cur] = append(ix.mem[cur], id)
	}
}

// linked reports whether two points adjacent in time order are connected.
func (ix *Index) linked(a, b int) bool {
	pa, pb := ix.pts[a], ix.pts[b]
	dt := pb.T - pa.T
	if dt < 0 || dt > ix.g {
		return false
	}
	dx := pa.X - pb.X
	dy := pa.Y - pb.Y
	return dx*dx+dy*dy <= ix.r2
}

func less(a, b Point) bool {
	if a.T != b.T {
		return a.T < b.T
	}
	return a.ID < b.ID
}

// Segments returns all segments sorted by MinID. The output is stable: it
// depends only on the current point set, not on the history of updates, so
// it always matches a from-scratch rebuild of the same points.
func (ix *Index) Segments() []Segment {
	out := make([]Segment, 0, len(ix.mem))
	for _, ids := range ix.mem {
		seg := Segment{MinID: ids[0], Size: len(ids)}
		for k, id := range ids {
			if id < seg.MinID {
				seg.MinID = id
			}
			if k > 0 {
				seg.Edges = append(seg.Edges, Edge{A: ids[k-1], B: id})
			}
		}
		out = append(out, seg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MinID < out[j].MinID })
	return out
}
