package geom

// node is an immutable treap node keyed by point ID. Updates copy only the
// O(log n) spine, so snapshots share all untouched structure.
type node struct {
	id          int64
	p           Point
	prio        uint64
	size        int
	left, right *node
}

// prioOf derives a deterministic pseudo-random priority from the ID.
func prioOf(id int64) uint64 {
	z := uint64(id) + 0x9E3779B97F4A7C15
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

func sizeOf(n *node) int {
	if n == nil {
		return 0
	}
	return n.size
}

func mkNode(id int64, p Point, prio uint64, l, r *node) *node {
	return &node{id: id, p: p, prio: prio, size: 1 + sizeOf(l) + sizeOf(r), left: l, right: r}
}

func rotateRight(n *node) *node {
	l := n.left
	return mkNode(l.id, l.p, l.prio, l.left, mkNode(n.id, n.p, n.prio, l.right, n.right))
}

func rotateLeft(n *node) *node {
	r := n.right
	return mkNode(r.id, r.p, r.prio, mkNode(n.id, n.p, n.prio, n.left, r.left), r.right)
}

// insert adds or replaces id in the treap, returning the new root.
func insert(n *node, id int64, p Point) *node {
	if n == nil {
		return mkNode(id, p, prioOf(id), nil, nil)
	}
	switch {
	case id == n.id:
		return mkNode(id, p, n.prio, n.left, n.right)
	case id < n.id:
		nn := mkNode(n.id, n.p, n.prio, insert(n.left, id, p), n.right)
		if nn.left.prio < nn.prio {
			nn = rotateRight(nn)
		}
		return nn
	default:
		nn := mkNode(n.id, n.p, n.prio, n.left, insert(n.right, id, p))
		if nn.right.prio < nn.prio {
			nn = rotateLeft(nn)
		}
		return nn
	}
}

// merge combines two treaps where all keys in l precede all keys in r.
func merge(l, r *node) *node {
	if l == nil {
		return r
	}
	if r == nil {
		return l
	}
	if l.prio < r.prio {
		return mkNode(l.id, l.p, l.prio, l.left, merge(l.right, r))
	}
	return mkNode(r.id, r.p, r.prio, merge(l, r.left), r.right)
}

// remove deletes id from the treap, returning the new root.
func remove(n *node, id int64) *node {
	if n == nil {
		return nil
	}
	switch {
	case id == n.id:
		return merge(n.left, n.right)
	case id < n.id:
		return mkNode(n.id, n.p, n.prio, remove(n.left, id), n.right)
	default:
		return mkNode(n.id, n.p, n.prio, n.left, remove(n.right, id))
	}
}

func lookup(n *node, id int64) (Point, bool) {
	for n != nil {
		switch {
		case id == n.id:
			return n.p, true
		case id < n.id:
			n = n.left
		default:
			n = n.right
		}
	}
	return Point{}, false
}

// inOrder visits entries in ascending ID order.
func inOrder(n *node, fn func(id int64, p Point)) {
	if n == nil {
		return
	}
	inOrder(n.left, fn)
	fn(n.id, n.p)
	inOrder(n.right, fn)
}
