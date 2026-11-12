package dataeng

import (
	"fmt"
	"math/big"
)

type nodeKind uint8

const (
	nodeElement nodeKind = iota + 1
	nodeSequence
	nodeReplication
	nodeOperator
)

type node struct {
	kind       nodeKind
	desc       Descriptor
	element    ElementDef
	children   []*node
	fixedCount int
	factorBits int
}

// Template is a compiled descriptor graph. It is immutable after Compile and
// safe for concurrent decoding.
type Template struct {
	root []*node
}

type compiler struct {
	elements  ElementTable
	sequences SequenceTable
	memo      map[SequenceKey][]*node
	seqStack  []SequenceKey
}

// Compile validates the complete reachable template and all reachable element
// and sequence definitions. Every branch is compiled, including bodies of
// zero-repeat or delayed replications. Reachable sequence-reference cycles are
// rejected regardless of repetition counts.
func Compile(root []Descriptor, elements ElementTable, sequences SequenceTable) (*Template, error) {
	c := &compiler{
		elements:  elements,
		sequences: sequences,
		memo:      make(map[SequenceKey][]*node),
	}
	nodes, err := c.parseRange(root, 0, len(root), "root")
	if err != nil {
		return nil, err
	}
	return &Template{root: nodes}, nil
}

func (c *compiler) parseRange(descriptors []Descriptor, start, end int, context string) ([]*node, error) {
	if start < 0 || end < start || end > len(descriptors) {
		return nil, &CompileError{Context: context, Err: fmt.Errorf("%w: invalid parse interval [%d,%d)", ErrReplicationBoundary, start, end)}
	}
	nodes := make([]*node, 0, end-start)
	for pos := start; pos < end; {
		n, next, err := c.parseOne(descriptors, pos, end, context)
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
		pos = next
	}
	return nodes, nil
}

func (c *compiler) parseOne(descriptors []Descriptor, pos, boundary int, context string) (*node, int, error) {
	d := descriptors[pos]
	at := func(err error) error {
		desc := d
		return &CompileError{
			Descriptor: &desc,
			Context:    fmt.Sprintf("%s descriptor index %d", context, pos),
			Err:        err,
		}
	}
	if err := d.Validate(); err != nil {
		return nil, 0, at(err)
	}

	switch d.F {
	case 0:
		if d.IsFactor() {
			return nil, 0, at(fmt.Errorf("%w: %s", ErrReservedFactor, d))
		}
		def, ok := c.elements[d.Element()]
		if !ok {
			return nil, 0, at(fmt.Errorf("%w: %s", ErrUnknownElement, d))
		}
		if err := def.Validate(); err != nil {
			return nil, 0, at(err)
		}
		owned := def
		owned.Reference = new(big.Int).Set(def.Reference)
		return &node{kind: nodeElement, desc: d, element: owned}, pos + 1, nil

	case 1:
		if d.X == 0 {
			return nil, 0, at(fmt.Errorf("%w: X must be positive", ErrInvalidReplication))
		}

		bodyStart := pos + 1
		factorBits := 0
		if d.Y == 0 {
			if bodyStart >= boundary {
				return nil, 0, at(fmt.Errorf("%w: delayed replication has no factor descriptor", ErrInvalidReplication))
			}
			factor := descriptors[bodyStart]
			if factor.F != 0 || factor.X != 31 || (factor.Y != 1 && factor.Y != 2) {
				return nil, 0, at(fmt.Errorf("%w: expected 0-31-001 or 0-31-002 after %s, got %s", ErrInvalidFactor, d, factor))
			}
			if factor.Y == 1 {
				factorBits = 8
			} else {
				factorBits = 16
			}
			bodyStart++
		}

		bodyEnd := bodyStart + d.X
		if bodyEnd > boundary {
			return nil, 0, at(fmt.Errorf("%w: %s needs X=%d raw positions at [%d,%d), boundary is %d",
				ErrReplicationBoundary, d, d.X, bodyStart, bodyEnd, boundary))
		}
		children, err := c.parseRange(descriptors, bodyStart, bodyEnd, context+" replication body")
		if err != nil {
			return nil, 0, err
		}
		n := &node{
			kind:       nodeReplication,
			desc:       d,
			children:   children,
			fixedCount: d.Y,
			factorBits: factorBits,
		}
		return n, bodyEnd, nil

	case 2:
		if d.X != 1 && d.X != 2 {
			return nil, 0, at(fmt.Errorf("%w: X must be 1 or 2, got %d", ErrInvalidOperator, d.X))
		}
		return &node{kind: nodeOperator, desc: d}, pos + 1, nil

	case 3:
		children, err := c.compileSequence(d)
		if err != nil {
			return nil, 0, err
		}
		return &node{kind: nodeSequence, desc: d, children: children}, pos + 1, nil
	}

	return nil, 0, at(fmt.Errorf("%w: unsupported F=%d", ErrInvalidDescriptor, d.F))
}

func (c *compiler) compileSequence(d Descriptor) ([]*node, error) {
	key := d.Sequence()
	if nodes, ok := c.memo[key]; ok {
		return nodes, nil
	}
	start, ok := c.sequences[key]
	if !ok {
		desc := d
		return nil, &CompileError{
			Descriptor: &desc,
			Context:    "sequence reference " + d.String(),
			Err:        fmt.Errorf("%w: %s", ErrUnknownSequence, d),
		}
	}
	for _, active := range c.seqStack {
		if active == key {
			desc := d
			return nil, &CompileError{
				Descriptor: &desc,
				Context:    "sequence reference graph",
				Err:        fmt.Errorf("%w: %s is already active", ErrSequenceCycle, d),
			}
		}
	}

	c.seqStack = append(c.seqStack, key)
	nodes, err := c.parseRange(start, 0, len(start), "sequence "+d.String())
	c.seqStack = c.seqStack[:len(c.seqStack)-1]
	if err != nil {
		return nil, err
	}
	c.memo[key] = nodes
	return nodes, nil
}
