// Package gridmap provides an obstacle grid with batch edits, immutable
// snapshots, and shortest-path queries on an 8-neighbor grid where diagonal
// moves may not cut corners. All movement costs are integers.
package gridmap

// Movement costs. Diagonal moves cost DiagCost, orthogonal moves OrthoCost.
const (
	OrthoCost = 10
	DiagCost  = 14
)

// Point is a grid coordinate. Points are ordered lexicographically by X,
// then Y; that order is used for shortest-path tie-breaking.
type Point struct {
	X, Y int
}

// Less reports whether p sorts before q in lexicographic (X, Y) order.
func (p Point) Less(q Point) bool {
	return p.X < q.X || (p.X == q.X && p.Y < q.Y)
}

// Edit is a single obstacle change applied to a Map.
type Edit struct {
	P     Point
	Block bool // true sets an obstacle, false clears it
}

// Map is an immutable obstacle grid. Batch edits return a new Map and leave
// the receiver untouched, so every previously obtained Map remains a
// queryable snapshot of its version.
type Map struct {
	w, h int
	occ  []uint64 // obstacle bitmap, row-major: index y*w+x
}

// New returns an empty (obstacle-free) w by h Map.
func New(w, h int) *Map {
	if w < 0 || h < 0 {
		panic("gridmap: negative dimensions")
	}
	return &Map{w: w, h: h, occ: make([]uint64, (w*h+63)/64)}
}

// Width returns the grid width.
func (m *Map) Width() int { return m.w }

// Height returns the grid height.
func (m *Map) Height() int { return m.h }

// InBounds reports whether p lies inside the grid.
func (m *Map) InBounds(p Point) bool {
	return p.X >= 0 && p.X < m.w && p.Y >= 0 && p.Y < m.h
}

// Blocked reports whether p is inside the grid and holds an obstacle.
func (m *Map) Blocked(p Point) bool {
	if !m.InBounds(p) {
		return false
	}
	i := p.Y*m.w + p.X
	return m.occ[i/64]&(1<<uint(i%64)) != 0
}

// Free reports whether p is inside the grid and not an obstacle.
func (m *Map) Free(p Point) bool { return m.InBounds(p) && !m.Blocked(p) }

// Apply returns a new Map with the given batch of edits applied. The
// receiver is not modified, so it stays usable as an old snapshot.
// Edits are applied in order; out-of-bounds edits are ignored.
func (m *Map) Apply(edits ...Edit) *Map {
	nm := &Map{w: m.w, h: m.h, occ: make([]uint64, len(m.occ))}
	copy(nm.occ, m.occ)
	for _, e := range edits {
		if !nm.InBounds(e.P) {
			continue
		}
		i := e.P.Y*nm.w + e.P.X
		if e.Block {
			nm.occ[i/64] |= 1 << uint(i%64)
		} else {
			nm.occ[i/64] &^= 1 << uint(i%64)
		}
	}
	return nm
}

// StepCost returns the integer cost of a single legal move from p to q and
// whether the move is legal at all. Diagonal moves are legal only when both
// orthogonal cells adjacent to the corner are free (no corner cutting).
func (m *Map) StepCost(p, q Point) (int, bool) {
	dx, dy := q.X-p.X, q.Y-p.Y
	if dx < -1 || dx > 1 || dy < -1 || dy > 1 || (dx == 0 && dy == 0) {
		return 0, false
	}
	if !m.Free(p) || !m.Free(q) {
		return 0, false
	}
	if dx != 0 && dy != 0 {
		if !m.Free(Point{p.X + dx, p.Y}) || !m.Free(Point{p.X, p.Y + dy}) {
			return 0, false
		}
		return DiagCost, true
	}
	return OrthoCost, true
}

// forEachNeighbor calls fn for every legal one-step move out of p.
func (m *Map) forEachNeighbor(p Point, fn func(q Point, cost int)) {
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if dx == 0 && dy == 0 {
				continue
			}
			q := Point{p.X + dx, p.Y + dy}
			if c, ok := m.StepCost(p, q); ok {
				fn(q, c)
			}
		}
	}
}
