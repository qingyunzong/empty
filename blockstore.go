// Package blockstore implements a content-addressed block store with
// deduplication, reference counting, transactional root insertion and
// reachability-based liveness verification.
//
// Blocks are keyed by the hash of their content (data plus child hashes),
// so identical content is stored exactly once and tree nodes may share
// sub-blocks. Roots pin their transitive closure; deleting a root
// decrements counts recursively and frees a block only when its last
// reference disappears, so shared sub-blocks are never released twice.
package blockstore

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// Hash identifies a block by its content.
type Hash [32]byte

func (h Hash) String() string { return fmt.Sprintf("%x", h[:8]) }

// Node is a tree node: opaque data plus references to child blocks.
type Node struct {
	Data     []byte
	Children []Hash
}

var (
	ErrEmptyBatch   = errors.New("blockstore: empty node batch")
	ErrUnknownChild = errors.New("blockstore: node references unknown child")
	ErrCycle        = errors.New("blockstore: cyclic reference in batch")
	ErrNotRoot      = errors.New("blockstore: hash is not a live root")
)

// nodeBody is the stored content of a block.
type nodeBody struct {
	data     []byte
	children []Hash
}

type block struct {
	nodeBody
	refs int
}

// Store is a content-addressed block store. It is safe for concurrent use.
type Store struct {
	mu     sync.Mutex
	blocks map[Hash]*block
	roots  map[Hash]int // root hash -> pin count
}

// New returns an empty Store.
func New() *Store {
	return &Store{
		blocks: make(map[Hash]*block),
		roots:  make(map[Hash]int),
	}
}

// HashOf computes the content hash of a node. Callers use it to wire up
// child references before submitting a batch to AddRoot.
func HashOf(n Node) Hash {
	h := sha256.New()
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], uint64(len(n.Data)))
	h.Write(buf[:])
	h.Write(n.Data)
	binary.LittleEndian.PutUint64(buf[:], uint64(len(n.Children)))
	h.Write(buf[:])
	for _, c := range n.Children {
		h.Write(c[:])
	}
	var sum Hash
	copy(sum[:], h.Sum(nil))
	return sum
}

// AddRoot atomically inserts a batch of nodes and pins the last node as a
// root. Nodes already present (by content hash) are deduplicated; only new
// edges and the root pin change their refcounts.
//
// The call is transactional: the batch is fully validated (children
// resolvable, graph acyclic) before any state is mutated, so a failure
// leaves the store exactly as it was.
func (s *Store) AddRoot(nodes ...Node) (Hash, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(nodes) == 0 {
		return Hash{}, ErrEmptyBatch
	}

	// Deduplicate the batch itself by content hash.
	newBlocks := make(map[Hash]nodeBody, len(nodes))
	order := make([]Hash, 0, len(nodes))
	for _, n := range nodes {
		h := HashOf(n)
		if _, dup := newBlocks[h]; !dup {
			order = append(order, h)
		}
		newBlocks[h] = nodeBody{data: n.Data, children: n.Children}
	}
	root := HashOf(nodes[len(nodes)-1])

	// Validation phase: no mutation happens before this point.
	for _, h := range order {
		for _, c := range newBlocks[h].children {
			if _, ok := newBlocks[c]; ok {
				continue
			}
			if _, ok := s.blocks[c]; ok {
				continue
			}
			return Hash{}, fmt.Errorf("%w: %s (referenced by %s)", ErrUnknownChild, c, h)
		}
	}
	if err := checkAcyclic(newBlocks, order); err != nil {
		return Hash{}, err
	}

	// Commit phase: infallible once validation passed.
	for _, h := range order {
		if _, ok := s.blocks[h]; !ok {
			s.blocks[h] = &block{nodeBody: newBlocks[h]}
		}
	}
	for _, h := range order {
		for _, c := range newBlocks[h].children {
			s.blocks[c].refs++
		}
	}
	s.blocks[root].refs++
	s.roots[root]++
	return root, nil
}

