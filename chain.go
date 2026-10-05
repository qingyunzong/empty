package graphtest

import (
	"encoding/json"
	"fmt"
	"io"
)

// Chain is a recorded sequence of transformations together with the random
// seed that generated it, so any run is fully reproducible.
type Chain struct {
	Seed  int64       `json:"seed"`
	Steps []Transform `json:"steps"`
}

// Apply applies every step of c to g in order, returning the final graph.
// The first illegal step aborts with an error naming its index.
func (c *Chain) Apply(g *Graph) (*Graph, error) {
	cur := g
	for i, t := range c.Steps {
		next, err := t.Apply(cur)
		if err != nil {
			return nil, fmt.Errorf("graphtest: chain step %d: %w", i, err)
		}
		cur = next
	}
	return cur, nil
}

// ForwardMap composes the public result mappings of all steps, mapping
// vertices of the input graph to vertices of the final graph.
func (c *Chain) ForwardMap(g *Graph) (map[int]int, error) {
	cur := g
	comp := make(map[int]int, g.NumVertices())
	for _, v := range g.Vertices() {
		comp[v] = v
	}
	for i, t := range c.Steps {
		m, err := t.ForwardMap(cur)
		if err != nil {
			return nil, fmt.Errorf("graphtest: chain step %d: %w", i, err)
		}
		for v, img := range comp {
			comp[v] = m[img]
		}
		next, err := t.Apply(cur)
		if err != nil {
			return nil, fmt.Errorf("graphtest: chain step %d: %w", i, err)
		}
		cur = next
	}
	return comp, nil
}

// Certificate assigns an integer label to every vertex of a graph; it is
// the public result a solver returns for a transformed instance.
type Certificate map[int]int

// InverseCertificate maps a certificate for the final (transformed) graph
// back through the chain, producing a certificate on the original graph.
// Labels of vertices introduced along the way (isolated additions, split
// midpoints) are dropped; later relabelings are undone.
func (c *Chain) InverseCertificate(g *Graph, cert Certificate) (Certificate, error) {
	// Record the intermediate graphs forward so each step can be undone
	// against the graph it was actually applied to.
	graphs := make([]*Graph, len(c.Steps))
	cur := g
	for i, t := range c.Steps {
		graphs[i] = cur
		next, err := t.Apply(cur)
		if err != nil {
			return nil, fmt.Errorf("graphtest: chain step %d: %w", i, err)
		}
		cur = next
	}
	inv := cert
	for i := len(c.Steps) - 1; i >= 0; i-- {
		t := c.Steps[i]
		m, err := t.InverseMap(graphs[i])
		if err != nil {
			return nil, fmt.Errorf("graphtest: chain step %d: %w", i, err)
		}
		prev := make(Certificate, len(m))
		for newV, oldV := range m {
			label, ok := inv[newV]
			if !ok {
				return nil, fmt.Errorf("graphtest: chain step %d: certificate has no label for vertex %d", i, newV)
			}
			prev[oldV] = label
		}
		inv = prev
	}
	return inv, nil
}

// Save writes the chain record (seed + steps) as JSON.
func (c *Chain) Save(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(c)
}

// LoadChain reads a chain record previously written by Save.
func LoadChain(r io.Reader) (*Chain, error) {
	var c Chain
	if err := json.NewDecoder(r).Decode(&c); err != nil {
		return nil, fmt.Errorf("graphtest: load chain: %w", err)
	}
	return &c, nil
}
