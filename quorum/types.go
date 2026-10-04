// Package quorum finds minimum-cost quorum sets under weight and
// fault-domain constraints, using only the Go standard library.
package quorum

import (
	"encoding/json"
	"fmt"
)

const (
	// MaxQuorumVoters is the maximum number of candidate voters accepted
	// by the single-quorum solver.
	MaxQuorumVoters = 22
	// MaxPairVoters is the maximum number of candidate voters accepted
	// by the read/write pair solver.
	MaxPairVoters = 18
	// MinDomains is the minimum number of distinct fault domains a legal
	// quorum must span.
	MinDomains = 2
)

// Node is one input node. Cost is optional and defaults to 1.
type Node struct {
	ID     string `json:"id"`
	Weight int64  `json:"weight"`
	Cost   *int64 `json:"cost,omitempty"`
	Domain string `json:"domain"`
	Voter  bool   `json:"voter"`
}

// Input is the CLI input document.
//
// Nodes carry their fault domain, weight and whether they belong to the
// candidate voting set (Voter). Only candidate voters may join a quorum
// and only their weight counts toward the total weight.
//
// AllowedFaults optionally restricts the single-fault scenarios the pair
// solver must tolerate; each entry is a fault domain name. When empty,
// every domain present among candidate voters is treated as an allowed
// single fault.
type Input struct {
	Nodes         []Node   `json:"nodes"`
	AllowedFaults []string `json:"allowed_faults,omitempty"`
}

// ParseInput decodes and validates an input document.
func ParseInput(data []byte) (*Input, error) {
	var in Input
	if err := json.Unmarshal(data, &in); err != nil {
		return nil, fmt.Errorf("decoding input: %w", err)
	}
	if err := in.Validate(); err != nil {
		return nil, err
	}
	return &in, nil
}

// Validate checks structural constraints of the input.
func (in *Input) Validate() error {
	seen := make(map[string]bool, len(in.Nodes))
	for i, n := range in.Nodes {
		if n.ID == "" {
			return fmt.Errorf("node %d: empty id", i)
		}
		if seen[n.ID] {
			return fmt.Errorf("duplicate node id %q", n.ID)
		}
		seen[n.ID] = true
		if n.Weight <= 0 {
			return fmt.Errorf("node %q: weight must be positive, got %d", n.ID, n.Weight)
		}
		if n.Cost != nil && *n.Cost < 0 {
			return fmt.Errorf("node %q: cost must be non-negative, got %d", n.ID, *n.Cost)
		}
		if n.Domain == "" {
			return fmt.Errorf("node %q: empty fault domain", n.ID)
		}
	}
	return nil
}

func (n Node) effectiveCost() int64 {
	if n.Cost == nil {
		return 1
	}
	return *n.Cost
}

// voter is the internal view of a candidate voting node.
type voter struct {
	id     string
	weight int64
	cost   int64
	domain int // index into the domain name table
}

// voters extracts the candidate voting set and assigns dense domain indices.
func voters(in *Input) (vs []voter, domNames []string) {
	domIndex := map[string]int{}
	for _, n := range in.Nodes {
		if !n.Voter {
			continue
		}
		di, ok := domIndex[n.Domain]
		if !ok {
			di = len(domNames)
			domIndex[n.Domain] = di
			domNames = append(domNames, n.Domain)
		}
		vs = append(vs, voter{id: n.ID, weight: n.Weight, cost: n.effectiveCost(), domain: di})
	}
	return vs, domNames
}

func totalWeight(vs []voter) int64 {
	var total int64
	for _, v := range vs {
		total += v.weight
	}
	return total
}

// faultList resolves the allowed single-fault scenarios to domain names.
// Defaults to every domain present among candidate voters.
func faultList(in *Input, domNames []string) ([]string, error) {
	if len(in.AllowedFaults) == 0 {
		return domNames, nil
	}
	known := map[string]bool{}
	for _, n := range in.Nodes {
		known[n.Domain] = true
	}
	seen := map[string]bool{}
	var out []string
	for _, f := range in.AllowedFaults {
		if !known[f] {
			return nil, fmt.Errorf("allowed fault %q: unknown fault domain", f)
		}
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out, nil
}

func memberIDs(vs []voter, mask uint64) []string {
	var out []string
	for i, v := range vs {
		if mask>>uint(i)&1 == 1 {
			out = append(out, v.id)
		}
	}
	return out
}

func domainNamesOf(domNames []string, mask uint64) []string {
	var out []string
	for i, name := range domNames {
		if mask>>uint(i)&1 == 1 {
			out = append(out, name)
		}
	}
	return out
}
