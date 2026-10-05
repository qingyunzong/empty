package sigdb

import (
	"encoding/binary"
	"fmt"
	"math/big"
)

// node is an immutable treap node keyed by segment start. Every node carries
// the exact rational sum of all segment integrals in its subtree plus the
// subtree time span, so range queries prune whole subtrees. Updates path-copy
// only O(log n) nodes; old roots keep referring to untouched nodes, which is
// what lets old readers keep their snapshot after a batch is published.
type node struct {
	key   int64 // segment start t0
	pri   uint64
	t1    int64
	v0    *big.Rat
	v1    *big.Rat
	sum   *big.Rat // sum of segment integrals in subtree
	lo    int64    // min segment start in subtree
	hi    int64    // max segment end in subtree
	left  *node
	right *node
	page  int64 // page id once persisted; 0 while unpersisted
}

func priority(key int64) uint64 {
	// splitmix64: deterministic, so replays are reproducible.
	z := uint64(key) + 0x9e3779b97f4a7c15
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

func newNode(s segment) *node {
	n := &node{key: s.t0, pri: priority(s.t0), t1: s.t1, v0: s.v0, v1: s.v1}
	return recalc(n)
}

func recalc(n *node) *node {
	n.sum = segIntegral(n.key, n.v0, n.t1, n.v1, n.key, n.t1)
	n.lo, n.hi = n.key, n.t1
	if n.left != nil {
		n.sum.Add(n.sum, n.left.sum)
		if n.left.lo < n.lo {
			n.lo = n.left.lo
		}
		if n.left.hi > n.hi {
			n.hi = n.left.hi
		}
	}
	if n.right != nil {
		n.sum.Add(n.sum, n.right.sum)
		if n.right.lo < n.lo {
			n.lo = n.right.lo
		}
		if n.right.hi > n.hi {
			n.hi = n.right.hi
		}
	}
	return n
}

func withLeft(n *node, l *node) *node {
	return recalc(&node{key: n.key, pri: n.pri, t1: n.t1, v0: n.v0, v1: n.v1, left: l, right: n.right})
}
func withRight(n *node, r *node) *node {
	return recalc(&node{key: n.key, pri: n.pri, t1: n.t1, v0: n.v0, v1: n.v1, left: n.left, right: r})
}

func rotateRight(n *node) *node {
	l := n.left
	return recalc(withRight(l, withLeft(n, l.right)))
}

func rotateLeft(n *node) *node {
	r := n.right
	return recalc(withLeft(r, withRight(n, r.left)))
}

// insert adds (or replaces) a segment, returning the new root.
func insert(n *node, s segment) *node {
	if n == nil {
		return newNode(s)
	}
	switch {
	case s.t0 == n.key:
		return recalc(&node{key: n.key, pri: n.pri, t1: s.t1, v0: s.v0, v1: s.v1, left: n.left, right: n.right})
	case s.t0 < n.key:
		nn := withLeft(n, insert(n.left, s))
		if nn.left.pri > nn.pri {
			nn = rotateRight(nn)
		}
		return nn
	default:
		nn := withRight(n, insert(n.right, s))
		if nn.right.pri > nn.pri {
			nn = rotateLeft(nn)
		}
		return nn
	}
}

// remove deletes key, returning the new root.
func remove(n *node, key int64) *node {
	if n == nil {
		return nil
	}
	switch {
	case key < n.key:
		return withLeft(n, remove(n.left, key))
	case key > n.key:
		return withRight(n, remove(n.right, key))
	default:
		return merge(n.left, n.right)
	}
}

func merge(l, r *node) *node {
	if l == nil {
		return r
	}
	if r == nil {
		return l
	}
	if l.pri > r.pri {
		return withRight(l, merge(l.right, r))
	}
	return withLeft(r, merge(l, r.left))
}

// integral returns the exact integral of the signal over [a, b].
func (n *node) integral(a, b int64) *big.Rat {
	if n == nil || a >= b || a >= n.hi || b <= n.lo {
		return new(big.Rat)
	}
	if a <= n.lo && n.hi <= b {
		return new(big.Rat).Set(n.sum)
	}
	acc := new(big.Rat)
	if n.left != nil {
		acc.Add(acc, n.left.integral(a, b))
	}
	if n.key < b && a < n.t1 {
		acc.Add(acc, segIntegral(n.key, n.v0, n.t1, n.v1, a, b))
	}
	if n.right != nil {
		acc.Add(acc, n.right.integral(a, b))
	}
	return acc
}

// collectUnpersisted appends every unpersisted node reachable from n to out
// in post-order (children before parents), so page ids of children are known
// when a parent is serialised.
func collectUnpersisted(n *node, out *[]*node) {
	if n == nil || n.page != 0 {
		return
	}
	collectUnpersisted(n.left, out)
	collectUnpersisted(n.right, out)
	*out = append(*out, n)
}

// encodeNode serialises n; children must already have page ids.
func encodeNode(n *node) []byte {
	buf := make([]byte, 0, 64)
	var tb [8]byte
	binary.LittleEndian.PutUint64(tb[:], uint64(n.key))
	buf = append(buf, tb[:]...)
	binary.LittleEndian.PutUint64(tb[:], uint64(n.t1))
	buf = append(buf, tb[:]...)
	binary.LittleEndian.PutUint64(tb[:], uint64(n.left.pageID()))
	buf = append(buf, tb[:]...)
	binary.LittleEndian.PutUint64(tb[:], uint64(n.right.pageID()))
	buf = append(buf, tb[:]...)
	buf = appendRat(buf, n.v0)
	buf = appendRat(buf, n.v1)
	return buf
}

func (n *node) pageID() int64 {
	if n == nil {
		return 0
	}
	return n.page
}

func decodeNode(buf []byte) (*node, int64, int64, error) {
	if len(buf) < 32 {
		return nil, 0, 0, fmt.Errorf("sigdb: corrupt node page")
	}
	n := &node{}
	n.key = int64(binary.LittleEndian.Uint64(buf[0:8]))
	n.t1 = int64(binary.LittleEndian.Uint64(buf[8:16]))
	lp := int64(binary.LittleEndian.Uint64(buf[16:24]))
	rp := int64(binary.LittleEndian.Uint64(buf[24:32]))
	buf = buf[32:]
	var err error
	if n.v0, buf, err = readRat(buf); err != nil {
		return nil, 0, 0, err
	}
	if n.v1, buf, err = readRat(buf); err != nil {
		return nil, 0, 0, err
	}
	n.pri = priority(n.key)
	return n, lp, rp, nil
}
