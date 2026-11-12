package dataeng_test

import (
	"fmt"
	"math/big"

	"example.org/dataeng/q0319"
	"example.org/dataeng/q0319/cert"
)

// calibrationHost is the kind of caller that owns calibration observations and
// their provenance. It compiles the partial order once and reuses it across
// batches, verifying every returned certificate independently.
type calibrationHost struct {
	graph *dataeng.Graph
	ids   []string
	edges []dataeng.Edge
}

func newCalibrationHost(ids []string, edges []dataeng.Edge) (*calibrationHost, error) {
	// Weights are supplied per batch; the compile-time weights below are only
	// placeholders and are replaced on every Solve call.
	y := make([]*big.Rat, len(ids))
	w := make([]*big.Rat, len(ids))
	for i := range ids {
		y[i] = big.NewRat(0, 1)
		w[i] = big.NewRat(1, 1)
	}
	g, err := dataeng.Compile(ids, y, w, edges)
	if err != nil {
		return nil, err
	}
	return &calibrationHost{graph: g, ids: ids, edges: edges}, nil
}

func (h *calibrationHost) calibrate(y, w []*big.Rat) (*dataeng.Result, error) {
	res, err := h.graph.Solve(y, w)
	if err != nil {
		return nil, err
	}

	// Build a standalone certificate and verify it with the independent checker.
	xm := make(map[string]*big.Rat, h.graph.N())
	lm := make(map[string]*big.Rat, len(h.edges))
	for _, de := range h.graph.DedupEdges() {
		// Duplicate source IDs share one de-duplicated multiplier.
		lam, lerr := res.LambdaBySourceID(de.SourceIDs[0])
		if lerr != nil {
			return nil, lerr
		}
		for _, src := range de.SourceIDs {
			lm[src] = lam
		}
	}
	for _, id := range h.ids {
		xv, xerr := res.X(id)
		if xerr != nil {
			return nil, xerr
		}
		xm[id] = xv
	}
	raw := make([]cert.Edge, 0, len(h.edges))
	for _, e := range h.edges {
		raw = append(raw, cert.Edge{EdgeID: e.EdgeID, From: e.From, To: e.To})
	}
	if err := cert.Verify(cert.Certificate{
		NodeIDs: h.ids,
		Y:       y,
		W:       w,
		Edges:   raw,
		X:       xm,
		Lambda:  lm,
		F:       res.F(),
	}); err != nil {
		return nil, fmt.Errorf("certificate failed independent verification: %w", err)
	}
	return res, nil
}

func Example_calibrationHost() {
	ids := []string{"base", "left", "right", "top"}
	edges := []dataeng.Edge{
		{EdgeID: "bl", From: "base", To: "left"},
		{EdgeID: "br", From: "base", To: "right"},
		{EdgeID: "lt", From: "left", To: "top"},
		{EdgeID: "rt", From: "right", To: "top"},
	}
	host, err := newCalibrationHost(ids, edges)
	if err != nil {
		panic(err)
	}

	batchY := []*big.Rat{
		big.NewRat(0, 1),
		big.NewRat(5, 1),
		big.NewRat(9, 1),
		big.NewRat(10, 1),
	}
	batchW := []*big.Rat{
		big.NewRat(1, 1),
		big.NewRat(1, 1),
		big.NewRat(1, 1),
		big.NewRat(1, 1),
	}
	res, err := host.calibrate(batchY, batchW)
	if err != nil {
		panic(err)
	}

	for _, id := range ids {
		xv, _ := res.X(id)
		fmt.Printf("%s=%s\n", id, xv.RatString())
	}
	fmt.Printf("F=%s flow_calls=%d blocks=%d\n", res.F().RatString(), res.FlowCalls(), res.Blocks())

	// Reuse the same compiled axioms with a second batch.
	res2, err := host.calibrate(
		[]*big.Rat{big.NewRat(2, 1), big.NewRat(-7, 3), big.NewRat(8, 5), big.NewRat(11, 2)},
		[]*big.Rat{big.NewRat(3, 1), big.NewRat(1, 7), big.NewRat(19, 2), big.NewRat(4, 3)},
	)
	if err != nil {
		panic(err)
	}
	fmt.Printf("reused F=%s blocks=%d\n", res2.F().RatString(), res2.Blocks())

	// Output:
	// base=0
	// left=5
	// right=9
	// top=10
	// F=0 flow_calls=3 blocks=4
	// reused F=105853/39825 blocks=2
}
