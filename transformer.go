package q159

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// Transformer is an embeddable, concurrency-safe component that routes
// records through a directed acyclic transformation graph.
//
// The graph and target schema are both versioned: every accepted graph
// update produces a new immutable snapshot with its own path cache, and
// SetTarget switches the target at a barrier. A batch captured before a
// barrier keeps using the snapshot and target it was admitted with, so an
// in-flight batch can never observe a newer graph or target.
type Transformer struct {
	mu      sync.RWMutex
	snap    *snapshot
	target  SchemaID
	version uint64
}

// New creates a Transformer over the given edges. The initial target schema
// is target and the graph version starts at 1.
func New(edges []Edge, target SchemaID) (*Transformer, error) {
	if target == "" {
		return nil, errors.New("q159: target schema ID must not be empty")
	}
	snap, err := buildSnapshot(edges, 1)
	if err != nil {
		return nil, err
	}
	return &Transformer{snap: snap, target: target, version: 1}, nil
}

// ReplaceEdges atomically validates and installs a new graph. The new
// version gets an empty path cache. On validation failure (including a
// cycle) the transformer is left untouched and the version is not advanced.
func (t *Transformer) ReplaceEdges(edges []Edge) (uint64, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	snap, err := buildSnapshot(edges, t.version+1)
	if err != nil {
		return t.version, err
	}
	t.version++
	t.snap = snap
	return t.version, nil
}

// SetTarget moves the barrier: batches admitted afterwards route to the new
// target, while already admitted batches finish against the old target.
func (t *Transformer) SetTarget(target SchemaID) error {
	if target == "" {
		return errors.New("q159: target schema ID must not be empty")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.target = target
	return nil
}

// Target returns the schema that newly admitted batches route towards.
func (t *Transformer) Target() SchemaID {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.target
}

// Version returns the current graph version. It is incremented once per
// accepted graph update.
func (t *Transformer) Version() uint64 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.version
}

// admission captures everything a batch needs to run independently of later
// graph or target changes.
type admission struct {
	snap   *snapshot
	target SchemaID
}

func (t *Transformer) admit() admission {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return admission{snap: t.snap, target: t.target}
}

// ApplyBatch routes and transforms a batch atomically. Every record is first
// planned against the current target; if any record has no path the whole
// batch is rejected before any transformation runs. The records are then
// transformed along their cheapest paths and the whole batch is rejected if
// any transformation fails. On success the output records, in input order,
// all carry the target schema.
func (t *Transformer) ApplyBatch(ctx context.Context, records []Record) ([]Record, error) {
	if len(records) == 0 {
		return []Record{}, nil
	}
	a := t.admit()

	plans := make([][]Edge, len(records))
	for i, rec := range records {
		path, err := a.snap.route(rec.Schema, a.target)
		if err != nil {
			return nil, fmt.Errorf("record %d (schema %q): %w", i, rec.Schema, err)
		}
		plans[i] = path
	}

	out := make([]Record, len(records))
	for i, rec := range records {
		payload := rec.Payload
		for _, edge := range plans[i] {
			if err := ctx.Err(); err != nil {
				return nil, fmt.Errorf("record %d: %w", i, err)
			}
			next, err := edge.Apply(ctx, payload)
			if err != nil {
				return nil, fmt.Errorf("record %d, edge %q: %w", i, edge.ID, err)
			}
			payload = next
		}
		out[i] = Record{Schema: a.target, Payload: payload}
	}
	return out, nil
}
