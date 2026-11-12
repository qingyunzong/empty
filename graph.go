package dataeng

import "sort"

type graphEdge struct {
	b      byte
	output uint64
	target int
}

type graphState struct {
	final       bool
	finalOutput uint64
	edges       []graphEdge
	// count is the number of accepted suffixes from this state. Shared
	// states keep one count, but every incoming edge contributes that count
	// to its own parent, so multiple paths are counted correctly.
	count uint64
}

// Graph is an immutable, acyclic, deterministic additive transducer returned
// by Builder.Finish. Its fields are unexported; all query methods are
// read-only.
type Graph struct {
	initialOutput uint64
	root          int
	nodes         []graphState
}

// Transducer is an alias for Graph.
type Transducer = Graph

// Finish freezes the builder and returns its immutable graph. Calling Finish
// again returns the same graph. Add calls after Finish are rejected.
func (b *Builder) Finish() (*Graph, error) {
	if b.graph != nil {
		return b.graph, nil
	}

	// Register the still-open last-key path bottom-up, including the root's
	// outgoing edges. The root itself is kept separate because it owns the
	// initial output.
	for i := len(b.path) - 1; i >= 1; i-- {
		id, err := b.canonicalize(b.path[i])
		if err != nil {
			return nil, err
		}
		parent := b.path[i-1]
		edge := parent.edges[b.lastKey[i-1]]
		if edge == nil || edge.mutable != b.path[i] {
			return nil, ErrInternal
		}
		edge.mutable = nil
		edge.canonID = id
	}
	for _, edge := range b.root.edges {
		if edge.mutable != nil {
			return nil, ErrInternal
		}
	}

	nodes := make([]graphState, len(b.registry)+1)
	nodes[0] = graphState{
		final:       b.root.final,
		finalOutput: b.root.finalOutput,
		edges:       copyRootEdges(b.root),
	}
	for id, canonical := range b.registry {
		edges := make([]graphEdge, len(canonical.edges))
		for i, edge := range canonical.edges {
			edges[i] = graphEdge{
				b:      edge.b,
				output: edge.output,
				target: edge.target + 1,
			}
		}
		nodes[id+1] = graphState{
			final:       canonical.final,
			finalOutput: canonical.finalOutput,
			edges:       edges,
		}
	}

	g := &Graph{initialOutput: b.root.min, root: 0, nodes: nodes}
	if err := g.computeCounts(); err != nil {
		return nil, err
	}
	b.frozen = true
	b.graph = g
	return g, nil
}

func copyRootEdges(root *mutableState) []graphEdge {
	edges := make([]graphEdge, 0, len(root.edges))
	for by, edge := range root.edges {
		if edge.mutable != nil {
			continue
		}
		edges = append(edges, graphEdge{
			b:      by,
			output: edge.output,
			target: edge.canonID + 1,
		})
	}
	sort.Slice(edges, func(i, j int) bool { return edges[i].b < edges[j].b })
	return edges
}

// computeCounts fills every state's accepted-suffix count. Registry ids are
// assigned child-before-parent, so counting in ascending id order visits every
// child first. Each edge occurrence adds the target's count independently.
func (g *Graph) computeCounts() error {
	for i := 0; i < len(g.nodes)-1; i++ {
		state := &g.nodes[i+1]
		count := uint64(0)
		if state.final {
			count = 1
		}
		for _, edge := range state.edges {
			if edge.target <= 0 || edge.target > i {
				return ErrInternal
			}
			child := g.nodes[edge.target].count
			sum, err := checkedAdd(count, child)
			if err != nil {
				return err
			}
			count = sum
		}
		state.count = count
	}

	root := &g.nodes[g.root]
	count := uint64(0)
	if root.final {
		count = 1
	}
	for _, edge := range root.edges {
		if edge.target <= 0 || edge.target >= len(g.nodes) {
			return ErrInternal
		}
		child := g.nodes[edge.target].count
		sum, err := checkedAdd(count, child)
		if err != nil {
			return err
		}
		count = sum
	}
	root.count = count
	return nil
}

// InitialOutput returns the output emitted at the root before consuming any
// byte. For a non-empty dictionary it is the minimum original value.
func (g *Graph) InitialOutput() uint64 { return g.initialOutput }

// StateCount returns the number of reachable states in the frozen graph.
func (g *Graph) StateCount() int { return len(g.nodes) }

// EdgeCount returns the number of edges in the frozen graph.
func (g *Graph) EdgeCount() int {
	n := 0
	for _, state := range g.nodes {
		n += len(state.edges)
	}
	return n
}

// Lookup returns the original value for key. found is false when the exact
// key is absent; stopping at a non-accepting state is explicitly not a match.
func (g *Graph) Lookup(key []byte) (value uint64, found bool, err error) {
	node := g.root
	value = g.initialOutput
	for _, by := range key {
		target, output, ok := g.findEdge(node, by)
		if !ok {
			return 0, false, nil
		}
		value, err = checkedAdd(value, output)
		if err != nil {
			return 0, false, err
		}
		node = target
	}
	state := g.nodes[node]
	if !state.final {
		return 0, false, nil
	}
	value, err = checkedAdd(value, state.finalOutput)
	if err != nil {
		return 0, false, err
	}
	return value, true, nil
}

func (g *Graph) findEdge(node int, by byte) (target int, output uint64, ok bool) {
	edges := g.nodes[node].edges
	// Edges are byte-sorted, so a linear scan also identifies all smaller
	// branches for Rank.
	for _, edge := range edges {
		if edge.b > by {
			break
		}
		if edge.b == by {
			return edge.target, edge.output, true
		}
	}
	return 0, 0, false
}

// Rank returns the number of stored keys strictly less than key in unsigned
// byte lexicographic order. It can be larger than zero even when key itself
// is absent.
func (g *Graph) Rank(key []byte) (uint64, error) {
	node := g.root
	rank := uint64(0)

	for _, by := range key {
		state := g.nodes[node]
		if state.final {
			// The current prefix is a key and the query has more bytes, so
			// the key is strictly smaller than the query.
			sum, err := checkedAdd(rank, 1)
			if err != nil {
				return 0, err
			}
			rank = sum
		}

		target := -1
		for _, edge := range state.edges {
			if edge.b < by {
				childCount := g.nodes[edge.target].count
				sum, err := checkedAdd(rank, childCount)
				if err != nil {
					return 0, err
				}
				rank = sum
				continue
			}
			if edge.b == by {
				target = edge.target
			}
			break
		}
		if target < 0 {
			return rank, nil
		}
		node = target
	}
	return rank, nil
}

// Select returns the index-th key in zero-based unsigned-byte lexicographic
// order together with its original value. found is false when index is out of
// range.
func (g *Graph) Select(index uint64) (key []byte, value uint64, found bool, err error) {
	if index >= g.nodes[g.root].count {
		return nil, 0, false, nil
	}

	node := g.root
	value = g.initialOutput
	for {
		state := g.nodes[node]
		if state.final {
			if index == 0 {
				value, err = checkedAdd(value, state.finalOutput)
				if err != nil {
					return nil, 0, false, err
				}
				return key, value, true, nil
			}
			index--
		}

		descended := false
		for _, edge := range state.edges {
			childCount := g.nodes[edge.target].count
			if index < childCount {
				key = append(key, edge.b)
				value, err = checkedAdd(value, edge.output)
				if err != nil {
					return nil, 0, false, err
				}
				node = edge.target
				descended = true
				break
			}
			index -= childCount
		}
		if !descended {
			return nil, 0, false, nil
		}
	}
}
