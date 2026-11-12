package dataeng

import (
	"math/big"
	"testing"
)

// TestLarge64LayeredDAG exercises the production flow algorithm at the maximum
// supported size. It never invokes the exponential reference: correctness is
// established through the independent certificate checker, direct edge
// feasibility checks, the exact objective and the recorded termination counts.
func TestLarge64LayeredDAG(t *testing.T) {
	const n = MaxNodes
	ids := make([]string, n)
	y := make([]*big.Rat, n)
	w := make([]*big.Rat, n)

	// Deterministic pseudo-random rational observations and distinct weights,
	// generated with integer arithmetic only (no floats anywhere).
	seed := int64(20261112)
	next := func() int64 {
		seed = (seed*1103515245 + 12345) & 0x7fffffff
		return seed
	}

	var edges []Edge
	edgeSeq := 0
	addEdge := func(u, v int) {
		edgeSeq++
		edges = append(edges, Edge{
			EdgeID: "edge-" + itoa(edgeSeq),
			From:   ids[u],
			To:     ids[v],
		})
	}

	layer := make([]int, n)
	for i := 0; i < n; i++ {
		ids[i] = "node-" + itoa(i)
		layer[i] = i % 8
		// Values between roughly -20 and +20 as exact fractions /7.
		y[i] = big.NewRat(next()%401-200, 7)
		// Strictly positive distinct weights 1 + i/64.
		w[i] = big.NewRat(64+int64(i), 64)
	}

	// Edges only from lower layers to higher layers => guaranteed acyclic.
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if layer[j] == layer[i]+1 && (next()%3 == 0) {
				addEdge(i, j)
			}
		}
	}
	// A few sparse forward skips remain acyclic because layers strictly rise.
	for i := 0; i < n; i++ {
		j := (i + 1 + int(next()%17)) % n
		if layer[j] > layer[i] {
			addEdge(i, j)
		}
	}

	g := mustCompile(t, ids, y, w, edges)
	if g.N() != n {
		t.Fatalf("expected %d nodes, got %d", n, g.N())
	}
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve large DAG: %v", err)
	}

	if res.Blocks() < 1 || res.Blocks() > n {
		t.Fatalf("block count out of range: %d", res.Blocks())
	}
	if res.Splits() != res.Blocks()-1 {
		t.Fatalf("splits %d should equal blocks-1 %d", res.Splits(), res.Blocks()-1)
	}
	if res.FlowCalls() < res.Splits() {
		t.Fatalf("flow calls %d fewer than refinement splits %d", res.FlowCalls(), res.Splits())
	}

	// Exact primal feasibility on every edge.
	for _, e := range g.edges {
		if res.x[e.from].Cmp(res.x[e.to]) > 0 {
			t.Fatalf("edge %s->%s violated: %s > %s",
				g.ids[e.from], g.ids[e.to], res.x[e.from].RatString(), res.x[e.to].RatString())
		}
	}
	// Non-negative multipliers and exact complementarity.
	for k, e := range g.edges {
		if res.lambda[k].Sign() < 0 {
			t.Fatalf("negative multiplier on edge %d", k)
		}
		gap := new(big.Rat).Sub(res.x[e.from], res.x[e.to])
		if new(big.Rat).Mul(res.lambda[k], gap).Sign() != 0 {
			t.Fatalf("complementarity violated on edge %d", k)
		}
	}
	// The independent checker must accept the full certificate.
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))

	t.Logf("64-node DAG: edges=%d unique=%d blocks=%d splits=%d flow_calls=%d F=%s",
		len(edges), g.DedupEdgeCount(), res.Blocks(), res.Splits(), res.FlowCalls(), res.F().RatString())
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
