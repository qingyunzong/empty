package depimpact

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// ChangeSet describes what changed between the old and the new graph.
type ChangeSet struct {
	// Changed lists file IDs whose content changed.
	Changed []string `json:"changed"`
	// Deleted lists file IDs removed in the new graph. They keep their
	// old-graph influence because analysis runs on the merged graph.
	Deleted []string `json:"deleted"`
	// Tests lists the test node IDs to report impact for.
	Tests []string `json:"tests"`
}

// ParseChangeSet builds a ChangeSet from its JSON representation.
func ParseChangeSet(data []byte) (*ChangeSet, error) {
	var cs ChangeSet
	if err := json.Unmarshal(data, &cs); err != nil {
		return nil, fmt.Errorf("depimpact: parsing change set: %w", err)
	}
	return &cs, nil
}

// LoadChangeSet reads and parses a change set JSON file.
func LoadChangeSet(path string) (*ChangeSet, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("depimpact: reading change set %q: %w", path, err)
	}
	return ParseChangeSet(data)
}

// DeletedNodes returns the effective set of deleted nodes: the explicit
// ChangeSet.Deleted entries union every node present in old but absent
// from new.
func DeletedNodes(old, new *Graph, cs *ChangeSet) []string {
	deleted := make(map[string]struct{})
	if cs != nil {
		for _, id := range cs.Deleted {
			deleted[id] = struct{}{}
		}
	}
	if old != nil {
		for _, id := range old.Nodes() {
			if new == nil || !new.Has(id) {
				deleted[id] = struct{}{}
			}
		}
	}
	return sortedKeys(deleted)
}

// Impact is the analysis result for a single test.
type Impact struct {
	Test     string   `json:"test"`
	Affected bool     `json:"affected"`
	Path     []string `json:"path,omitempty"`
}

// Analyze merges the old and new graphs (deleted nodes keep their
// old-graph influence) and, for every test in cs.Tests, computes the
// shortest dependency path from any changed node to that test along
// dependent edges. Among equally short paths the lexicographically
// smallest ID sequence wins. The search is cycle-safe: every node is
// settled exactly once. Results are sorted by test ID.
func Analyze(old, new *Graph, cs *ChangeSet) []Impact {
	if cs == nil {
		cs = &ChangeSet{}
	}
	merged := Merge(old, new)

	sources := dedupSorted(cs.Changed)
	for _, s := range sources {
		merged.AddNode(s) // tolerate sources unknown to both graphs
	}

	dist := make(map[string]int, len(sources))
	path := make(map[string][]string, len(sources))
	frontier := make([]string, 0, len(sources))
	for _, s := range sources {
		dist[s] = 0
		path[s] = []string{s}
		frontier = append(frontier, s)
	}

	// Multi-source BFS, one layer at a time. For every node of the next
	// layer the best predecessor (smallest path sequence) is selected
	// only after the whole current layer has been scanned, which yields
	// the lexicographically smallest sequence among all shortest paths.
	for len(frontier) > 0 {
		best := make(map[string][]string)
		for _, u := range frontier {
			for _, v := range merged.Dependents(u) {
				if _, settled := dist[v]; settled {
					continue
				}
				cand := append(append([]string{}, path[u]...), v)
				if cur, ok := best[v]; !ok || lessPath(cand, cur) {
					best[v] = cand
				}
			}
		}
		next := make([]string, 0, len(best))
		for v, p := range best {
			dist[v] = len(p) - 1
			path[v] = p
			next = append(next, v)
		}
		sort.Strings(next)
		frontier = next
	}

	tests := dedupSorted(cs.Tests)
	impacts := make([]Impact, 0, len(tests))
	for _, t := range tests {
		imp := Impact{Test: t}
		if p, ok := path[t]; ok {
			imp.Affected = true
			imp.Path = p
		}
		impacts = append(impacts, imp)
	}
	return impacts
}

// lessPath compares two ID sequences lexicographically.
func lessPath(a, b []string) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func dedupSorted(ids []string) []string {
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return sortedKeys(set)
}
