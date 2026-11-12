package dataeng

import "math/big"

// Result is the exact solution of one projection call. All exposed values are
// independent copies: later solves with different y and w cannot change a
// previously returned result, and callers cannot mutate the compiled graph.
type Result struct {
	x      []*big.Rat
	f      *big.Rat
	lambda []*big.Rat // one entry per unique (de-duplicated) edge
	flow   int        // total maximum-flow invocations
	splits int        // number of block refinements
	blocks int        // final number of constant blocks
	graph  *Graph
}

// X returns the unique optimal value for node id, or an error for an unknown ID.
func (r *Result) X(id string) (*big.Rat, error) {
	i, ok := r.graph.nodeIndex(id)
	if !ok {
		return nil, errUnknownNode(id)
	}
	return ratCopy(r.x[i]), nil
}

// XByIndex returns the optimal value of node i.
func (r *Result) XByIndex(i int) *big.Rat {
	return ratCopy(r.x[i])
}

// F returns the exact minimum objective sum_i w_i (x_i-y_i)^2.
func (r *Result) F() *big.Rat { return ratCopy(r.f) }

// LambdaByDedupEdge returns the non-negative KKT multiplier attached to the
// unique edge with the given index (matching [Graph.DedupEdges] ordering).
func (r *Result) LambdaByDedupEdge(edgeIndex int) (*big.Rat, error) {
	if edgeIndex < 0 || edgeIndex >= len(r.lambda) {
		return nil, errBadEdgeIndex(edgeIndex)
	}
	return ratCopy(r.lambda[edgeIndex]), nil
}

// LambdaBySourceID returns the multiplier of the unique edge carrying the
// given original edge ID (duplicates share one de-duplicated multiplier).
func (r *Result) LambdaBySourceID(edgeID string) (*big.Rat, error) {
	for k, e := range r.graph.edges {
		for _, src := range e.sourceIDs {
			if src == edgeID {
				return ratCopy(r.lambda[k]), nil
			}
		}
	}
	return nil, errUnknownEdge(edgeID)
}

// FlowCalls reports the number of exact maximum-flow invocations used. It is a
// real termination record: block refinement drives the count, there is no
// fixed iteration budget.
func (r *Result) FlowCalls() int { return r.flow }

// Splits reports how many times a constant block was refined because a
// negative-weight lower-closed subset proved the pooled mean suboptimal.
func (r *Result) Splits() int { return r.splits }

// Blocks reports the final number of constant blocks in the projection.
func (r *Result) Blocks() int { return r.blocks }
