package main

import "math/rand"

// GenConfig controls random instance generation.
type GenConfig struct {
	Nodes      int
	MaxFuel    int
	MaxTime    int
	Coupons    int // coupon indices actually used on edges, 0..6
	Stations   int
	ExtraEdges int // edges beyond the spanning chain
	GridRows   int // if > 0 with GridCols, build a rows x cols grid instead
	GridCols   int
}

func (cfg GenConfig) nodeCount() int {
	if cfg.GridRows > 0 && cfg.GridCols > 0 {
		return cfg.GridRows * cfg.GridCols
	}
	return cfg.Nodes
}

// RandomGraph builds a random instance. A spanning chain guarantees the goal
// is reachable in the underlying directed graph (windows may still close it).
func RandomGraph(r *rand.Rand, cfg GenConfig) *Graph {
	n := cfg.nodeCount()
	g := &Graph{
		NumNodes: n,
		Start:    0,
		Goal:     n - 1,
		MaxFuel:  cfg.MaxFuel,
		MaxTime:  cfg.MaxTime,
	}
	addEdge := func(from, to int) {
		g.Edges = append(g.Edges, randomEdge(r, cfg, from, to))
	}
	if cfg.GridRows > 0 && cfg.GridCols > 0 {
		at := func(row, col int) int { return row*cfg.GridCols + col }
		for row := 0; row < cfg.GridRows; row++ {
			for col := 0; col < cfg.GridCols; col++ {
				if col+1 < cfg.GridCols {
					addEdge(at(row, col), at(row, col+1))
					addEdge(at(row, col+1), at(row, col))
				}
				if row+1 < cfg.GridRows {
					addEdge(at(row, col), at(row+1, col))
					addEdge(at(row+1, col), at(row, col))
				}
			}
		}
	} else {
		for i := 1; i < n; i++ {
			addEdge(r.Intn(i), i) // spanning chain keeps the graph connected
		}
		for i := 0; i < cfg.ExtraEdges; i++ {
			addEdge(r.Intn(n), r.Intn(n))
		}
	}
	// Stations on distinct non-start nodes.
	perm := r.Perm(n)
	placed := 0
	for _, v := range perm {
		if placed >= cfg.Stations {
			break
		}
		if v == g.Start {
			continue
		}
		g.Stations = append(g.Stations, Station{
			Node:       v,
			Price:      1 + r.Intn(3),
			RefuelTime: 1 + r.Intn(2),
			Capacity:   1 + r.Intn(MaxSlotCap),
		})
		placed++
	}
	return g
}

func randomEdge(r *rand.Rand, cfg GenConfig, from, to int) Edge {
	e := Edge{
		From:   from,
		To:     to,
		Fuel:   1 + r.Intn(max(1, cfg.MaxFuel/3)),
		Time:   1 + r.Intn(max(1, cfg.MaxTime/4)),
		Toll:   r.Intn(13),
		Coupon: -1,
	}
	// Half the edges are always open; the rest get 1-2 random windows.
	if r.Intn(2) == 0 {
		for k := 0; k < 1+r.Intn(2); k++ {
			a := r.Intn(cfg.MaxTime)
			b := a + r.Intn(cfg.MaxTime-a+1)
			e.Windows = append(e.Windows, Window{Start: a, End: b})
		}
	}
	if cfg.Coupons > 0 && r.Intn(10) < 4 {
		e.Coupon = r.Intn(cfg.Coupons)
		e.Discount = r.Intn(9)
	}
	return e
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
