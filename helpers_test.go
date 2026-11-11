package q159

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

var errBoom = errors.New("q159-test: transform boom")

// incEdge transforms int payloads by adding one.
func incEdge(id EdgeID, from, to SchemaID, cost uint64) Edge {
	return Edge{
		ID:   id,
		From: from,
		To:   to,
		Cost: cost,
		Apply: func(_ context.Context, in any) (any, error) {
			n, _ := in.(int)
			return n + 1, nil
		},
	}
}

// tagEdge prefixes the payload with the edge ID, making the executed path
// observable in the output.
func tagEdge(id EdgeID, from, to SchemaID, cost uint64) Edge {
	return Edge{
		ID:   id,
		From: from,
		To:   to,
		Cost: cost,
		Apply: func(_ context.Context, in any) (any, error) {
			return fmt.Sprintf("%s>%v", id, in), nil
		},
	}
}

func failEdge(id EdgeID, from, to SchemaID, cost uint64) Edge {
	return Edge{
		ID:    id,
		From:  from,
		To:    to,
		Cost:  cost,
		Apply: func(_ context.Context, _ any) (any, error) { return nil, errBoom },
	}
}

// gate makes a transformation deterministic under concurrency: every gated
// edge signals enter and then blocks until release is closed, giving the
// test full control over when the transformation proceeds.
type gate struct {
	enter   chan struct{}
	release chan struct{}
	once    sync.Once
}

func newGate() *gate {
	return &gate{
		enter:   make(chan struct{}, 1024),
		release: make(chan struct{}),
	}
}

func (g *gate) waitEntered() { <-g.enter }

func (g *gate) releaseAll() {
	g.once.Do(func() { close(g.release) })
}

func (g *gate) wrap(inner TransformFn) TransformFn {
	return func(ctx context.Context, in any) (any, error) {
		select {
		case g.enter <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		select {
		case <-g.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return inner(ctx, in)
	}
}

func gated(edge Edge, g *gate) Edge {
	edge.Apply = g.wrap(edge.Apply)
	return edge
}

func currentSnapshot(t *Transformer) *snapshot {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.snap
}

func cacheSourceCount(s *snapshot) int {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	return len(s.cache)
}

func cachePath(s *snapshot, src, dst SchemaID) ([]Edge, bool) {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	dstCache, ok := s.cache[src]
	if !ok {
		return nil, false
	}
	path, ok := dstCache[dst]
	return path, ok
}
