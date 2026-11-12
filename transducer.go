package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"sort"
)

// Errors returned by Builder.Add and Builder.Finish. Invalid key input
// (ordering, duplication, or a non-first empty key) is rejected before any
// mutation, so the caller may continue with a valid key.
var (
	ErrFrozen           = errors.New("dataeng: builder is already finished")
	ErrKeyOrder         = errors.New("dataeng: keys must be strictly increasing")
	ErrDuplicateKey     = errors.New("dataeng: duplicate key")
	ErrEmptyKeyNotFirst = errors.New("dataeng: empty key may only be added first")
	ErrOverflow         = errors.New("dataeng: uint64 overflow")
	ErrInternal         = errors.New("dataeng: internal graph invariant violated")
)

// Stats describes the incremental construction state after a successful Add.
// MutableStates includes the root and every prefix of the last key.
// RetainedKeys is the number of complete historical keys still used by the
// builder; it is at most one.
type Stats struct {
	MutableStates    int
	RegisteredStates int
	RetainedKeys     int
}

type mutableEdge struct {
	output  uint64
	mutable *mutableState // non-nil for the single open path edge
	canonID int           // valid when mutable is nil
}

type mutableState struct {
	final       bool
	finalOutput uint64
	// min is the absolute minimum original value in this state's subtree.
	// For every normalized state, the remaining-output minimum is zero, so
	// this also equals the accumulated output on the path to this occurrence.
	min   uint64
	edges map[byte]*mutableEdge
}

type canonicalEdge struct {
	b      byte
	output uint64
	target int
}

type canonicalState struct {
	final       bool
	finalOutput uint64
	edges       []canonicalEdge
}

// Builder incrementally constructs a minimal acyclic deterministic additive
// transducer. Only the prefix path of the most recently added key is mutable;
// all closed suffixes are immediately canonicalized into an immutable registry.
type Builder struct {
	root *mutableState

	// path[i] is the mutable state after consuming the first i bytes of
	// lastKey. path[0] is the root.
	path    []*mutableState
	lastKey []byte
	hasKeys bool

	registry      []*canonicalState
	registryBySig map[string]int

	stats  Stats
	frozen bool
	graph  *Graph
}

// NewBuilder returns an empty dictionary builder.
func NewBuilder() *Builder {
	root := newMutableState()
	return &Builder{
		root:          root,
		path:          []*mutableState{root},
		registryBySig: make(map[string]int),
		stats:         Stats{MutableStates: 1},
	}
}

// New is an alias for NewBuilder.
func New() *Builder { return NewBuilder() }

func newMutableState() *mutableState {
	return &mutableState{edges: make(map[byte]*mutableEdge)}
}

// Stats returns the construction counters after the most recent successful
// Add. It is unchanged by a failed Add.
func (b *Builder) Stats() Stats { return b.stats }

