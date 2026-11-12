package triejoin

import "sort"

// memNode is one level of the default in-memory ordered trie. keys are sorted
// and distinct; children[i] is the subtree under keys[i] (nil at the leaf).
type memNode struct {
	keys     []int64
	children []*memNode
}

// memPos is one occupied trie level inside a cursor: the node, the index of
// the current value, and whether the level currently holds a value.
type memPos struct {
	node *memNode
	idx  int
}

// MemCursor is the default in-memory TrieIterator. Seek uses binary search and
// never walks values one by one with Next.
type MemCursor struct {
	root   *memNode
	stack  []*memPos
	closed bool
	counts Counts
}

// MemFactory builds default in-memory trie cursors.
type MemFactory struct{}

// NewIterator implements CursorFactory.
func (MemFactory) NewIterator(snap RelationSnapshot) (TrieIterator, error) {
	root := buildMemTrie(snap.Tuples)
	return &MemCursor{root: root}, nil
}

func buildMemTrie(rows [][]int64) *memNode {
	root := &memNode{}
	for _, row := range rows {
		insertMemRow(root, row)
	}
	return root
}

func insertMemRow(root *memNode, row []int64) {
	node := root
	for depth, val := range row {
		i := sort.Search(len(node.keys), func(k int) bool { return node.keys[k] >= val })
		if i < len(node.keys) && node.keys[i] == val {
			if depth == len(row)-1 {
				return
			}
			node = node.children[i]
			continue
		}
		node.keys = append(node.keys, 0)
		copy(node.keys[i+1:], node.keys[i:])
		node.keys[i] = val
		child := &memNode{}
		node.children = append(node.children, nil)
		copy(node.children[i+1:], node.children[i:])
		node.children[i] = child
		node = child
	}
}

func (c *MemCursor) Open() error {
	c.counts.Opens++
	if c.closed {
		return errCursorClosed
	}
	var node *memNode
	if depth := len(c.stack); depth == 0 {
		node = c.root
	} else {
		parent := c.stack[depth-1]
		node = parent.node.children[parent.idx]
	}
	c.stack = append(c.stack, &memPos{node: node, idx: 0})
	return nil
}

func (c *MemCursor) Valid() bool {
	if c.closed || len(c.stack) == 0 {
		return false
	}
	pos := c.stack[len(c.stack)-1]
	return pos.idx < len(pos.node.keys)
}

func (c *MemCursor) At() int64 {
	pos := c.stack[len(c.stack)-1]
	return pos.node.keys[pos.idx]
}

func (c *MemCursor) Next() (bool, error) {
	c.counts.Nexts++
	if c.closed {
		return false, errCursorClosed
	}
	pos := c.stack[len(c.stack)-1]
	pos.idx++
	return pos.idx < len(pos.node.keys), nil
}

// Seek jumps, from the current position, to the smallest key >= target using
// binary search over the suffix starting at the current index.
func (c *MemCursor) SeekTo(target int64) (bool, error) {
	c.counts.Seeks++
	if c.closed {
		return false, errCursorClosed
	}
	pos := c.stack[len(c.stack)-1]
	keys := pos.node.keys
	base := pos.idx
	off := sort.Search(len(keys)-base, func(k int) bool { return keys[base+k] >= target })
	pos.idx = base + off
	return pos.idx < len(keys), nil
}

func (c *MemCursor) Up() error {
	c.counts.Ups++
	if c.closed {
		return errCursorClosed
	}
	if len(c.stack) == 0 {
		return errCursorAtRoot
	}
	c.stack = c.stack[:len(c.stack)-1]
	return nil
}

func (c *MemCursor) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	c.stack = nil
	return nil
}

// Counts returns cumulative operation counters.
func (c *MemCursor) Counts() Counts { return c.counts }
