package sched

import (
	"math/rand"
	"testing"
)

// bruteForce is an independent, deliberately simple complete search used
// to cross-check the solver on small random instances. It enumerates every
// placement of every request and explores all subsets with full occupancy
// tracking, returning the best (profit, changes) pair and whether any
// complete assignment exists.
func bruteForce(p *Problem) (bestProfit, bestChanges int, feasible bool) {
	type blk struct {
		res        string
		start, end int
	}
	type opt struct {
		entry  PlanEntry
		blocks []blk
	}
	roomsByType := map[string][]string{}
	for _, r := range p.Rooms {
		roomsByType[r.Type] = append(roomsByType[r.Type], r.ID)
	}
	allOpts := make([][]opt, len(p.Requests))
	for i := range p.Requests {
		req := &p.Requests[i]
		var wins [][2]int
		var rooms [][2]string
		nStages := len(req.Stages)
		if req.Locked != nil {
			w := [2]int{-1, -1}
			r := [2]string{"", ""}
			copy(w[:], req.Locked.Windows)
			copy(r[:], req.Locked.Rooms)
			wins = append(wins, w)
			rooms = append(rooms, r)
		} else if nStages == 1 {
			for w0 := range req.Stages[0].Windows {
				for _, r0 := range roomsByType[req.Stages[0].RoomType] {
					wins = append(wins, [2]int{w0, -1})
					rooms = append(rooms, [2]string{r0, ""})
				}
			}
		} else {
			for w0 := range req.Stages[0].Windows {
				for w1 := range req.Stages[1].Windows {
					for _, r0 := range roomsByType[req.Stages[0].RoomType] {
						for _, r1 := range roomsByType[req.Stages[1].RoomType] {
							wins = append(wins, [2]int{w0, w1})
							rooms = append(rooms, [2]string{r0, r1})
						}
					}
				}
			}
		}
		for k := range wins {
			w := wins[k]
			r := rooms[k]
			o := opt{entry: PlanEntry{
				Windows: append([]int(nil), w[:nStages]...),
				Rooms:   append([]string(nil), r[:nStages]...),
			}}
			okGap := true
			for j, st := range req.Stages {
				wv := st.Windows[w[j]]
				if j > 0 {
					pv := req.Stages[j-1].Windows[w[j-1]]
					gap := wv.Start - pv.End
					if gap < st.MinGap || (st.MaxGap >= 0 && gap > st.MaxGap) {
						okGap = false
					}
				}
				o.blocks = append(o.blocks,
					blk{res: r[j], start: wv.Start - st.Before, end: wv.End + st.After},
					blk{res: st.Equipment, start: wv.Start - st.Before, end: wv.End + st.After},
				)
			}
			for a := 0; a < len(o.blocks) && okGap; a++ {
				for b := a + 1; b < len(o.blocks); b++ {
					x, y := o.blocks[a], o.blocks[b]
					if x.res == y.res && x.start < y.end && y.start < x.end {
						okGap = false
					}
				}
			}
			if okGap {
				allOpts[i] = append(allOpts[i], o)
			}
		}
	}
	occ := map[string][][2]int{}
	bestProfit, bestChanges = -1<<60, 1<<60
	var dfs func(i, profit, changes int)
	dfs = func(i, profit, changes int) {
		if i == len(p.Requests) {
			feasible = true
			if profit > bestProfit || (profit == bestProfit && changes < bestChanges) {
				bestProfit, bestChanges = profit, changes
			}
			return
		}
		req := &p.Requests[i]
		old := p.OldPlan[req.ID]
		for _, o := range allOpts[i] {
			fit := true
			for _, b := range o.blocks {
				for _, iv := range occ[b.res] {
					if b.start < iv[1] && iv[0] < b.end {
						fit = false
					}
				}
			}
			if !fit {
				continue
			}
			for _, b := range o.blocks {
				occ[b.res] = append(occ[b.res], [2]int{b.start, b.end})
			}
			d := 0
			e := o.entry
			if !entryEqual(old, &e) {
				d = 1
			}
			dfs(i+1, profit+req.Profit, changes+d)
			for _, b := range o.blocks {
				occ[b.res] = occ[b.res][:len(occ[b.res])-1]
			}
		}
		if req.Locked == nil {
			d := 0
			if old != nil {
				d = 1
			}
			dfs(i+1, profit, changes+d)
		}
	}
	dfs(0, 0, 0)
	return bestProfit, bestChanges, feasible
}

