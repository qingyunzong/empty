// Package refexp is a deliberately small, independent reference expander for
// inspection and tests. It flattens a template into element leaves and paths
// using bounded recursion and a caller-supplied delayed-factor reader.
//
// It is not used by the production decoder. In particular, it does not read
// bits, apply operators, or compute values. Its purpose is to make the raw-X
// boundary and repetition-path rules easy to audit on tiny templates.
package refexp

import (
	"errors"
	"fmt"

	de "example.org/dataeng/q0298"
)

var (
	ErrLimit             = errors.New("reference expansion limit exceeded")
	ErrBoundary          = errors.New("reference replication boundary error")
	ErrCycle             = errors.New("reference sequence cycle")
	ErrMissingDefinition = errors.New("reference missing definition")
	ErrInvalidFactor     = errors.New("reference invalid factor")
)

// Step mirrors a production nesting-path step.
type Step struct {
	Kind       de.PathKind
	Descriptor de.Descriptor
	Iteration  int
}

// Leaf is one element occurrence in execution order.
type Leaf struct {
	Descriptor de.Descriptor
	Path       []Step
}

// Options controls the small reference implementation.
// MaxLeaves is inclusive; MaxDepth is inclusive and root depth is zero. A nil
// Factor is only acceptable when no delayed replication is executed.
type Options struct {
	MaxLeaves int
	MaxDepth  int
	Factor    func(width int) (uint64, error)
}

type kind uint8

const (
	elementKind kind = iota + 1
	sequenceKind
	replicationKind
	operatorKind
)

type node struct {
	kind       kind
	desc       de.Descriptor
	children   []*node
	fixed      int
	factorBits int
}

type compiler struct {
	elements  de.ElementTable
	sequences de.SequenceTable
	memo      map[de.SequenceKey][]*node
	stack     []de.SequenceKey
}

// Expand validates the reachable structure and then emits element leaves in
// execution order. Delayed factors are consumed through opts.Factor at the
// points where the production executor would read them.
func Expand(root []de.Descriptor, elements de.ElementTable, sequences de.SequenceTable, opts Options) ([]Leaf, error) {
	if opts.MaxLeaves < 0 || opts.MaxDepth < -1 {
		return nil, fmt.Errorf("%w: invalid options", ErrLimit)
	}
	c := &compiler{
		elements:  elements,
		sequences: sequences,
		memo:      make(map[de.SequenceKey][]*node),
	}
	nodes, err := c.parse(root, 0, len(root))
	if err != nil {
		return nil, err
	}
	e := emitter{opts: opts}
	if err := e.emit(nodes, 0, nil); err != nil {
		return nil, err
	}
	return e.leaves, nil
}

func (c *compiler) parse(descs []de.Descriptor, start, end int) ([]*node, error) {
	if start < 0 || end < start || end > len(descs) {
		return nil, ErrBoundary
	}
	var nodes []*node
	for pos := start; pos < end; {
		n, next, err := c.one(descs, pos, end)
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
		pos = next
	}
	return nodes, nil
}

