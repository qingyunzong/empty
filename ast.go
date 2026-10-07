// Package boolcov provides an instrumented evaluator for boolean ASTs.
//
// The evaluator counts the nodes it actually starts evaluating: && and ||
// short-circuit, so a right operand that is never reached is never counted.
// Nodes that have begun evaluation are counted even when a read panics,
// returns an error, or the context is cancelled mid-flight.
package boolcov

import (
	"encoding/binary"
	"hash"
	"hash/fnv"
)

// Kind enumerates boolean AST node types.
type Kind int

const (
	KindConst Kind = iota // constant boolean, uses Value
	KindVar               // variable read by name, uses Name
	KindNot               // unary negation, uses Left
	KindAnd               // short-circuit conjunction, uses Left and Right
	KindOr                // short-circuit disjunction, uses Left and Right
)

// Node is a boolean AST node. ID is a stable identifier assigned by the
// producer of the AST; it is preserved across rewrites so coverage counts
// can migrate. ID is intentionally excluded from structure hashes.
type Node struct {
	ID    string
	Kind  Kind
	Value bool   // KindConst
	Name  string // KindVar
	Left  *Node  // all non-leaf kinds
	Right *Node  // KindAnd, KindOr
}

// ownHash hashes only the node's own structure (kind and local fields),
// not its children and not its ID. Two nodes with the same ownHash are
// interchangeable as far as their own evaluation record is concerned.
func ownHash(n *Node) uint64 {
	h := fnv.New64a()
	writeOwn(h, n)
	return h.Sum64()
}

func writeOwn(h hash.Hash64, n *Node) {
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], uint64(n.Kind))
	h.Write(buf[:])
	switch n.Kind {
	case KindConst:
		if n.Value {
			h.Write([]byte{1})
		} else {
			h.Write([]byte{0})
		}
	case KindVar:
		h.Write([]byte(n.Name))
		h.Write([]byte{0})
	}
}

// treeHash hashes the entire subtree structure rooted at n, excluding IDs.
// It identifies a source version: any structural change anywhere in the
// tree produces a new version.
func treeHash(n *Node) uint64 {
	h := fnv.New64a()
	writeTree(h, n)
	return h.Sum64()
}

func writeTree(h hash.Hash64, n *Node) {
	writeOwn(h, n)
	switch n.Kind {
	case KindNot:
		writeTree(h, n.Left)
	case KindAnd, KindOr:
		writeTree(h, n.Left)
		writeTree(h, n.Right)
	}
}

// walk visits every node in the subtree rooted at n, depth-first.
func walk(n *Node, fn func(*Node)) {
	fn(n)
	switch n.Kind {
	case KindNot:
		walk(n.Left, fn)
	case KindAnd, KindOr:
		walk(n.Left, fn)
		walk(n.Right, fn)
	}
}
