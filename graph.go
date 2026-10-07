// Package impact computes, for every test, the shortest file-level
// dependency path through which a change set affects that test.
//
// The analysis runs on the merge of the old and the new dependency
// graphs: nodes deleted in the new graph keep their old-graph edges so
// their influence is still accounted for.
package impact

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
)

// Graph is a file-level dependency graph. Edges maps a file to the
// files it directly depends on.
type Graph struct {
	Edges map[string][]string
}

// NewGraph builds a Graph from an adjacency map, normalizing it by
// deduplicating and sorting the adjacency lists.
func NewGraph(edges map[string][]string) *Graph {
	g := &Graph{Edges: make(map[string][]string, len(edges))}
	for from, deps := range edges {
		g.Edges[from] = dedupSorted(deps)
	}
	return g
}

// Merge returns a graph containing the union of the edges of all given
// graphs. Deleted nodes from the old graph therefore keep contributing
// their old edges when merged with the new graph.
func Merge(graphs ...*Graph) *Graph {
	merged := &Graph{Edges: map[string][]string{}}
	for _, g := range graphs {
		if g == nil {
			continue
		}
		for from, deps := range g.Edges {
			merged.Edges[from] = append(merged.Edges[from], deps...)
		}
	}
	for from, deps := range merged.Edges {
		merged.Edges[from] = dedupSorted(deps)
	}
	return merged
}

// Nodes returns the sorted set of all node IDs (sources and targets of
// edges) present in the graph.
func (g *Graph) Nodes() []string {
	set := map[string]bool{}
	for from, deps := range g.Edges {
		set[from] = true
		for _, dep := range deps {
			set[dep] = true
		}
	}
	nodes := make([]string, 0, len(set))
	for n := range set {
		nodes = append(nodes, n)
	}
	sort.Strings(nodes)
	return nodes
}

// ChangeSet describes the files that changed between the old and the
// new graph. Deleted files are listed separately; they still act as
// change targets even though they may be absent from the new graph.
type ChangeSet struct {
	Changed []string `json:"changed"`
	Deleted []string `json:"deleted"`
}

// Targets returns the deduplicated, sorted set of files whose change
// can affect tests: every changed and every deleted file.
func (c *ChangeSet) Targets() map[string]bool {
	targets := map[string]bool{}
	for _, f := range c.Changed {
		targets[f] = true
	}
	for _, f := range c.Deleted {
		targets[f] = true
	}
	return targets
}

type graphJSON struct {
	Edges map[string][]string `json:"edges"`
}

// LoadGraph reads a JSON dependency graph of the form
// {"edges": {"file": ["dep1", "dep2"]}} from r.
func LoadGraph(r io.Reader) (*Graph, error) {
	var gj graphJSON
	if err := json.NewDecoder(r).Decode(&gj); err != nil {
		return nil, fmt.Errorf("impact: decoding graph: %w", err)
	}
	return NewGraph(gj.Edges), nil
}

// LoadGraphFile loads a JSON dependency graph from the named file.
func LoadGraphFile(path string) (*Graph, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return LoadGraph(f)
}

// LoadChangeSet reads a JSON change set of the form
// {"changed": [...], "deleted": [...]} from r.
func LoadChangeSet(r io.Reader) (*ChangeSet, error) {
	var cs ChangeSet
	if err := json.NewDecoder(r).Decode(&cs); err != nil {
		return nil, fmt.Errorf("impact: decoding change set: %w", err)
	}
	return &cs, nil
}

// LoadChangeSetFile loads a JSON change set from the named file.
func LoadChangeSetFile(path string) (*ChangeSet, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return LoadChangeSet(f)
}

// LoadTests reads a JSON array of test file IDs from r.
func LoadTests(r io.Reader) ([]string, error) {
	var tests []string
	if err := json.NewDecoder(r).Decode(&tests); err != nil {
		return nil, fmt.Errorf("impact: decoding tests: %w", err)
	}
	return tests, nil
}

// LoadTestsFile loads a JSON test list from the named file.
func LoadTestsFile(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return LoadTests(f)
}

func dedupSorted(ids []string) []string {
	set := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !set[id] {
			set[id] = true
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}