func (c *compiler) one(descs []de.Descriptor, pos, end int) (*node, int, error) {
	d := descs[pos]
	if err := d.Validate(); err != nil {
		return nil, 0, err
	}
	switch d.F {
	case 0:
		if d.IsFactor() {
			return nil, 0, fmt.Errorf("%w: reserved factor %s", ErrInvalidFactor, d)
		}
		def, ok := c.elements[d.Element()]
		if !ok {
			return nil, 0, fmt.Errorf("%w: %s", ErrMissingDefinition, d)
		}
		if err := def.Validate(); err != nil {
			return nil, 0, err
		}
		return &node{kind: elementKind, desc: d}, pos + 1, nil

	case 1:
		if d.X == 0 {
			return nil, 0, fmt.Errorf("%w: X=0", ErrBoundary)
		}
		bodyStart := pos + 1
		bits := 0
		if d.Y == 0 {
			if bodyStart >= end {
				return nil, 0, fmt.Errorf("%w: missing delayed factor", ErrInvalidFactor)
			}
			f := descs[bodyStart]
			if f.F != 0 || f.X != 31 || (f.Y != 1 && f.Y != 2) {
				return nil, 0, fmt.Errorf("%w: got %s", ErrInvalidFactor, f)
			}
			if f.Y == 1 {
				bits = 8
			} else {
				bits = 16
			}
			bodyStart++
		}
		bodyEnd := bodyStart + d.X
		if bodyEnd > end {
			return nil, 0, fmt.Errorf("%w: %s body [%d,%d) exceeds %d", ErrBoundary, d, bodyStart, bodyEnd, end)
		}
		children, err := c.parse(descs, bodyStart, bodyEnd)
		if err != nil {
			return nil, 0, err
		}
		return &node{kind: replicationKind, desc: d, children: children, fixed: d.Y, factorBits: bits}, bodyEnd, nil

	case 2:
		if d.X != 1 && d.X != 2 {
			return nil, 0, fmt.Errorf("invalid operator %s", d)
		}
		return &node{kind: operatorKind, desc: d}, pos + 1, nil

	case 3:
		children, err := c.sequence(d)
		if err != nil {
			return nil, 0, err
		}
		return &node{kind: sequenceKind, desc: d, children: children}, pos + 1, nil
	}
	return nil, 0, fmt.Errorf("invalid descriptor %s", d)
}

func (c *compiler) sequence(d de.Descriptor) ([]*node, error) {
	key := d.Sequence()
	if nodes, ok := c.memo[key]; ok {
		return nodes, nil
	}
	list, ok := c.sequences[key]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrMissingDefinition, d)
	}
	for _, active := range c.stack {
		if active == key {
			return nil, fmt.Errorf("%w: %s", ErrCycle, d)
		}
	}
	c.stack = append(c.stack, key)
	nodes, err := c.parse(list, 0, len(list))
	c.stack = c.stack[:len(c.stack)-1]
	if err != nil {
		return nil, err
	}
	c.memo[key] = nodes
	return nodes, nil
}

type emitter struct {
	opts   Options
	leaves []Leaf
}

func (e *emitter) emit(nodes []*node, depth int, path []Step) error {
	for _, n := range nodes {
		switch n.kind {
		case elementKind:
			if e.opts.MaxLeaves >= 0 && len(e.leaves) >= e.opts.MaxLeaves {
				return fmt.Errorf("%w: max leaves %d", ErrLimit, e.opts.MaxLeaves)
			}
			e.leaves = append(e.leaves, Leaf{
				Descriptor: n.desc,
				Path:       append([]Step(nil), path...),
			})

		case operatorKind:
			// Operators do not create leaves.

		case sequenceKind:
			if e.opts.MaxDepth >= 0 && depth+1 > e.opts.MaxDepth {
				return fmt.Errorf("%w: max depth %d", ErrLimit, e.opts.MaxDepth)
			}
			next := append(path, Step{Kind: de.PathSequence, Descriptor: n.desc})
			if err := e.emit(n.children, depth+1, next); err != nil {
				return err
			}

		case replicationKind:
			count := n.fixed
			if n.factorBits != 0 {
				if e.opts.Factor == nil {
					return fmt.Errorf("%w: no factor reader", ErrInvalidFactor)
				}
				v, err := e.opts.Factor(n.factorBits)
				if err != nil {
					return err
				}
				allOnes := ^uint64(0) >> uint(64-n.factorBits)
				if v == allOnes {
					return fmt.Errorf("%w: %d-bit factor is all ones", ErrInvalidFactor, n.factorBits)
				}
				count = int(v)
			}
			if count == 0 {
				continue
			}
			if e.opts.MaxDepth >= 0 && depth+1 > e.opts.MaxDepth {
				return fmt.Errorf("%w: max depth %d", ErrLimit, e.opts.MaxDepth)
			}
			for i := 1; i <= count; i++ {
				next := append(path, Step{Kind: de.PathReplication, Descriptor: n.desc, Iteration: i})
				if err := e.emit(n.children, depth+1, next); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
