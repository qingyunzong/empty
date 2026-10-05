package main

import (
	"encoding/json"
	"math/rand"
	"testing"
)

// tinyConfig keeps the state graph small enough for the brute-force
// cross-check to enumerate every feasible route.
func tinyConfig(seed int64) GenConfig {
	return GenConfig{
		Nodes:      4,
		MaxFuel:    8,
		MaxTime:    18,
		Coupons:    2,
		Stations:   2,
		ExtraEdges: 2 + int(seed%3),
	}
}

// TestCrossCheckRandom compares three independent searches on random tiny
// instances: Dijkstra with dominance pruning, Dijkstra without pruning, and
// plain exhaustive enumeration. Pruning must never drop a feasible optimal
// route.
func TestCrossCheckRandom(t *testing.T) {
	for seed := int64(0); seed < 150; seed++ {
		g := RandomGraph(rand.New(rand.NewSource(seed)), tinyConfig(seed))
		if err := g.Validate(); err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		pruned := NewSolver(g, false)
		pruned.Run(0)
		unpruned := NewSolver(g, true)
		unpruned.Run(0)
		exCost, exFound := Exhaustive(g)
		if pruned.Found != unpruned.Found || pruned.Found != exFound {
			t.Fatalf("seed %d: feasibility mismatch pruned=%v unpruned=%v exhaustive=%v",
				seed, pruned.Found, unpruned.Found, exFound)
		}
		if pruned.Found && (pruned.Best != unpruned.Best || pruned.Best != exCost) {
			t.Fatalf("seed %d: cost mismatch pruned=%d unpruned=%d exhaustive=%d",
				seed, pruned.Best, unpruned.Best, exCost)
		}
	}
}

// TestCrossCheckTinyGrids runs the same three-way comparison on small grid
// graphs, exhaustively checking that dominance pruning misses no feasible
// route on grid topologies.
func TestCrossCheckTinyGrids(t *testing.T) {
	grids := [][2]int{{1, 2}, {2, 2}, {2, 3}, {3, 3}}
	for _, dim := range grids {
		for seed := int64(0); seed < 40; seed++ {
			cfg := GenConfig{
				GridRows: dim[0], GridCols: dim[1],
				MaxFuel: 8, MaxTime: 18, Coupons: 2, Stations: 2,
			}
			g := RandomGraph(rand.New(rand.NewSource(1000+seed)), cfg)
			pruned := NewSolver(g, false)
			pruned.Run(0)
			unpruned := NewSolver(g, true)
			unpruned.Run(0)
			exCost, exFound := Exhaustive(g)
			if pruned.Found != unpruned.Found || pruned.Found != exFound {
				t.Fatalf("grid %v seed %d: feasibility mismatch %v/%v/%v",
					dim, seed, pruned.Found, unpruned.Found, exFound)
			}
			if pruned.Found && (pruned.Best != unpruned.Best || pruned.Best != exCost) {
				t.Fatalf("grid %v seed %d: cost mismatch %d/%d/%d",
					dim, seed, pruned.Best, unpruned.Best, exCost)
			}
		}
	}
}

// TestCheckpointResume pauses the search repeatedly, serializes the complete
// frontier to JSON, resumes, and requires the same optimum as a single run.
func TestCheckpointResume(t *testing.T) {
	for seed := int64(0); seed < 20; seed++ {
		cfg := GenConfig{
			Nodes: 8, MaxFuel: MaxFuelCap, MaxTime: MaxTimeCap,
			Coupons: MaxCoupons, Stations: 2, ExtraEdges: 8,
		}
		g := RandomGraph(rand.New(rand.NewSource(5000+seed)), cfg)
		single := NewSolver(g, false)
		single.Run(0)

		s := NewSolver(g, false)
		pauses := 0
		for !s.Done {
			s.Run(7) // pause every 7 expansions
			if s.Done {
				break
			}
			data, err := json.Marshal(s.Save())
			if err != nil {
				t.Fatalf("seed %d: marshal checkpoint: %v", seed, err)
			}
			var cp Checkpoint
			if err := json.Unmarshal(data, &cp); err != nil {
				t.Fatalf("seed %d: unmarshal checkpoint: %v", seed, err)
			}
			s = Resume(g, false, &cp)
			pauses++
			if pauses > 100000 {
				t.Fatalf("seed %d: too many pauses", seed)
			}
		}
		if single.Found != s.Found {
			t.Fatalf("seed %d: resumed feasibility mismatch", seed)
		}
		if single.Found && single.Best != s.Best {
			t.Fatalf("seed %d: resumed cost %d, single run %d", seed, s.Best, single.Best)
		}
		if s.Found {
			cert := BuildCertificate(s)
			if err := VerifyCertificate(g, cert); err != nil {
				t.Fatalf("seed %d: resumed certificate invalid: %v", seed, err)
			}
		}
	}
}

// TestPruningReducesWork sanity-checks that dominance pruning never expands
// more states than the unpruned search.
func TestPruningReducesWork(t *testing.T) {
	for seed := int64(0); seed < 30; seed++ {
		g := RandomGraph(rand.New(rand.NewSource(9000+seed)), tinyConfig(seed))
		pruned := NewSolver(g, false)
		pruned.Run(0)
		unpruned := NewSolver(g, true)
		unpruned.Run(0)
		if pruned.Steps > unpruned.Steps {
			t.Fatalf("seed %d: pruned expanded %d > unpruned %d", seed, pruned.Steps, unpruned.Steps)
		}
	}
}
