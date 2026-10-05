package main

import (
	"container/heap"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"time"
)

// Item is a priority-queue entry: state plus g (cost so far) and
// f = g + h (estimated total).
type Item struct {
	S State `json:"state"`
	G int   `json:"g"`
	F int   `json:"f"`
}

type priorityQueue []Item

func (p priorityQueue) Len() int { return len(p) }
func (p priorityQueue) Less(i, j int) bool {
	if p[i].F != p[j].F {
		return p[i].F < p[j].F
	}
	if p[i].G != p[j].G {
		return p[i].G > p[j].G
	}
	return stateLess(p[i].S, p[j].S)
}
func (p priorityQueue) Swap(i, j int) { p[i], p[j] = p[j], p[i] }
func (p *priorityQueue) Push(x any)   { *p = append(*p, x.(Item)) }
func (p *priorityQueue) Pop() any {
	old := *p
	n := len(old)
	it := old[n-1]
	*p = old[:n-1]
	return it
}

type parentInfo struct {
	Prev State
	Act  Action
}

// Solver is an A* search over the finite state graph. Its frontier and
// bookkeeping can be snapshotted at any pause and resumed later.
type Solver struct {
	sc     *Scenario
	h      []int // admissible lower bound per node
	dist   map[State]int
	parent map[State]parentInfo
	pq     priorityQueue

	Pops  int
	Done  bool
	Found bool
	Best  int
	Goal  State
}

type arc struct{ to, w int }

// Heuristic returns, per node, a lower bound on the remaining toll to
// the goal: shortest paths on a relaxed graph that ignores fuel, time
// windows, charging capacity and coupon availability (every coupon is
// assumed usable). Admissible and consistent.
func (sc *Scenario) Heuristic() []int {
	const inf = math.MaxInt32 / 2
	rev := make([][]arc, sc.Nodes)
	for _, e := range sc.Edges {
		w := e.Toll
		if e.Discount >= 0 {
			if d := e.Toll - sc.Discounts[e.Discount]; d < w {
				w = d
			}
			if w < 0 {
				w = 0
			}
		}
		rev[e.To] = append(rev[e.To], arc{to: e.From, w: w})
	}
	h := make([]int, sc.Nodes)
	for i := range h {
		h[i] = inf
	}
	h[sc.Goal] = 0
	// Bellman-Ford on the reverse graph; <= 10 nodes so this is trivial.
	for iter := 0; iter < sc.Nodes; iter++ {
		changed := false
		for to := range rev {
			if h[to] == inf {
				continue
			}
			for _, a := range rev[to] {
				if h[to]+a.w < h[a.to] {
					h[a.to] = h[to] + a.w
					changed = true
				}
			}
		}
		if !changed {
			break
		}
	}
	return h
}

// NewSolver creates a fresh search from the start state.
func NewSolver(sc *Scenario) *Solver {
	sv := &Solver{
		sc:     sc,
		h:      sc.Heuristic(),
		dist:   make(map[State]int),
		parent: make(map[State]parentInfo),
	}
	start := State{Node: sc.Start, Fuel: sc.StartFuel}
	sv.dist[start] = 0
	sv.pq = append(sv.pq, Item{S: start, G: 0, F: sv.h[sc.Start]})
	return sv
}

// Run expands states until the search finishes, maxPops more expansions
// have happened in this call (if > 0), or the deadline passes. It
// reports whether the search paused, in which case Snapshot and
// SaveSnapshot capture the full frontier for later resumption.
func (sv *Solver) Run(maxPops int, deadline time.Time) (paused bool) {
	iter := 0
	pops := 0
	for len(sv.pq) > 0 {
		if maxPops > 0 && pops >= maxPops {
			return true
		}
		if iter++; iter%512 == 0 && !deadline.IsZero() && time.Now().After(deadline) {
			return true
		}
		it := heap.Pop(&sv.pq).(Item)
		if it.G > sv.dist[it.S] {
			continue // stale queue entry
		}
		sv.Pops++
		pops++
		if it.S.Node == sv.sc.Goal {
			sv.Done = true
			sv.Found = true
			sv.Best = it.G
			sv.Goal = it.S
			return false
		}
		for _, a := range sv.sc.NextStates(it.S) {
			ng := it.G + a.Cost
			if og, ok := sv.dist[a.Next]; ok && og <= ng {
				continue
			}
			sv.dist[a.Next] = ng
			sv.parent[a.Next] = parentInfo{Prev: it.S, Act: a}
			heap.Push(&sv.pq, Item{S: a.Next, G: ng, F: ng + sv.h[a.Next.Node]})
		}
	}
	sv.Done = true
	return false
}

