package dataeng

import "fmt"

// Node is a quadtree prefix: the 2*Depth highest bits of a Morton code.
//
// The first digit (the most significant bit pair) selects one of the four
// root quadrants, the next digit selects a child quadrant, and so on. A
// digit is xBit | yBit<<1: 0=(0,0), 1=(1,0), 2=(0,1), 3=(1,1), which is
// also Morton-ascending child order.
//
// Prefix is stored in its final code positions. All bits below the prefix
// are zero, so the node's interval is [Prefix, Prefix+4^(Bits-Depth)).
type Node struct {
	Bits   uint8
	Depth  uint8
	Prefix uint32
}

// Valid reports whether n is a well-formed node prefix for its Bits.
func (n Node) Valid() bool {
	if n.Bits < 1 || n.Bits > MaxBits || n.Depth > n.Bits {
		return false
	}
	if n.Prefix >= uint32(1)<<(2*n.Bits) {
		return false
	}
	if n.Depth < n.Bits {
		mask := uint32(1)<<(2*(n.Bits-n.Depth)) - 1
		if n.Prefix&mask != 0 {
			return false
		}
	}
	return true
}

// CodeRange returns the half-open Morton interval covered by n.
func (n Node) CodeRange() (lo, hi uint32, ok bool) {
	if !n.Valid() {
		return 0, 0, false
	}
	span := uint32(1) << (2 * (n.Bits - n.Depth))
	return n.Prefix, n.Prefix + span, true
}

// CellRect returns the inclusive cell rectangle covered by n.
func (n Node) CellRect() (Rect, bool) {
	if !n.Valid() {
		return Rect{}, false
	}
	var x0, y0 uint32
	for j := uint8(0); j < n.Depth; j++ {
		shift := 2 * (n.Bits - 1 - j)
		digit := uint8(n.Prefix >> shift & 3)
		x0 |= uint32(digit&1) << (n.Bits - 1 - j)
		y0 |= uint32(digit>>1&1) << (n.Bits - 1 - j)
	}
	size := uint32(1) << (n.Bits - n.Depth)
	return Rect{
		MinX: x0,
		MinY: y0,
		MaxX: x0 + size - 1,
		MaxY: y0 + size - 1,
	}, true
}

// Digits returns the node's base-4 prefix digits from the highest bit pair
// down to the node depth.
func (n Node) Digits() ([]uint8, bool) {
	if !n.Valid() {
		return nil, false
	}
	digits := make([]uint8, n.Depth)
	for j := uint8(0); j < n.Depth; j++ {
		shift := 2 * (n.Bits - 1 - j)
		digits[j] = uint8(n.Prefix >> shift & 3)
	}
	return digits, true
}

// RootNode returns the depth-zero node covering the whole domain.
func (d Domain) RootNode() (Node, error) {
	if !d.Valid() {
		return Node{}, fmt.Errorf("dataeng: invalid domain width %d", d.Bits)
	}
	return Node{Bits: d.Bits, Depth: 0, Prefix: 0}, nil
}

// ChildNode returns the child of parent selected by quadrant in Morton
// order: 0=(0,0), 1=(1,0), 2=(0,1), 3=(1,1).
func (d Domain) ChildNode(parent Node, quadrant uint8) (Node, error) {
	if !d.Valid() {
		return Node{}, fmt.Errorf("dataeng: invalid domain width %d", d.Bits)
	}
	if !parent.Valid() || parent.Bits != d.Bits {
		return Node{}, fmt.Errorf("dataeng: invalid parent node")
	}
	if parent.Depth >= d.Bits {
		return Node{}, fmt.Errorf("dataeng: cannot descend below a leaf")
	}
	if quadrant > 3 {
		return Node{}, fmt.Errorf("dataeng: quadrant %d outside [0,3]", quadrant)
	}
	shift := 2 * (d.Bits - parent.Depth - 1)
	return Node{
		Bits:   d.Bits,
		Depth:  parent.Depth + 1,
		Prefix: parent.Prefix | uint32(quadrant)<<shift,
	}, nil
}

