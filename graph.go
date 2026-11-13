package dataeng

import (
	"fmt"
	"sort"
	"sync"
)

// MissingParent identifies a child dependency that is absent from the graph.
type MissingParent struct {
	ShardID  ShardID
	ParentID ShardID
	Adjacent bool
}

func (m MissingParent) String() string {
	kind := "parent"
	if m.Adjacent {
		kind = "adjacent parent"
	}
	return fmt.Sprintf("%s %s of shard %s", kind, m.ParentID, m.ShardID)
}

// ShardGraph stores the reshard forest observed from DescribeStream. It is
// safe for concurrent reads and observations.
type ShardGraph struct {
	mu     sync.RWMutex
	shards map[ShardID]Shard
}

// NewShardGraph builds a graph from shard descriptions. Duplicate observations
// may refine an open shard with a later ending sequence number, but a
// conflicting parent or ending sequence is rejected.
func NewShardGraph(shards ...Shard) (*ShardGraph, error) {
	g := &ShardGraph{shards: make(map[ShardID]Shard, len(shards))}
	if err := g.AddAll(shards...); err != nil {
		return nil, err
	}
	return g, nil
}

// Add observes one shard.
func (g *ShardGraph) Add(shard Shard) error {
	return g.AddAll(shard)
}

// AddAll atomically merges shard observations. If any observation conflicts or
// creates a cycle, no observation in this call is retained.
func (g *ShardGraph) AddAll(shards ...Shard) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.shards == nil {
		g.shards = make(map[ShardID]Shard)
	}
	next := make(map[ShardID]Shard, len(g.shards)+len(shards))
	for id, shard := range g.shards {
		next[id] = shard
	}
	for _, observed := range shards {
		if err := observed.Validate(); err != nil {
			return err
		}
		existing, ok := next[observed.ShardID]
		if !ok {
			next[observed.ShardID] = normalizeShard(observed)
			continue
		}
		merged, err := mergeShard(existing, observed)
		if err != nil {
			return err
		}
		next[observed.ShardID] = merged
	}
	if cycle := findCycle(next); cycle != nil {
		return cycle
	}
	g.shards = next
	return nil
}

// Observe is an alias for AddAll.
func (g *ShardGraph) Observe(shards ...Shard) error {
	return g.AddAll(shards...)
}

func normalizeShard(s Shard) Shard {
	return Shard{
		ShardID:                s.ShardID,
		ParentShardID:          s.ParentShardID,
		AdjacentParentShardID:  s.AdjacentParentShardID,
		StartingSequenceNumber: s.StartingSequenceNumber,
		EndingSequenceNumber:   s.EndingSequenceNumber,
	}
}

func mergeShard(existing, observed Shard) (Shard, error) {
	observed = normalizeShard(observed)
	if existing.ParentShardID != observed.ParentShardID {
		return Shard{}, &ShardConflictError{
			ShardID:  existing.ShardID,
			Field:    "parent shard",
			Existing: string(existing.ParentShardID),
			Observed: string(observed.ParentShardID),
		}
	}
	if existing.AdjacentParentShardID != observed.AdjacentParentShardID {
		return Shard{}, &ShardConflictError{
			ShardID:  existing.ShardID,
			Field:    "adjacent parent shard",
			Existing: string(existing.AdjacentParentShardID),
			Observed: string(observed.AdjacentParentShardID),
		}
	}

	merged := existing
	if merged.StartingSequenceNumber == "" {
		merged.StartingSequenceNumber = observed.StartingSequenceNumber
	} else if observed.StartingSequenceNumber != "" &&
		merged.StartingSequenceNumber != observed.StartingSequenceNumber {
		return Shard{}, &ShardConflictError{
			ShardID:  existing.ShardID,
			Field:    "starting sequence number",
			Existing: string(existing.StartingSequenceNumber),
			Observed: string(observed.StartingSequenceNumber),
		}
	}
	if merged.EndingSequenceNumber == "" {
		merged.EndingSequenceNumber = observed.EndingSequenceNumber
	} else if observed.EndingSequenceNumber != "" &&
		merged.EndingSequenceNumber != observed.EndingSequenceNumber {
		return Shard{}, &ShardConflictError{
			ShardID:  existing.ShardID,
			Field:    "ending sequence number",
			Existing: string(existing.EndingSequenceNumber),
			Observed: string(observed.EndingSequenceNumber),
		}
	}
	return merged, nil
}

// Has reports whether the graph knows the shard.
func (g *ShardGraph) Has(id ShardID) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	_, ok := g.shards[id]
	return ok
}

