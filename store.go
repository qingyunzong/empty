// Package blockstore implements a content-addressed block store with
// deduplication, shareable tree objects, reference counting, and
// transactional root management. Block liveness is verified with a
// full reachability scan from the registered roots.
package blockstore

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

var (
	// ErrNotFound is returned when a referenced block does not exist.
	ErrNotFound = errors.New("blockstore: block not found")
	// ErrNotRoot is returned when removing a hash that is not a root.
	ErrNotRoot = errors.New("blockstore: not a root")
	// ErrCycle is returned when input would introduce a reference cycle.
	ErrCycle = errors.New("blockstore: cyclic reference rejected")
	// ErrDangling is returned when a tree references a missing block.
	ErrDangling = errors.New("blockstore: dangling reference")
	// ErrTxDone is returned when using a finished transaction.
	ErrTxDone = errors.New("blockstore: transaction already finished")
)

// Hash is the content address of a block.
type Hash [32]byte

func (h Hash) String() string { return hex.EncodeToString(h[:8]) }

type block struct {
	data     []byte // leaf payload; nil for tree nodes
	children []Hash // tree node references; nil for leaves
	refs     int    // number of roots that can reach this block
}

// Store is a content-addressed block store. It is not safe for
// concurrent use.
type Store struct {
	blocks map[Hash]*block
	roots  map[Hash]int // root hash -> number of times registered
}

// New returns an empty Store.
func New() *Store {
	return &Store{
		blocks: make(map[Hash]*block),
		roots:  make(map[Hash]int),
	}
}

func hashLeaf(data []byte) Hash {
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(data)
	var sum Hash
	copy(sum[:], h.Sum(nil))
	return sum
}

func hashTree(children []Hash) Hash {
	h := sha256.New()
	h.Write([]byte{0x01})
	for _, c := range children {
		h.Write(c[:])
	}
	var sum Hash
	copy(sum[:], h.Sum(nil))
	return sum
}

// PutLeaf stores data as a leaf block and returns its content hash.
// Identical content is deduplicated: the same hash is returned and no
// new block is created.
func (s *Store) PutLeaf(data []byte) Hash {
	h := hashLeaf(data)
	if _, ok := s.blocks[h]; !ok {
		s.blocks[h] = &block{data: data}
	}
	return h
}

// PutTree stores a tree node referencing existing child blocks and
// returns its content hash. Identical child lists are deduplicated.
// All children must already exist in the store.
func (s *Store) PutTree(children []Hash) (Hash, error) {
	for _, c := range children {
		if _, ok := s.blocks[c]; !ok {
			return Hash{}, fmt.Errorf("%w: child %s", ErrNotFound, c)
		}
	}
	h := hashTree(children)
	if _, ok := s.blocks[h]; !ok {
		s.blocks[h] = &block{children: append([]Hash(nil), children...)}
	}
	return h, nil
}

// Has reports whether a block exists.
func (s *Store) Has(h Hash) bool {
	_, ok := s.blocks[h]
	return ok
}

// Refs returns the reference count of a block (0 if absent).
func (s *Store) Refs(h Hash) int {
	if b, ok := s.blocks[h]; ok {
		return b.refs
	}
	return 0
}

// BlockCount returns the number of stored blocks.
func (s *Store) BlockCount() int { return len(s.blocks) }

// RootCount returns the number of registered roots.
func (s *Store) RootCount() int { return len(s.roots) }

// reachableFrom returns the set of blocks reachable from h, counting
// each block exactly once no matter how many paths lead to it.
func (s *Store) reachableFrom(h Hash) map[Hash]struct{} {
	seen := make(map[Hash]struct{})
	var walk func(h Hash)
	walk = func(h Hash) {
		if _, ok := seen[h]; ok {
			return
		}
		seen[h] = struct{}{}
		b := s.blocks[h]
		if b == nil {
			return
		}
		for _, c := range b.children {
			walk(c)
		}
	}
	walk(h)
	return seen
}

// AddRoot registers h as a root, incrementing the reference count of
// every reachable block exactly once. The same root may be registered
// multiple times; each registration holds its own reference.
func (s *Store) AddRoot(h Hash) error {
	if _, ok := s.blocks[h]; !ok {
		return fmt.Errorf("%w: root %s", ErrNotFound, h)
	}
	s.roots[h]++
	for r := range s.reachableFrom(h) {
		s.blocks[r].refs++
	}
	return nil
}

// RemoveRoot unregisters one reference to root h and decrements the
// reference count of every reachable block exactly once. Blocks whose
// count drops to zero are freed; sub-blocks shared with other roots
// (or reached via multiple paths) are never freed twice.
func (s *Store) RemoveRoot(h Hash) error {
	if s.roots[h] == 0 {
		return fmt.Errorf("%w: %s", ErrNotRoot, h)
	}
	s.roots[h]--
	if s.roots[h] == 0 {
		delete(s.roots, h)
	}
	for r := range s.reachableFrom(h) {
		b := s.blocks[r]
		b.refs--
		if b.refs == 0 {
			delete(s.blocks, r)
		}
	}
	return nil
}

// checkAcyclic performs a full scan of the block graph and returns
// ErrCycle if any reference cycle exists.
func (s *Store) checkAcyclic() error {
	const (
		white = iota // unvisited
		gray         // on current DFS path
		black        // fully explored
	)
	color := make(map[Hash]int, len(s.blocks))
	var visit func(h Hash) error
	visit = func(h Hash) error {
		switch color[h] {
		case gray:
			return fmt.Errorf("%w at %s", ErrCycle, h)
		case black:
			return nil
		}
		color[h] = gray
		if b := s.blocks[h]; b != nil {
			for _, c := range b.children {
				if err := visit(c); err != nil {
					return err
				}
			}
		}
		color[h] = black
		return nil
	}
	for h := range s.blocks {
		if color[h] == white {
			if err := visit(h); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkResolved performs a full scan verifying that every tree
// reference points to an existing block.
func (s *Store) checkResolved() error {
	for h, b := range s.blocks {
		for _, c := range b.children {
			if _, ok := s.blocks[c]; !ok {
				return fmt.Errorf("%w: %s references missing %s", ErrDangling, h, c)
			}
		}
	}
	return nil
}

// Verify performs a full reachability scan from all roots and checks
// that every stored block's reference count exactly matches the number
// of root references that reach it, that the graph is acyclic, and
// that no reference dangles. It returns nil when the store is
// consistent.
func (s *Store) Verify() error {
	if err := s.checkResolved(); err != nil {
		return err
	}
	if err := s.checkAcyclic(); err != nil {
		return err
	}
	want := make(map[Hash]int, len(s.blocks))
	for root, count := range s.roots {
		if _, ok := s.blocks[root]; !ok {
			return fmt.Errorf("%w: root %s", ErrNotFound, root)
		}
		for h := range s.reachableFrom(root) {
			want[h] += count
		}
	}
	for h, b := range s.blocks {
		if b.refs != want[h] {
			return fmt.Errorf("blockstore: block %s has refs %d, reachability expects %d", h, b.refs, want[h])
		}
	}
	return nil
}

// CollectGarbage performs a full reachability scan from all roots and
// frees every unreachable block, returning the number freed.
func (s *Store) CollectGarbage() int {
	live := make(map[Hash]struct{}, len(s.blocks))
	for root := range s.roots {
		for h := range s.reachableFrom(root) {
			live[h] = struct{}{}
		}
	}
	freed := 0
	for h := range s.blocks {
		if _, ok := live[h]; !ok {
			delete(s.blocks, h)
			freed++
		}
	}
	return freed
}
