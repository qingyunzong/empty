package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// MaxEnumerationEntities bounds EnumeratePartitions because the number of set
// partitions grows as the Bell numbers. Ten entities already yield 115,975
// partitions in the unconstrained case.
const MaxEnumerationEntities = 10

// ErrEnumerationTooLarge is returned when partition enumeration is requested
// for more than MaxEnumerationEntities entities.
var ErrEnumerationTooLarge = errors.New("dataeng: too many entities for partition enumeration")

// Partition is a set of non-empty blocks. Blocks and their members are sorted
// lexicographically by EnumeratePartitions.
type Partition [][]string

// String renders a partition as "{a b} {c d}".
func (p Partition) String() string {
	parts := make([]string, len(p))
	for i, block := range p {
		parts[i] = "{" + strings.Join(block, " ") + "}"
	}
	return strings.Join(parts, " ")
}

// EnumeratePartitions enumerates every partition of the graph's entities that
// satisfies all hard must-link and cannot-link constraints. It is intended for
// small graphs and is an independent oracle for checking greedy clustering.
//
// Partitions are produced in restricted-growth (canonical block-label) order.
func (g *Graph) EnumeratePartitions() ([]Partition, error) {
	nodes := g.Entities()
	if len(nodes) > MaxEnumerationEntities {
		return nil, fmt.Errorf("%w: got %d entities, maximum is %d",
			ErrEnumerationTooLarge, len(nodes), MaxEnumerationEntities)
	}
	if len(nodes) == 0 {
		return []Partition{{}}, nil
	}

	index := make(map[string]int, len(nodes))
	for i, id := range nodes {
		index[id] = i
	}

	type check struct {
		other int
		kind  LinkKind
	}
	checks := make([][]check, len(nodes))
	addCheck := func(a, b string, kind LinkKind) {
		i, j := index[a], index[b]
		if i == j {
			return
		}
		if i < j {
			i, j = j, i
		}
		checks[i] = append(checks[i], check{other: j, kind: kind})
	}
	for _, p := range g.must {
		addCheck(p.Left, p.Right, LinkMust)
	}
	for _, p := range g.cannot {
		addCheck(p.Left, p.Right, LinkCannot)
	}

	labels := make([]int, len(nodes))
	used := 0
	partitions := make([]Partition, 0)

	var walk func(int)
	walk = func(i int) {
		if i == len(nodes) {
			blocks := make([][]string, used)
			for idx, label := range labels {
				blocks[label] = append(blocks[label], nodes[idx])
			}
			partitions = append(partitions, Partition(blocks))
			return
		}

		// Labels 0..used-1 are existing blocks; label "used" starts a new one.
		for label := 0; label <= used; label++ {
			ok := true
			for _, c := range checks[i] {
				switch c.kind {
				case LinkMust:
					if labels[c.other] != label {
						ok = false
					}
				case LinkCannot:
					if labels[c.other] == label {
						ok = false
					}
				}
				if !ok {
					break
				}
			}
			if !ok {
				continue
			}

			labels[i] = label
			oldUsed := used
			if label == used {
				used++
			}
			walk(i + 1)
			used = oldUsed
		}
	}

	walk(0)
	return partitions, nil
}

// Canonical returns a copy with sorted members, sorted blocks, and no empty
// blocks.
func (p Partition) Canonical() Partition {
	out := make(Partition, 0, len(p))
	for _, block := range p {
		if len(block) == 0 {
			continue
		}
		members := append([]string(nil), block...)
		sort.Strings(members)
		out = append(out, members)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i][0] < out[j][0]
	})
	return out
}
