// Package gridmap provides a versioned 2-D grid map with batch obstacle
// editing, shortest-path queries on an 8-neighbor grid with integer costs
// and no diagonal corner cutting, lexicographically minimal tie-breaking,
// and verifiable distance certificates.
package gridmap

import "fmt"

// Movement costs. Diagonal moves cost 14 and orthogonal moves cost 10,
// an integer approximation of sqrt(2) that keeps all costs integral.
const (
	OrthogonalCost = 10
	DiagonalCost   = 14
)

// Coord is a grid cell. Coordinates compare by X first, then Y; this
// ordering defines the lexicographic tie-break used for shortest paths.
type Coord struct {
	X, Y int
}

// Less reports whether c orders before o (X first, then Y).
func (c Coord) Less(o Coord) bool {
	return c.X < o.X || (c.X == o.X && c.Y < o.Y)
}

// Edit is a single obstacle change inside a batch.
type Edit struct {
	Cell  Coord
	Block bool // true sets an obstacle, false clears one
}

// Snapshot is an immutable view of the map at one version. Snapshots
// remain valid and queryable after later batches are applied.
type Snapshot struct {
	w, h    int
	version int
	bits    []uint64 // obstacle bitmap, row-major, bit (y*w+x)
}

// Map is a versioned grid. Version 0 is the empty map; every applied
// batch appends one new version. Old snapshots stay queryable forever.
type Map struct {
	w, h  int
	snaps []*Snapshot
}

// New returns an empty w-by-h map at version 0.
func New(w, h int) (*Map, error) {
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("gridmap: invalid dimensions %dx%d", w, h)
	}
	m := &Map{w: w, h: h}
	m.snaps = append(m.snaps, &Snapshot{w: w, h: h, version: 0, bits: make([]uint64, words(w*h))})
	return m, nil
}

func words(n int) int { return (n + 63) / 64 }

// Size returns the map dimensions.
func (m *Map) Size() (w, h int) { return m.w, m.h }

// Version returns the latest version number.
func (m *Map) Version() int { return len(m.snaps) - 1 }

// Snapshot returns the immutable snapshot at version v
// (0 <= v <= m.Version()).
func (m *Map) Snapshot(v int) (*Snapshot, error) {
	if v < 0 || v >= len(m.snaps) {
		return nil, fmt.Errorf("gridmap: no version %d (latest is %d)", v, m.Version())
	}
	return m.snaps[v], nil
}

// ApplyBatch applies a batch of obstacle edits atomically and returns the
// new snapshot. Edits are applied in order; later edits in the same batch
// override earlier ones on the same cell. It is an error to edit a cell
// outside the grid. Previous snapshots are not modified.
func (m *Map) ApplyBatch(edits []Edit) (*Snapshot, error) {
	for _, e := range edits {
		if !m.inBounds(e.Cell) {
			return nil, fmt.Errorf("gridmap: edit cell %v out of bounds %dx%d", e.Cell, m.w, m.h)
		}
	}
	prev := m.snaps[len(m.snaps)-1]
	bits := make([]uint64, len(prev.bits))
	copy(bits, prev.bits)
	for _, e := range edits {
		i := e.Cell.Y*m.w + e.Cell.X
		if e.Block {
			bits[i/64] |= 1 << (uint(i) % 64)
		} else {
			bits[i/64] &^= 1 << (uint(i) % 64)
		}
	}
	s := &Snapshot{w: m.w, h: m.h, version: len(m.snaps), bits: bits}
	m.snaps = append(m.snaps, s)
	return s, nil
}

func (m *Map) inBounds(c Coord) bool {
	return c.X >= 0 && c.X < m.w && c.Y >= 0 && c.Y < m.h
}

// Version returns the snapshot's version number.
func (s *Snapshot) Version() int { return s.version }

// Size returns the grid dimensions.
func (s *Snapshot) Size() (w, h int) { return s.w, s.h }

// InBounds reports whether c is inside the grid.
func (s *Snapshot) InBounds(c Coord) bool {
	return c.X >= 0 && c.X < s.w && c.Y >= 0 && c.Y < s.h
}

// Blocked reports whether c is outside the grid or holds an obstacle.
func (s *Snapshot) Blocked(c Coord) bool {
	if !s.InBounds(c) {
		return true
	}
	i := c.Y*s.w + c.X
	return s.bits[i/64]&(1<<(uint(i)%64)) != 0
}

// MoveCost returns the cost of moving from a to b and whether the move is
// legal: both cells in bounds and unblocked, 8-neighbor adjacency, and no
// diagonal corner cutting (a diagonal step requires both orthogonally
// adjacent flanking cells to be free).
func (s *Snapshot) MoveCost(a, b Coord) (int, bool) {
	if s.Blocked(a) || s.Blocked(b) {
		return 0, false
	}
	dx, dy := b.X-a.X, b.Y-a.Y
	if dx < -1 || dx > 1 || dy < -1 || dy > 1 || (dx == 0 && dy == 0) {
		return 0, false
	}
	if dx != 0 && dy != 0 {
		// Diagonal: forbid cutting the corner past an obstacle.
		if s.Blocked(Coord{a.X + dx, a.Y}) || s.Blocked(Coord{a.X, a.Y + dy}) {
			return 0, false
		}
		return DiagonalCost, true
	}
	return OrthogonalCost, true
}

// Neighbors returns the legal moves from c as (cell, cost) pairs.
func (s *Snapshot) Neighbors(c Coord) []struct {
	Cell Coord
	Cost int
} {
	var out []struct {
		Cell Coord
		Cost int
	}
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if dx == 0 && dy == 0 {
				continue
			}
			n := Coord{c.X + dx, c.Y + dy}
			if cost, ok := s.MoveCost(c, n); ok {
				out = append(out, struct {
					Cell Coord
					Cost int
				}{n, cost})
			}
		}
	}
	return out
}
