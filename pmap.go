package geomlib

// pmap is a persistent (immutable) treap-based ordered map. Updates perform
// path copying only, so old versions keep working and unchanged subtrees are
// structurally shared between versions. Node priorities are a deterministic
// hash of the key, giving a deterministic shape per key set.
type pmap[K any, V any] struct {
	root *pnode[K, V]
	less func(a, b K) bool
	prio func(K) uint64
	size int
}

type pnode[K any, V any] struct {
	key         K
	val         V
	prio        uint64
	left, right *pnode[K, V]
}

func newPmap[K any, V any](less func(a, b K) bool, prio func(K) uint64) pmap[K, V] {
	return pmap[K, V]{less: less, prio: prio}
}

func (m pmap[K, V]) len() int { return m.size }

func (m pmap[K, V]) get(key K) (V, bool) {
	for n := m.root; n != nil; {
		switch {
		case m.less(key, n.key):
			n = n.left
		case m.less(n.key, key):
			n = n.right
		default:
			return n.val, true
		}
	}
	var zero V
	return zero, false
}

func (m pmap[K, V]) put(key K, val V) pmap[K, V] {
	root, inserted := m.insert(m.root, key, val)
	m.root = root
	if inserted {
		m.size++
	}
	return m
}

func (m pmap[K, V]) del(key K) pmap[K, V] {
	root, gone := m.erase(m.root, key)
	if !gone {
		return m
	}
	m.root = root
	m.size--
	return m
}

func (m pmap[K, V]) insert(n *pnode[K, V], key K, val V) (*pnode[K, V], bool) {
	if n == nil {
		return &pnode[K, V]{key: key, val: val, prio: m.prio(key)}, true
	}
	switch {
	case m.less(key, n.key):
		l, ins := m.insert(n.left, key, val)
		if l.prio > n.prio {
			rn := &pnode[K, V]{key: n.key, val: n.val, prio: n.prio, left: l.right, right: n.right}
			return &pnode[K, V]{key: l.key, val: l.val, prio: l.prio, left: l.left, right: rn}, ins
		}
		return &pnode[K, V]{key: n.key, val: n.val, prio: n.prio, left: l, right: n.right}, ins
	case m.less(n.key, key):
		r, ins := m.insert(n.right, key, val)
		if r.prio > n.prio {
			ln := &pnode[K, V]{key: n.key, val: n.val, prio: n.prio, left: n.left, right: r.left}
			return &pnode[K, V]{key: r.key, val: r.val, prio: r.prio, left: ln, right: r.right}, ins
		}
		return &pnode[K, V]{key: n.key, val: n.val, prio: n.prio, left: n.left, right: r}, ins
	default:
		return &pnode[K, V]{key: n.key, val: val, prio: n.prio, left: n.left, right: n.right}, false
	}
}

func (m pmap[K, V]) erase(n *pnode[K, V], key K) (*pnode[K, V], bool) {
	if n == nil {
		return nil, false
	}
	switch {
	case m.less(key, n.key):
		l, gone := m.erase(n.left, key)
		if !gone {
			return n, false
		}
		return &pnode[K, V]{key: n.key, val: n.val, prio: n.prio, left: l, right: n.right}, true
	case m.less(n.key, key):
		r, gone := m.erase(n.right, key)
		if !gone {
			return n, false
		}
		return &pnode[K, V]{key: n.key, val: n.val, prio: n.prio, left: n.left, right: r}, true
	default:
		return mergeNodes(n.left, n.right), true
	}
}

func mergeNodes[K, V any](l, r *pnode[K, V]) *pnode[K, V] {
	switch {
	case l == nil:
		return r
	case r == nil:
		return l
	case l.prio >= r.prio:
		return &pnode[K, V]{key: l.key, val: l.val, prio: l.prio, left: l.left, right: mergeNodes(l.right, r)}
	default:
		return &pnode[K, V]{key: r.key, val: r.val, prio: r.prio, left: mergeNodes(l, r.left), right: r.right}
	}
}

// each iterates over entries in ascending key order.
func (m pmap[K, V]) each(fn func(K, V)) {
	var walk func(n *pnode[K, V])
	walk = func(n *pnode[K, V]) {
		if n == nil {
			return
		}
		walk(n.left)
		fn(n.key, n.val)
		walk(n.right)
	}
	walk(m.root)
}

func mix64(z uint64) uint64 {
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}
