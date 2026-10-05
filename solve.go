package main

import "container/heap"

// pqItem is one frontier entry of the search.
type pqItem struct {
	Key  uint64 `json:"key"`
	Dist int    `json:"dist"`
}

// priorityQueue is a min-heap by Dist (ties broken by key for determinism).
type priorityQueue []pqItem

func (q priorityQueue) Len() int { return len(q) }
func (q priorityQueue) Less(i, j int) bool {
	if q[i].Dist != q[j].Dist {
		return q[i].Dist < q[j].Dist
	}
	return q[i].Key < q[j].Key
}
func (q priorityQueue) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *priorityQueue) Push(x interface{}) {
	*q = append(*q, x.(pqItem))
}
func (q *priorityQueue) Pop() interface{} {
	old := *q
	n := len(old)
	it := old[n-1]
	*q = old[:n-1]
	return it
}

// parentInfo records how a state was reached with its best cost.
type parentInfo struct {
	Prev uint64     `json:"prev"`
	Tr   Transition `json:"tr"`
}

// label is a settled state summary used for dominance pruning.
type label struct {
	fuel    int
	coupons uint8
	slots   [MaxStations]int
	time    int
	cost    int
}

// dominatesState reports whether the settled label covers the candidate: at
// least as much fuel, a superset of coupons, at least as many slots
// everywhere, no later in time, and no more expensive. Because the low-fuel
// surcharge only decreases with more fuel and waiting is always allowed, any
// continuation of the candidate is also feasible from the label at no greater
// cost, so pruning the candidate is exact.
func (l label) dominatesState(s State, cost int) bool {
	if l.cost > cost || l.fuel < s.Fuel || l.time > s.Time {
		return false
	}
	if l.coupons&s.Coupons != s.Coupons {
		return false
	}
	for i := 0; i < MaxStations; i++ {
		if l.slots[i] < s.Slots[i] {
			return false
		}
	}
	return true
}

func (l label) dominatesLabel(o label) bool {
	if l.cost > o.cost || l.fuel < o.fuel || l.time > o.time {
		return false
	}
	if l.coupons&o.coupons != o.coupons {
		return false
	}
	for i := 0; i < MaxStations; i++ {
		if l.slots[i] < o.slots[i] {
			return false
		}
	}
	return true
}

// Solver runs Dijkstra over the finite state graph. It can pause at any
// expansion boundary and serialize its complete frontier.
type Solver struct {
	g       *Graph
	noPrune bool

	dist    map[uint64]int
	settled map[uint64]bool
	parent  map[uint64]parentInfo
	pq      priorityQueue
	labels  map[int][]label

	Steps   int // number of settled states
	Found   bool
	Done    bool
	goalKey uint64
	Best    int
}

// NewSolver creates a fresh solver for g. noPrune disables dominance pruning
// (used as an independent cross-check).
func NewSolver(g *Graph, noPrune bool) *Solver {
	s := &Solver{
		g:       g,
		noPrune: noPrune,
		dist:    map[uint64]int{},
		settled: map[uint64]bool{},
		parent:  map[uint64]parentInfo{},
		labels:  map[int][]label{},
	}
	k := g.InitialState().Key()
	s.dist[k] = 0
	heap.Push(&s.pq, pqItem{Key: k, Dist: 0})
	return s
}

func (s *Solver) dominated(st State, cost int) bool {
	for _, l := range s.labels[st.Node] {
		if l.dominatesState(st, cost) {
			return true
		}
	}
	return false
}

func (s *Solver) addLabel(st State, cost int) {
	nl := label{fuel: st.Fuel, coupons: st.Coupons, slots: st.Slots, time: st.Time, cost: cost}
	kept := s.labels[st.Node][:0]
	for _, l := range s.labels[st.Node] {
		if !nl.dominatesLabel(l) {
			kept = append(kept, l)
		}
	}
	s.labels[st.Node] = append(kept, nl)
}

// expandOne settles the next frontier state.
func (s *Solver) expandOne() {
	for s.pq.Len() > 0 {
		it := heap.Pop(&s.pq).(pqItem)
		if d, ok := s.dist[it.Key]; ok && it.Dist > d {
			continue // stale heap entry
		}
		if s.settled[it.Key] {
			continue
		}
		st := stateFromKey(it.Key)
		if !s.noPrune && s.dominated(st, it.Dist) {
			continue
		}
		s.settled[it.Key] = true
		s.Steps++
		s.addLabel(st, it.Dist)
		if st.Node == s.g.Goal {
			s.Found, s.Done = true, true
			s.goalKey, s.Best = it.Key, it.Dist
			return
		}
		for _, succ := range s.g.Successors(st) {
			nk := succ.Next.Key()
			nd := it.Dist + succ.Tr.Cost
			if old, ok := s.dist[nk]; !ok || nd < old {
				s.dist[nk] = nd
				s.parent[nk] = parentInfo{Prev: it.Key, Tr: succ.Tr}
				heap.Push(&s.pq, pqItem{Key: nk, Dist: nd})
			}
		}
		return
	}
	s.Done = true
}

// Run expands states until the search finishes or maxSteps further states
// have been settled (maxSteps <= 0 means no limit).
func (s *Solver) Run(maxSteps int) {
	settledThisRun := 0
	for !s.Done {
		if maxSteps > 0 && settledThisRun >= maxSteps {
			return
		}
		s.expandOne()
		settledThisRun++
	}
}

// Checkpoint is the complete serializable search frontier: priority queue,
// best-cost table, settled set, parent pointers, and the step counter.
type Checkpoint struct {
	Dist    map[uint64]int        `json:"dist"`
	Settled []uint64              `json:"settled"`
	Parent  map[uint64]parentInfo `json:"parent"`
	Heap    []pqItem              `json:"heap"`
	Steps   int                   `json:"steps"`
}

// Save captures the full frontier so the query can be paused and resumed.
func (s *Solver) Save() *Checkpoint {
	cp := &Checkpoint{
		Dist:   s.dist,
		Parent: s.parent,
		Heap:   append([]pqItem(nil), s.pq...),
		Steps:  s.Steps,
	}
	for k := range s.settled {
		cp.Settled = append(cp.Settled, k)
	}
	return cp
}

// Resume restores a solver from a checkpoint.
func Resume(g *Graph, noPrune bool, cp *Checkpoint) *Solver {
	s := &Solver{
		g:       g,
		noPrune: noPrune,
		dist:    cp.Dist,
		settled: map[uint64]bool{},
		parent:  cp.Parent,
		pq:      append(priorityQueue(nil), cp.Heap...),
		labels:  map[int][]label{},
		Steps:   cp.Steps,
	}
	for _, k := range cp.Settled {
		s.settled[k] = true
		s.addLabel(stateFromKey(k), cp.Dist[k])
	}
	heap.Init(&s.pq)
	return s
}

// Path reconstructs the optimal sequence of states and transitions.
func (s *Solver) Path() ([]State, []Transition) {
	if !s.Found {
		return nil, nil
	}
	var keys []uint64
	for k := s.goalKey; ; {
		keys = append(keys, k)
		p, ok := s.parent[k]
		if !ok {
			break
		}
		k = p.Prev
	}
	n := len(keys)
	states := make([]State, n)
	trs := make([]Transition, n-1)
	for i, k := range keys {
		states[n-1-i] = stateFromKey(k)
		if i < n-1 {
			// keys[i] is states[n-1-i]; the transition into it is
			// trs[n-2-i]. keys[n-1] is the start and has no parent.
			trs[n-2-i] = s.parent[k].Tr
		}
	}
	return states, trs
}