// Add inserts a key and its original uint64 value. Keys must be added in
// strictly increasing unsigned-byte lexicographic order and may not repeat.
// The empty key may only be the first key.
func (b *Builder) Add(key []byte, value uint64) error {
	if b.frozen {
		return ErrFrozen
	}
	if len(key) == 0 && b.hasKeys {
		if len(b.lastKey) == 0 {
			return ErrDuplicateKey
		}
		return ErrEmptyKeyNotFirst
	}
	if b.hasKeys {
		switch cmp := bytes.Compare(key, b.lastKey); {
		case cmp == 0:
			return ErrDuplicateKey
		case cmp < 0:
			return ErrKeyOrder
		}
	}

	// No builder state has been changed so far. From here on all arithmetic
	// is over values that are bounded by the supplied uint64 values, so the
	// checked operations below cannot fail for a valid insertion.
	prefixLen := 0
	if b.hasKeys {
		prefixLen = commonPrefix(b.lastKey, key)
	} else {
		// The first value defines the absolute minimum of the root subtree.
		b.root.min = value
	}

	// The new key is in every subtree along the common prefix, so those
	// subtrees' minima may decrease. Compute the new minima first: an edge
	// on the path must be updated to the difference of the two new minima,
	// while closed sibling edges only need the parent's decrease pushed into
	// their output in order to preserve their target values.
	oldMins := make([]uint64, prefixLen+1)
	newMins := make([]uint64, prefixLen+1)
	for i := 0; i <= prefixLen; i++ {
		oldMins[i] = b.path[i].min
		newMins[i] = oldMins[i]
		if value < newMins[i] {
			newMins[i] = value
		}
	}

	for i := 0; i <= prefixLen; i++ {
		node := b.path[i]
		delta := oldMins[i] - newMins[i]
		node.min = newMins[i]

		if delta != 0 && node.final {
			final, err := checkedAdd(node.finalOutput, delta)
			if err != nil {
				return err
			}
			node.finalOutput = final
		}

		for _, edge := range node.edges {
			if i < prefixLen && edge.mutable == b.path[i+1] {
				// Both endpoints moved along the new key. The normalized
				// edge output is the difference of their new minima.
				output, err := checkedSub(newMins[i+1], newMins[i])
				if err != nil {
					return err
				}
				edge.output = output
				continue
			}
			if delta != 0 {
				// This subtree does not contain the new key, so its minimum
				// is unchanged. Push its parent's decrease into the edge.
				output, err := checkedAdd(edge.output, delta)
				if err != nil {
					return err
				}
				edge.output = output
			}
		}
	}

	// Everything on the previous path below the divergence point is now a
	// closed suffix. Register it bottom-up before adding the new branch.
	if b.hasKeys && prefixLen < len(b.lastKey) {
		for i := len(b.path) - 1; i >= prefixLen+1; i-- {
			id, err := b.canonicalize(b.path[i])
			if err != nil {
				return err
			}
			parent := b.path[i-1]
			edge := parent.edges[b.lastKey[i-1]]
			if edge == nil || edge.mutable != b.path[i] {
				return ErrInternal
			}
			edge.mutable = nil
			edge.canonID = id
		}
	}

	parent := b.path[prefixLen]
	newPath := make([]*mutableState, prefixLen+1, len(key)+1)
	copy(newPath, b.path[:prefixLen+1])

	if len(key) == prefixLen {
		// This is the first (and therefore empty) key. Every other key that
		// ends at an existing prefix would violate strict key ordering.
		if parent.final {
			return ErrDuplicateKey
		}
		parent.final = true
		final, err := checkedSub(value, parent.min)
		if err != nil {
			return err
		}
		parent.finalOutput = final
	} else {
		for j := prefixLen; j < len(key); j++ {
			if _, exists := parent.edges[key[j]]; exists {
				// Strict ordering guarantees that the new maximum key only
				// appends to a state's largest prefix branch.
				return ErrInternal
			}
			child := newMutableState()
			child.min = value
			output, err := checkedSub(value, parent.min)
			if err != nil {
				return err
			}
			parent.edges[key[j]] = &mutableEdge{output: output, mutable: child}
			if j == len(key)-1 {
				child.final = true
				child.finalOutput = 0
			}
			newPath = append(newPath, child)
			parent = child
		}
	}

	b.lastKey = append([]byte(nil), key...)
	b.path = newPath
	b.hasKeys = true
	b.stats = Stats{
		MutableStates:    len(newPath),
		RegisteredStates: len(b.registry),
		RetainedKeys:     1,
	}
	return nil
}

func commonPrefix(a, b []byte) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	i := 0
	for i < n && a[i] == b[i] {
		i++
	}
	return i
}

// canonicalize converts a completely closed mutable state into its canonical
// registry representative. Its children must already be canonical.
func (b *Builder) canonicalize(m *mutableState) (int, error) {
	edges := make([]canonicalEdge, 0, len(m.edges))
	for by, edge := range m.edges {
		if edge.mutable != nil {
			return 0, ErrInternal
		}
		edges = append(edges, canonicalEdge{
			b:      by,
			output: edge.output,
			target: edge.canonID,
		})
	}
	sort.Slice(edges, func(i, j int) bool { return edges[i].b < edges[j].b })

	sig := stateSignature(m.final, m.finalOutput, edges)
	if id, ok := b.registryBySig[sig]; ok {
		return id, nil
	}
	id := len(b.registry)
	b.registry = append(b.registry, &canonicalState{
		final:       m.final,
		finalOutput: m.finalOutput,
		edges:       edges,
	})
	b.registryBySig[sig] = id
	return id, nil
}

// stateSignature encodes the complete normal form of a state. Two states have
// identical signatures exactly when they have the same final flag and output,
// the same byte-sorted edge set, and the same canonical edge targets.
func stateSignature(final bool, finalOutput uint64, edges []canonicalEdge) string {
	var out []byte
	if final {
		out = append(out, 1)
	} else {
		out = append(out, 0)
	}
	out = binary.BigEndian.AppendUint64(out, finalOutput)
	out = binary.BigEndian.AppendUint64(out, uint64(len(edges)))
	for _, edge := range edges {
		out = append(out, edge.b)
		out = binary.BigEndian.AppendUint64(out, edge.output)
		out = binary.BigEndian.AppendUint64(out, uint64(edge.target))
	}
	return string(out)
}

func checkedAdd(a, b uint64) (uint64, error) {
	sum := a + b
	if sum < a {
		return 0, ErrOverflow
	}
	return sum, nil
}

func checkedSub(a, b uint64) (uint64, error) {
	if a < b {
		return 0, ErrOverflow
	}
	return a - b, nil
}