// FrontierLowerBound is the minimum f-value in the current frontier,
// a valid lower bound on the optimal cost while the search is paused
// (and equal to the optimum once it finishes).
func (sv *Solver) FrontierLowerBound() int {
	if sv.Found {
		return sv.Best
	}
	if len(sv.pq) == 0 {
		return math.MaxInt32 / 2
	}
	m := sv.pq[0].F
	for _, it := range sv.pq[1:] {
		if it.F < m {
			m = it.F
		}
	}
	return m
}

// Certificate reconstructs the optimal transition sequence.
func (sv *Solver) Certificate() []Action {
	if !sv.Found {
		return nil
	}
	start := State{Node: sv.sc.Start, Fuel: sv.sc.StartFuel}
	var rev []Action
	for s := sv.Goal; s != start; {
		p, ok := sv.parent[s]
		if !ok {
			return nil
		}
		rev = append(rev, p.Act)
		s = p.Prev
	}
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	return rev
}

// Snapshot is the serializable complete search frontier plus
// bookkeeping, sufficient to resume the search exactly.
type Snapshot struct {
	Dist   map[string]int            `json:"dist"`
	Parent map[string]snapshotParent `json:"parent"`
	Heap   []Item                    `json:"heap"`
	Pops   int                       `json:"pops"`
}

type snapshotParent struct {
	Prev string `json:"prev"`
	Act  Action `json:"action"`
}

// Snapshot captures the full frontier and best-cost map.
func (sv *Solver) Snapshot() *Snapshot {
	snap := &Snapshot{
		Dist:   make(map[string]int, len(sv.dist)),
		Parent: make(map[string]snapshotParent, len(sv.parent)),
		Heap:   append([]Item(nil), sv.pq...),
		Pops:   sv.Pops,
	}
	for s, g := range sv.dist {
		snap.Dist[s.Key()] = g
	}
	for s, p := range sv.parent {
		snap.Parent[s.Key()] = snapshotParent{Prev: p.Prev.Key(), Act: p.Act}
	}
	return snap
}

// SaveSnapshot writes the frontier snapshot as JSON.
func (sv *Solver) SaveSnapshot(path string) error {
	data, err := json.MarshalIndent(sv.Snapshot(), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// ResumeSolver restores a solver from a saved frontier snapshot.
func ResumeSolver(sc *Scenario, path string) (*Solver, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var snap Snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("parse snapshot %s: %w", path, err)
	}
	sv := &Solver{
		sc:     sc,
		h:      sc.Heuristic(),
		dist:   make(map[State]int, len(snap.Dist)),
		parent: make(map[State]parentInfo, len(snap.Parent)),
		Pops:   snap.Pops,
	}
	for k, g := range snap.Dist {
		s, err := ParseState(k)
		if err != nil {
			return nil, err
		}
		sv.dist[s] = g
	}
	for k, p := range snap.Parent {
		s, err := ParseState(k)
		if err != nil {
			return nil, err
		}
		prev, err := ParseState(p.Prev)
		if err != nil {
			return nil, err
		}
		sv.parent[s] = parentInfo{Prev: prev, Act: p.Act}
	}
	sv.pq = append(sv.pq, snap.Heap...)
	heap.Init(&sv.pq)
	return sv, nil
}