// checkAcyclic rejects any cycle within the new batch. Existing blocks are
// already acyclic, so only edges between new nodes need inspection.
func checkAcyclic(newBlocks map[Hash]nodeBody, order []Hash) error {
	const (
		white = iota
		gray
		black
	)
	color := make(map[Hash]int, len(order))
	var visit func(h Hash) error
	visit = func(h Hash) error {
		color[h] = gray
		for _, c := range newBlocks[h].children {
			if _, isNew := newBlocks[c]; !isNew {
				continue
			}
			switch color[c] {
			case gray:
				return fmt.Errorf("%w: %s", ErrCycle, c)
			case white:
				if err := visit(c); err != nil {
					return err
				}
			}
		}
		color[h] = black
		return nil
	}
	for _, h := range order {
		if color[h] == white {
			if err := visit(h); err != nil {
				return err
			}
		}
	}
	return nil
}

// DeleteRoot removes one pin from root and recursively releases every block
// whose refcount drops to zero. Blocks shared with other roots (or reached
// via multiple paths in the same tree) are decremented once per incoming
// reference and freed exactly once, never double-released.
func (s *Store) DeleteRoot(root Hash) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.roots[root] == 0 {
		return ErrNotRoot
	}
	s.roots[root]--
	if s.roots[root] == 0 {
		delete(s.roots, root)
	}
	s.blocks[root].refs-- // remove the root pin
	s.release(root, make(map[Hash]struct{}))
	return nil
}

// release frees h when its refcount reaches zero and cascades into its
// children. The freed set guarantees a shared sub-block is released at most
// once per cascade even if it is reachable through several paths.
func (s *Store) release(h Hash, freed map[Hash]struct{}) {
	b, ok := s.blocks[h]
	if !ok || b.refs > 0 {
		return
	}
	if _, done := freed[h]; done {
		return
	}
	freed[h] = struct{}{}
	delete(s.blocks, h)
	for _, c := range b.children {
		child, ok := s.blocks[c]
		if !ok {
			continue // already freed via another path; never touch twice
		}
		child.refs--
		s.release(c, freed)
	}
}

// Verify performs a full reachability scan from all live roots and checks
// that (a) every reachable block exists, (b) every stored block is
// reachable (no leaks), and (c) every stored refcount equals the number of
// incoming references (root pins plus edges) recomputed from scratch.
func (s *Store) Verify() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	want := make(map[Hash]int, len(s.blocks))
	for r, pins := range s.roots {
		want[r] += pins
	}
	reachable := make(map[Hash]bool, len(s.blocks))
	stack := make([]Hash, 0, len(s.roots))
	for r := range s.roots {
		stack = append(stack, r)
	}
	for len(stack) > 0 {
		h := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if reachable[h] {
			continue
		}
		b, ok := s.blocks[h]
		if !ok {
			return fmt.Errorf("blockstore: reachable block %s is missing", h)
		}
		reachable[h] = true
		for _, c := range b.children {
			want[c]++
			stack = append(stack, c)
		}
	}
	for h, b := range s.blocks {
		if !reachable[h] {
			return fmt.Errorf("blockstore: unreachable block %s leaked (refs=%d)", h, b.refs)
		}
		if b.refs != want[h] {
			return fmt.Errorf("blockstore: block %s refs=%d, want %d", h, b.refs, want[h])
		}
	}
	return nil
}

// Get returns the node stored under h.
func (s *Store) Get(h Hash) (Node, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.blocks[h]
	if !ok {
		return Node{}, false
	}
	return Node{Data: b.data, Children: b.children}, true
}

// Has reports whether a block is stored under h.
func (s *Store) Has(h Hash) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.blocks[h]
	return ok
}

// RefCount returns the current reference count of h (0 if absent).
func (s *Store) RefCount(h Hash) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b, ok := s.blocks[h]; ok {
		return b.refs
	}
	return 0
}

// IsRoot reports whether h is a live root.
func (s *Store) IsRoot(h Hash) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.roots[h] > 0
}

// Roots returns the live root hashes in sorted order.
func (s *Store) Roots() []Hash {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Hash, 0, len(s.roots))
	for r := range s.roots {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		return string(out[i][:]) < string(out[j][:])
	})
	return out
}

// BlockCount returns the number of stored blocks.
func (s *Store) BlockCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.blocks)
}