// Shard returns the current description and whether it is known.
func (g *ShardGraph) Shard(id ShardID) (Shard, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	shard, ok := g.shards[id]
	return shard, ok
}

// Len returns the number of known shards.
func (g *ShardGraph) Len() int {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return len(g.shards)
}

// Shards returns a copy ordered by shard ID.
func (g *ShardGraph) Shards() []Shard {
	g.mu.RLock()
	shards := make([]Shard, 0, len(g.shards))
	for _, shard := range g.shards {
		shards = append(shards, shard)
	}
	g.mu.RUnlock()
	sortShards(shards)
	return shards
}

// ParentIDs returns the known dependencies of a shard. An unknown shard has no
// dependencies. Missing parents are included because they are still
// dependencies.
func (g *ShardGraph) ParentIDs(id ShardID) []ShardID {
	g.mu.RLock()
	defer g.mu.RUnlock()
	shard, ok := g.shards[id]
	if !ok {
		return nil
	}
	return shard.ParentIDs()
}

// Children returns the direct children of a shard in shard-ID order.
func (g *ShardGraph) Children(id ShardID) []ShardID {
	g.mu.RLock()
	children := make([]ShardID, 0)
	for childID, shard := range g.shards {
		for _, parentID := range shard.ParentIDs() {
			if parentID == id {
				children = append(children, childID)
				break
			}
		}
	}
	g.mu.RUnlock()
	sort.Slice(children, func(i, j int) bool { return children[i] < children[j] })
	return children
}

// MissingParents returns all absent dependencies in a deterministic order.
func (g *ShardGraph) MissingParents() []MissingParent {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return missingParents(g.shards)
}

// MissingParentsOf returns a child's absent dependencies. It returns nil for
// an unknown child.
func (g *ShardGraph) MissingParentsOf(id ShardID) []MissingParent {
	g.mu.RLock()
	defer g.mu.RUnlock()
	shard, ok := g.shards[id]
	if !ok {
		return nil
	}
	return missingParentsOf(shard, g.shards)
}

func missingParents(shards map[ShardID]Shard) []MissingParent {
	result := make([]MissingParent, 0)
	for _, shard := range shards {
		result = append(result, missingParentsOf(shard, shards)...)
	}
	sortMissingParents(result)
	return result
}

func missingParentsOf(shard Shard, shards map[ShardID]Shard) []MissingParent {
	result := make([]MissingParent, 0, 2)
	add := func(parent ShardID, adjacent bool) {
		if parent == "" {
			return
		}
		if _, ok := shards[parent]; ok {
			return
		}
		for _, existing := range result {
			if existing.ParentID == parent {
				return
			}
		}
		result = append(result, MissingParent{
			ShardID:  shard.ShardID,
			ParentID: parent,
			Adjacent: adjacent,
		})
	}
	add(shard.ParentShardID, false)
	add(shard.AdjacentParentShardID, true)
	return result
}

func sortMissingParents(parents []MissingParent) {
	sort.Slice(parents, func(i, j int) bool {
		if parents[i].ShardID != parents[j].ShardID {
			return parents[i].ShardID < parents[j].ShardID
		}
		return parents[i].ParentID < parents[j].ParentID
	})
}

func sortShards(shards []Shard) {
	sort.Slice(shards, func(i, j int) bool { return shards[i].ShardID < shards[j].ShardID })
}

// findCycle returns a cycle path, repeating the first node at the end, or nil.
func findCycle(shards map[ShardID]Shard) *CycleError {
	const (
		unvisited = iota
		visiting
		visited
	)
	state := make(map[ShardID]int, len(shards))
	stack := make([]ShardID, 0, len(shards))
	var visit func(ShardID) *CycleError
	visit = func(id ShardID) *CycleError {
		switch state[id] {
		case visiting:
			start := 0
			for i, node := range stack {
				if node == id {
					start = i
					break
				}
			}
			path := append([]ShardID(nil), stack[start:]...)
			path = append(path, id)
			return &CycleError{Path: path}
		case visited:
			return nil
		}
		state[id] = visiting
		stack = append(stack, id)
		shard, ok := shards[id]
		if ok {
			for _, parent := range shard.ParentIDs() {
				if _, exists := shards[parent]; !exists {
					continue
				}
				if cycle := visit(parent); cycle != nil {
					return cycle
				}
			}
		}
		stack = stack[:len(stack)-1]
		state[id] = visited
		return nil
	}
	for id := range shards {
		if cycle := visit(id); cycle != nil {
			return cycle
		}
	}
	return nil
}