// Interval is a maximal half-open range of Morton codes in a query.
//
// Prefixes is an ordered exact tiling of [Lo, Hi) by quadtree nodes. A
// merged interval may need more than one prefix because a contiguous code
// run need not itself be a quadtree node.
type Interval struct {
	Lo       uint32
	Hi       uint32
	Prefixes []Node
}

// Len returns the number of codes in the interval.
func (iv Interval) Len() uint32 {
	return iv.Hi - iv.Lo
}

// Result is the outcome of Domain.Query.
//
// When Complete is true, Intervals covers the query exactly and Pending is
// empty. When Complete is false, the query exceeded the interval budget;
// Intervals holds the confirmed Morton-order prefix and Pending holds the
// exact remainder as quadtree prefixes. The two sets are disjoint and their
// union is exactly the query.
type Result struct {
	Complete  bool
	Intervals []Interval
	Pending   []Node
}

// Query clips r to the domain's Morton code space.
//
// budget is the maximum number of intervals the caller accepts. If the
// exact answer has at most budget intervals, Query returns them all with
// Complete=true. Otherwise it returns the first budget maximal intervals
// in Morton-ascending depth-first order and leaves the exact, disjoint
// remainder as unexpanded prefixes.
//
// Query walks only quadtree nodes that intersect r; it never enumerates the
// whole code domain. In particular, a full-domain query is one root node.
func (d Domain) Query(r Rect, budget int) (Result, error) {
	if err := d.ValidateRect(r); err != nil {
		return Result{}, err
	}
	if budget < 0 {
		return Result{}, fmt.Errorf("dataeng: negative interval budget %d", budget)
	}

	nodes := d.collectNodes(r)
	intervals := mergeNodes(nodes)
	if len(intervals) <= budget {
		return Result{Complete: true, Intervals: intervals}, nil
	}

	confirmed := make([]Interval, budget)
	copy(confirmed, intervals[:budget])
	consumed := 0
	for i := range confirmed {
		consumed += len(confirmed[i].Prefixes)
	}
	return Result{
		Complete:  false,
		Intervals: confirmed,
		Pending:   nodes[consumed:],
	}, nil
}

// collectNodes returns the maximal quadtree nodes contained in r, in
// Morton-ascending depth-first order.
func (d Domain) collectNodes(r Rect) []Node {
	var nodes []Node
	var walk func(depth uint8, prefix, x0, y0, size uint32)
	walk = func(depth uint8, prefix, x0, y0, size uint32) {
		x1 := x0 + size - 1
		y1 := y0 + size - 1
		if x0 > r.MaxX || x1 < r.MinX || y0 > r.MaxY || y1 < r.MinY {
			return
		}
		if x0 >= r.MinX && x1 <= r.MaxX && y0 >= r.MinY && y1 <= r.MaxY {
			nodes = append(nodes, Node{
				Bits:   d.Bits,
				Depth:  depth,
				Prefix: prefix,
			})
			return
		}
		if depth == d.Bits {
			// A 1x1 node either intersects r completely or not at all.
			return
		}

		half := size >> 1
		shift := 2 * (d.Bits - depth - 1)
		for quadrant := uint32(0); quadrant < 4; quadrant++ {
			cx := x0
			if quadrant&1 != 0 {
				cx += half
			}
			cy := y0
			if quadrant&2 != 0 {
				cy += half
			}
			walk(depth+1, prefix|quadrant<<shift, cx, cy, half)
		}
	}
	walk(0, 0, 0, 0, d.Size())
	return nodes
}

func mergeNodes(nodes []Node) []Interval {
	intervals := make([]Interval, 0, len(nodes))
	for _, n := range nodes {
		lo, hi, ok := n.CodeRange()
		if !ok {
			continue
		}
		last := len(intervals) - 1
		if last >= 0 && intervals[last].Hi == lo {
			intervals[last].Hi = hi
			intervals[last].Prefixes = append(intervals[last].Prefixes, n)
			continue
		}
		intervals = append(intervals, Interval{
			Lo:       lo,
			Hi:       hi,
			Prefixes: []Node{n},
		})
	}
	return intervals
}
