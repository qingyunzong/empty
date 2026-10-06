// Package boolexec evaluates boolean ASTs with short-circuit semantics while
// counting every node whose evaluation actually begins. Counts are exposed as
// versioned, frozen coverage tables that can migrate across AST rewrites via
// stable node IDs.
package boolexec

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/fnv"
)

// Kind classifies a Node.
type Kind int

const (
	Leaf Kind = iota
	And
	Or
	Not
)

func (k Kind) String() string {
	switch k {
	case Leaf:
		return "leaf"
	case And:
		return "and"
	case Or:
		return "or"
	case Not:
		return "not"
	}
	return "unknown"
}

// LeafFunc evaluates a leaf predicate. It may perform side effects, return an
// error, or panic; the executor converts panics into *PanicError.
type LeafFunc func(ctx context.Context) (bool, error)

// Node is one boolean AST node. IDs must be unique within a tree and are
// expected to remain stable across source rewrites so coverage can migrate.
type Node struct {
	ID       string
	Kind     Kind
	Label    string // leaf identity; part of the structural hash
	Leaf     LeafFunc
	Children []*Node
}

// AndNode builds an n-ary conjunction.
func AndNode(id string, children ...*Node) *Node {
	return &Node{ID: id, Kind: And, Children: children}
}

// OrNode builds an n-ary disjunction.
func OrNode(id string, children ...*Node) *Node {
	return &Node{ID: id, Kind: Or, Children: children}
}

// NotNode builds a negation.
func NotNode(id string, child *Node) *Node {
	return &Node{ID: id, Kind: Not, Children: []*Node{child}}
}

// LeafNode builds a leaf predicate.
func LeafNode(id, label string, fn LeafFunc) *Node {
	return &Node{ID: id, Kind: Leaf, Label: label, Leaf: fn}
}

// ConstLeaf builds a side-effect-free constant leaf.
func ConstLeaf(id string, value bool) *Node {
	return LeafNode(id, fmt.Sprintf("const:%t", value), func(context.Context) (bool, error) {
		return value, nil
	})
}

// Validate checks structural invariants of a tree.
func Validate(n *Node) error {
	seen := map[string]bool{}
	var walk func(m *Node) error
	walk = func(m *Node) error {
		if m == nil {
			return errors.New("boolexec: nil node")
		}
		if m.ID == "" {
			return fmt.Errorf("boolexec: empty node ID (kind %s)", m.Kind)
		}
		if seen[m.ID] {
			return fmt.Errorf("boolexec: duplicate node ID %q", m.ID)
		}
		seen[m.ID] = true
		switch m.Kind {
		case Leaf:
			if m.Leaf == nil {
				return fmt.Errorf("boolexec: leaf %q has nil LeafFunc", m.ID)
			}
			if len(m.Children) != 0 {
				return fmt.Errorf("boolexec: leaf %q must not have children", m.ID)
			}
		case Not:
			if len(m.Children) != 1 {
				return fmt.Errorf("boolexec: not %q needs exactly 1 child", m.ID)
			}
		case And, Or:
			if len(m.Children) == 0 {
				return fmt.Errorf("boolexec: %s %q needs at least 1 child", m.Kind, m.ID)
			}
		default:
			return fmt.Errorf("boolexec: node %q has invalid kind %d", m.ID, m.Kind)
		}
		for _, c := range m.Children {
			if err := walk(c); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(n)
}

// StructuralHash hashes the shape of the subtree rooted at n: kinds, leaf
// labels, and child order. Node IDs and LeafFuncs are deliberately excluded,
// so a rewrite that keeps the same structure yields the same hash, while any
// structural change (kind, label, children) changes it.
func StructuralHash(n *Node) uint64 {
	h := fnv.New64a()
	writeStructuralHash(h, n)
	return h.Sum64()
}

func writeStructuralHash(w interface{ Write([]byte) (int, error) }, n *Node) {
	var buf [binary.MaxVarintLen64]byte
	put := func(v uint64) {
		m := binary.PutUvarint(buf[:], v)
		w.Write(buf[:m])
	}
	put(uint64(n.Kind))
	put(uint64(len(n.Label)))
	w.Write([]byte(n.Label))
	put(uint64(len(n.Children)))
	for _, c := range n.Children {
		writeStructuralHash(w, c)
	}
}