// randomProblem builds a small random instance with fictional integer data.
func randomProblem(rng *rand.Rand) *Problem {
	p := &Problem{
		Rooms: []Room{
			{ID: "RA1", Type: "A"},
			{ID: "RB1", Type: "B"},
		},
		Equipment: []string{"EQ0", "EQ1"},
		OldPlan:   map[string]*PlanEntry{},
	}
	if rng.Intn(2) == 0 {
		p.Rooms = append(p.Rooms, Room{ID: "RA2", Type: "A"})
	}
	nReq := 1 + rng.Intn(5)
	for i := 0; i < nReq; i++ {
		req := Request{
			ID:     string(rune('a' + i)),
			Profit: 1 + rng.Intn(9),
		}
		nStages := 1 + rng.Intn(2)
		for j := 0; j < nStages; j++ {
			st := Stage{
				RoomType:  []string{"A", "B"}[rng.Intn(2)],
				Equipment: p.Equipment[rng.Intn(len(p.Equipment))],
				Before:    rng.Intn(3),
				After:     rng.Intn(3),
			}
			nWin := 1 + rng.Intn(3)
			for k := 0; k < nWin; k++ {
				start := rng.Intn(16)
				st.Windows = append(st.Windows, Window{Start: start, End: start + 1 + rng.Intn(4)})
			}
			if j > 0 {
				st.MinGap = rng.Intn(4)
				if rng.Intn(3) == 0 {
					st.MaxGap = -1
				} else {
					st.MaxGap = st.MinGap + rng.Intn(5)
				}
			}
			req.Stages = append(req.Stages, st)
		}
		// Random old-plan entry with valid shape (may be infeasible now).
		if rng.Intn(2) == 0 {
			e := &PlanEntry{}
			for _, st := range req.Stages {
				e.Windows = append(e.Windows, rng.Intn(len(st.Windows)))
				rooms := []string{}
				for _, r := range p.Rooms {
					if r.Type == st.RoomType {
						rooms = append(rooms, r.ID)
					}
				}
				e.Rooms = append(e.Rooms, rooms[rng.Intn(len(rooms))])
			}
			p.OldPlan[req.ID] = e
			// Sometimes confirm the booking at its old placement.
			if rng.Intn(3) == 0 {
				cp := *e
				req.Locked = &cp
			}
		}
		p.Requests = append(p.Requests, req)
	}
	return p
}

// Complete small-state search cross-check: the solver must agree with the
// brute-force optimum on both profit and the minimal number of changes,
// and every produced solution must pass independent verification.
func TestExhaustiveAgainstBruteForce(t *testing.T) {
	const iterations = 500
	rng := rand.New(rand.NewSource(20261006))
	infeasible := 0
	for iter := 0; iter < iterations; iter++ {
		p := randomProblem(rng)
		wantProfit, wantChanges, wantFeasible := bruteForce(p)
		sol, err := Solve(p)
		if !wantFeasible {
			infeasible++
			if err != ErrInfeasible {
				t.Fatalf("iter %d: want ErrInfeasible, got sol=%+v err=%v", iter, sol, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("iter %d: unexpected error: %v", iter, err)
		}
		if sol.Profit != wantProfit {
			t.Fatalf("iter %d: profit %d, brute force says %d", iter, sol.Profit, wantProfit)
		}
		if sol.Changes != wantChanges {
			t.Fatalf("iter %d: changes %d, brute force says %d", iter, sol.Changes, wantChanges)
		}
		if err := Verify(p, sol); err != nil {
			t.Fatalf("iter %d: Verify: %v", iter, err)
		}
	}
	t.Logf("checked %d random instances (%d infeasible)", iterations, infeasible)
}
