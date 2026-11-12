package dataeng

import (
	"errors"
	"fmt"
	"math/bits"
)

// Compile validates g and builds its structural support sets. An invalid graph
// is rejected without partial enumeration or logical simplification.
func Compile(g *Graph) (*CompiledGraph, error) {
	if g == nil {
		return nil, errors.New("graph is nil")
	}
	if len(g.Facts) > maxFacts {
		return nil, fmt.Errorf("graph has %d facts; maximum is %d", len(g.Facts), maxFacts)
	}
	if len(g.Nodes) > maxNodes {
		return nil, fmt.Errorf("graph has %d nodes; maximum is %d", len(g.Nodes), maxNodes)
	}

	c := &CompiledGraph{
		facts:     append([]string(nil), g.Facts...),
		factIndex: make(map[string]int, len(g.Facts)),
		nodes:     make(map[string]compiledNode, len(g.Nodes)),
		nodeIDs:   make([]string, 0, len(g.Nodes)),
		root:      g.Root,
		support:   make(map[string]uint64, len(g.Nodes)),
	}

	for idx, fact := range c.facts {
		if _, exists := c.factIndex[fact]; exists {
			return nil, fmt.Errorf("duplicate fact ID %q", fact)
		}
		c.factIndex[fact] = idx
		c.universeMask |= uint64(1) << idx
	}

	for _, node := range g.Nodes {
		if _, exists := c.nodes[node.ID]; exists {
			return nil, fmt.Errorf("duplicate node ID %q", node.ID)
		}
		switch node.Kind {
		case NodeZero, NodeOne, NodeAnd, NodeDecide:
		default:
			return nil, fmt.Errorf("node %q has unknown kind %d", node.ID, node.Kind)
		}

		compiled := compiledNode{
			kind:          node.Kind,
			children:      append([]string(nil), node.Children...),
			variableIndex: -1,
			then:          node.Then,
			elseID:        node.Else,
		}
		if node.Kind == NodeDecide {
			idx, exists := c.factIndex[node.Variable]
			if !exists {
				return nil, fmt.Errorf("DECIDE node %q uses unknown fact %q", node.ID, node.Variable)
			}
			compiled.variableIndex = idx
		}
		c.nodes[node.ID] = compiled
		c.nodeIDs = append(c.nodeIDs, node.ID)
	}

	if _, exists := c.nodes[c.root]; !exists {
		return nil, fmt.Errorf("root node %q does not exist", c.root)
	}

	for id, node := range c.nodes {
		switch node.kind {
		case NodeAnd:
			for _, child := range node.children {
				if _, exists := c.nodes[child]; !exists {
					return nil, fmt.Errorf("AND node %q references missing node %q", id, child)
				}
			}
		case NodeDecide:
			if _, exists := c.nodes[node.then]; !exists {
				return nil, fmt.Errorf("DECIDE node %q references missing then node %q", id, node.then)
			}
			if _, exists := c.nodes[node.elseID]; !exists {
				return nil, fmt.Errorf("DECIDE node %q references missing else node %q", id, node.elseID)
			}
		}
	}

	state := make(map[string]uint8, len(c.nodes))
	const (
		unvisited = 0
		visiting  = 1
		visited   = 2
	)

	var visit func(string) (uint64, error)
	visit = func(id string) (uint64, error) {
		switch state[id] {
		case visiting:
			return 0, fmt.Errorf("graph contains a cycle through node %q", id)
		case visited:
			return c.support[id], nil
		}
		state[id] = visiting
		node := c.nodes[id]
		var mask uint64

		switch node.kind {
		case NodeZero, NodeOne:
		case NodeAnd:
			for _, child := range node.children {
				childMask, err := visit(child)
				if err != nil {
					return 0, err
				}
				if conflict := mask & childMask; conflict != 0 {
					factIdx := bits.TrailingZeros64(conflict)
					return 0, fmt.Errorf("AND node %q has overlapping fact %q in child %q", id, c.facts[factIdx], child)
				}
				mask |= childMask
			}
		case NodeDecide:
			thenMask, err := visit(node.then)
			if err != nil {
				return 0, err
			}
			elseMask, err := visit(node.elseID)
			if err != nil {
				return 0, err
			}
			decisionMask := uint64(1) << node.variableIndex
			if thenMask&decisionMask != 0 {
				return 0, fmt.Errorf("DECIDE node %q variable %q appears in its then support", id, c.facts[node.variableIndex])
			}
			if elseMask&decisionMask != 0 {
				return 0, fmt.Errorf("DECIDE node %q variable %q appears in its else support", id, c.facts[node.variableIndex])
			}
			mask = thenMask | elseMask | decisionMask
		}

		state[id] = visited
		c.support[id] = mask
		return mask, nil
	}

	for _, id := range c.nodeIDs {
		if _, err := visit(id); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// Facts returns a copy of the fact universe.
func (c *CompiledGraph) Facts() []string {
	return append([]string(nil), c.facts...)
}

// RootSupport returns the structural support of the root in fact-order.
func (c *CompiledGraph) RootSupport() []string {
	return c.maskToStrings(c.support[c.root])
}

// Support returns the structural support of nodeID in fact-order.
func (c *CompiledGraph) Support(nodeID string) ([]string, bool) {
	mask, ok := c.support[nodeID]
	if !ok {
		return nil, false
	}
	return c.maskToStrings(mask), true
}

// Supports returns a copy of every node's structural support.
func (c *CompiledGraph) Supports() map[string][]string {
	result := make(map[string][]string, len(c.support))
	for id, mask := range c.support {
		result[id] = c.maskToStrings(mask)
	}
	return result
}

func (c *CompiledGraph) maskToStrings(mask uint64) []string {
	result := make([]string, 0, bits.OnesCount64(mask))
	for idx, fact := range c.facts {
		if mask&(uint64(1)<<idx) != 0 {
			result = append(result, fact)
		}
	}
	return result
}
