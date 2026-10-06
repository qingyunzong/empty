package pieceaffine

import "fmt"

// Chain is a composition of maps applied in order: Layers[0] first.
// It carries a version that is bumped by every applied batch edit.
type Chain struct {
	Layers  []Map          `json:"layers"`
	Version uint64         `json:"version"`
	History []VersionEntry `json:"history"`
}

// VersionEntry records one applied batch in the chain history.
type VersionEntry struct {
	Version uint64 `json:"version"`
	Edits   int    `json:"edits"`
	Layers  int    `json:"layers"`
}

// NewChain validates the layers and returns a chain at version 0.
func NewChain(layers []Map) (*Chain, error) {
	for i, l := range layers {
		if err := l.Validate(); err != nil {
			return nil, fmt.Errorf("pieceaffine: layer %d: %w", i, err)
		}
	}
	return &Chain{Layers: append([]Map(nil), layers...)}, nil
}

// Edit replaces the layer at Index, or appends when Index == len(Layers).
type Edit struct {
	Index int `json:"index"`
	Layer Map `json:"layer"`
}

// ApplyBatch applies a batch of edits atomically: every edit is validated
// first, and either all are applied (bumping the version by one) or none
// are. It returns the resulting version.
func (c *Chain) ApplyBatch(edits []Edit) (uint64, error) {
	layers := make([]Map, len(c.Layers))
	copy(layers, c.Layers)
	for i, e := range edits {
		if e.Index < 0 || e.Index > len(layers) {
			return c.Version, fmt.Errorf("pieceaffine: edit %d: index %d out of range [0, %d]", i, e.Index, len(layers))
		}
		if err := e.Layer.Validate(); err != nil {
			return c.Version, fmt.Errorf("pieceaffine: edit %d: %w", i, err)
		}
		if e.Index == len(layers) {
			layers = append(layers, e.Layer)
		} else {
			layers[e.Index] = e.Layer
		}
	}
	c.Layers = layers
	c.Version++
	c.History = append(c.History, VersionEntry{Version: c.Version, Edits: len(edits), Layers: len(layers)})
	return c.Version, nil
}

// Eval composes all layers. The second return value is false when the
// value falls outside some intermediate layer's domain.
func (c *Chain) Eval(x int64) (int64, bool) {
	v := x
	for _, l := range c.Layers {
		var ok bool
		v, ok = l.Eval(v)
		if !ok {
			return 0, false
		}
	}
	return v, true
}

// ProofStep records one layer of a layered preimage computation: Output is
// the target interval set handed to the layer, Input is the preimage set
// the layer produced.
type ProofStep struct {
	Layer  int        `json:"layer"`
	Output []Interval `json:"output"`
	Input  []Interval `json:"input"`
}

// Proof is a layer-by-layer certificate of a chain preimage. Steps are
// recorded from the last layer back to the first, so every intermediate
// rounding is traversed explicitly rather than merged into a single
// composed coefficient.
type Proof struct {
	Version uint64      `json:"version"`
	Steps   []ProofStep `json:"steps"`
	Result  []Interval  `json:"result"`
}

// Preimage computes the canonical preimage of the output interval y
// through every layer of the chain, emitting a per-layer proof.
func (c *Chain) Preimage(y Interval) Proof {
	proof := Proof{Version: c.Version}
	cur := Canonical([]Interval{y})
	for i := len(c.Layers) - 1; i >= 0; i-- {
		next := c.Layers[i].PreimageSet(cur)
		proof.Steps = append(proof.Steps, ProofStep{Layer: i, Output: cur, Input: next})
		cur = next
	}
	proof.Result = cur
	return proof
}
