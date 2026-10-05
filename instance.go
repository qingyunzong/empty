package main

import (
	"fmt"
	"math/bits"
)

// Node is a voter with a fault domain, a voting weight and a selection cost.
type Node struct {
	ID     string `json:"id"`
	Domain string `json:"domain"`
	Weight int64  `json:"weight"`
	Cost   int64  `json:"cost"`
}

// Constraints bound what counts as a legal quorum.
type Constraints struct {
	MinDomains int `json:"minDomains"`
	MaxSize    int `json:"maxSize"`
	// MaxSteps caps branch-and-bound recursion steps (0 = unlimited).
	// It is a search budget, not part of the quorum definition.
	MaxSteps int64 `json:"-"`
}

// Instance is a validated set of nodes. Subsets are represented as uint64
// bitmasks over the input node order.
type Instance struct {
	Nodes       []Node
	TotalWeight int64
	domIdx      map[string]int
	domNames    []string
}

// NewInstance validates nodes and builds the domain index.
func NewInstance(nodes []Node) (*Instance, error) {
	if len(nodes) == 0 {
		return nil, fmt.Errorf("instance has no nodes")
	}
	if len(nodes) > 64 {
		return nil, fmt.Errorf("at most 64 nodes supported, got %d", len(nodes))
	}
	in := &Instance{Nodes: nodes, domIdx: map[string]int{}}
	seen := map[string]bool{}
	for i, nd := range nodes {
		if nd.ID == "" {
			return nil, fmt.Errorf("node %d: empty id", i)
		}
		if seen[nd.ID] {
			return nil, fmt.Errorf("duplicate node id %q", nd.ID)
		}
		seen[nd.ID] = true
		if nd.Domain == "" {
			return nil, fmt.Errorf("node %q: empty domain", nd.ID)
		}
		if nd.Weight < 0 {
			return nil, fmt.Errorf("node %q: negative weight", nd.ID)
		}
		if nd.Cost < 0 {
			return nil, fmt.Errorf("node %q: negative cost", nd.ID)
		}
		if _, ok := in.domIdx[nd.Domain]; !ok {
			if len(in.domNames) >= 64 {
				return nil, fmt.Errorf("at most 64 distinct domains supported")
			}
			in.domIdx[nd.Domain] = len(in.domNames)
			in.domNames = append(in.domNames, nd.Domain)
		}
		in.TotalWeight += nd.Weight
	}
	return in, nil
}

func (in *Instance) domainBit(nodeIdx int) uint64 {
	return uint64(1) << uint(in.domIdx[in.Nodes[nodeIdx].Domain])
}

// Weight returns the summed weight of the subset.
func (in *Instance) Weight(mask uint64) int64 {
	var w int64
	for m := mask; m != 0; m &= m - 1 {
		w += in.Nodes[bits.TrailingZeros64(m)].Weight
	}
	return w
}

// Cost returns the summed cost of the subset.
func (in *Instance) Cost(mask uint64) int64 {
	var c int64
	for m := mask; m != 0; m &= m - 1 {
		c += in.Nodes[bits.TrailingZeros64(m)].Cost
	}
	return c
}

// Domains returns the domain bitmask of the subset.
func (in *Instance) Domains(mask uint64) uint64 {
	var d uint64
	for m := mask; m != 0; m &= m - 1 {
		d |= in.domainBit(bits.TrailingZeros64(m))
	}
	return d
}

// DomainCount returns the number of distinct domains in the subset.
func (in *Instance) DomainCount(mask uint64) int {
	return bits.OnesCount64(in.Domains(mask))
}

// Size returns the number of nodes in the subset.
func (in *Instance) Size(mask uint64) int {
	return bits.OnesCount64(mask)
}

// Legal reports whether the subset is a valid quorum: strict weight
// majority, at least MinDomains distinct fault domains, at most MaxSize nodes.
func (in *Instance) Legal(mask uint64, cons Constraints) bool {
	if bits.OnesCount64(mask) > cons.MaxSize {
		return false
	}
	if in.Weight(mask)*2 <= in.TotalWeight {
		return false
	}
	return bits.OnesCount64(in.Domains(mask)) >= cons.MinDomains
}

// FTLegal reports whether the subset is a fault-tolerant quorum: it is legal
// and stays legal after the loss of any single member node.
func (in *Instance) FTLegal(mask uint64, cons Constraints) bool {
	if !in.Legal(mask, cons) {
		return false
	}
	for m := mask; m != 0; m &= m - 1 {
		f := m & -m
		if !in.Legal(mask&^f, cons) {
			return false
		}
	}
	return true
}

// Names returns the node IDs of the subset in input order.
func (in *Instance) Names(mask uint64) []string {
	var out []string
	for i := range in.Nodes {
		if mask&(uint64(1)<<uint(i)) != 0 {
			out = append(out, in.Nodes[i].ID)
		}
	}
	return out
}

// DomainNames maps a domain bitmask back to domain names.
func (in *Instance) DomainNames(domBits uint64) []string {
	var out []string
	for i, name := range in.domNames {
		if domBits&(uint64(1)<<uint(i)) != 0 {
			out = append(out, name)
		}
	}
	return out
}
