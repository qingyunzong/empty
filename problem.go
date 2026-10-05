// Package joinopt finds the minimum-cost binary join order over a set of
// declared join edges, using exact rational arithmetic.
//
// Cost model (documented in README.md):
//   - Every table has a positive integer cardinality.
//   - Every declared edge {i,j} carries an explicit integer cardinality of
//     the two-table join result i ⋈ j. Its selectivity is the rational
//     sel(i,j) = edgeCard / (card_i * card_j).
//   - The estimated cardinality of joining disjoint subplans A and B is
//     est(A) * est(B) * prod(sel over edges crossing the A|B cut).
//     Consequently est(S) for a subset S is plan-independent:
//     est(S) = prod(card_i) * prod(sel over edges inside S).
//   - The cost of a plan is the sum of est() over all internal (join)
//     nodes, i.e. total intermediate result size.
//   - Only binary trees in which every join has at least one declared edge
//     crossing the cut are allowed (no Cartesian products).
package joinopt

import (
	"encoding/json"
	"fmt"
	"io"
	"math/big"
)

// MaxTables is the largest supported number of tables.
const MaxTables = 12

// Edge is a declared join edge. Card is the explicit integer cardinality
// of the two-table join result A ⋈ B.
type Edge struct {
	A, B int
	Card int64
}

// Problem is a validated join-ordering instance.
type Problem struct {
	Names []string
	Card  []int64
	Edges []Edge

	adj []int               // adjacency bitmasks
	sel map[uint32]*big.Rat // exact selectivity per edge
}

func edgeKey(i, j int) uint32 {
	if i > j {
		i, j = j, i
	}
	return uint32(i)<<16 | uint32(j)
}

// NewProblem validates its arguments and builds a Problem.
func NewProblem(names []string, cards []int64, edges []Edge) (*Problem, error) {
	n := len(names)
	if n == 0 {
		return nil, fmt.Errorf("no tables")
	}
	if n > MaxTables {
		return nil, fmt.Errorf("too many tables: %d > %d", n, MaxTables)
	}
	if len(cards) != n {
		return nil, fmt.Errorf("got %d cardinalities for %d tables", len(cards), n)
	}
	seen := make(map[string]bool, n)
	for i := range names {
		if names[i] == "" {
			return nil, fmt.Errorf("table %d: empty name", i)
		}
		if seen[names[i]] {
			return nil, fmt.Errorf("duplicate table name %q", names[i])
		}
		seen[names[i]] = true
		if cards[i] < 1 {
			return nil, fmt.Errorf("table %q: cardinality must be >= 1, got %d", names[i], cards[i])
		}
	}
	adj := make([]int, n)
	sel := make(map[uint32]*big.Rat, len(edges))
	for _, e := range edges {
		if e.A < 0 || e.A >= n || e.B < 0 || e.B >= n {
			return nil, fmt.Errorf("edge (%d,%d): table index out of range [0,%d)", e.A, e.B, n)
		}
		if e.A == e.B {
			return nil, fmt.Errorf("self edge on table %q", names[e.A])
		}
		key := edgeKey(e.A, e.B)
		if _, dup := sel[key]; dup {
			return nil, fmt.Errorf("duplicate edge (%s,%s)", names[e.A], names[e.B])
		}
		max := cards[e.A] * cards[e.B]
		if e.Card < 1 || e.Card > max {
			return nil, fmt.Errorf("edge (%s,%s): join cardinality %d outside [1, %d]",
				names[e.A], names[e.B], e.Card, max)
		}
		sel[key] = big.NewRat(e.Card, max)
		adj[e.A] |= 1 << e.B
		adj[e.B] |= 1 << e.A
	}
	return &Problem{Names: names, Card: cards, Edges: edges, adj: adj, sel: sel}, nil
}

type tableJSON struct {
	Name string `json:"name"`
	Card int64  `json:"card"`
}

type edgeJSON struct {
	A    any   `json:"a"`
	B    any   `json:"b"`
	Card int64 `json:"card"`
}

type inputJSON struct {
	Tables []tableJSON `json:"tables"`
	Edges  []edgeJSON  `json:"edges"`
}

// Parse reads a Problem from a JSON document. Edge endpoints may be table
// indices (0-based) or table names.
func Parse(r io.Reader) (*Problem, error) {
	var in inputJSON
	if err := json.NewDecoder(r).Decode(&in); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if len(in.Tables) == 0 {
		return nil, fmt.Errorf("input has no tables")
	}
	names := make([]string, len(in.Tables))
	cards := make([]int64, len(in.Tables))
	index := make(map[string]int, len(in.Tables))
	for i, t := range in.Tables {
		names[i] = t.Name
		if names[i] == "" {
			names[i] = fmt.Sprintf("T%d", i)
		}
		if _, dup := index[names[i]]; !dup {
			index[names[i]] = i
		}
		cards[i] = t.Card
	}
	resolve := func(v any) (int, error) {
		switch x := v.(type) {
		case float64:
			if x != float64(int(x)) {
				return 0, fmt.Errorf("table reference %v is not an integer", x)
			}
			return int(x), nil
		case string:
			i, ok := index[x]
			if !ok {
				return 0, fmt.Errorf("unknown table %q", x)
			}
			return i, nil
		default:
			return 0, fmt.Errorf("invalid table reference %v", v)
		}
	}
	edges := make([]Edge, 0, len(in.Edges))
	for _, e := range in.Edges {
		a, err := resolve(e.A)
		if err != nil {
			return nil, err
		}
		b, err := resolve(e.B)
		if err != nil {
			return nil, err
		}
		edges = append(edges, Edge{A: a, B: b, Card: e.Card})
	}
	return NewProblem(names, cards, edges)
}
