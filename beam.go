package dataeng

import (
	"container/heap"
	"fmt"
	"sort"
)

type beamState struct {
	parent     *beamState
	page       int
	choice     int
	mask       bitset
	cost       float64
	lowerBound float64
	lastNum    int
	lastChoice int
	depth      int
	order      int64
}

func (s *beamState) score() float64 {
	return s.cost + s.lowerBound
}

func beamWorse(a, b *beamState) bool {
	af, bf := a.score(), b.score()
	if absf(af-bf) > costEpsilon {
		return af > bf
	}
	if absf(a.cost-b.cost) > costEpsilon {
		return a.cost > b.cost
	}
	return a.order > b.order
}

func beamBetter(a, b *beamState) bool {
	return beamWorse(b, a)
}

type beamHeap []*beamState

func (h beamHeap) Len() int           { return len(h) }
func (h beamHeap) Less(i, j int) bool { return beamWorse(h[i], h[j]) }
func (h beamHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *beamHeap) Push(x any) {
	*h = append(*h, x.(*beamState))
}

func (h *beamHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return item
}

func (m *model) solveBeam() (Result, error) {
	n := len(m.pages)
	if n == 0 {
		arr, err := m.evaluate(nil, nil)
		if err != nil {
			return Result{}, err
		}
		return Result{Candidates: []Arrangement{arr}}, nil
	}

	minUnary := make([]float64, n)
	totalLowerBound := 0.0
	for i := range m.pages {
		best := m.unaryTotal(i, 0)
		for ci := 1; ci < len(m.choices[i]); ci++ {
			if v := m.unaryTotal(i, ci); v < best {
				best = v
			}
		}
		minUnary[i] = best
		totalLowerBound += best
	}

	width := max(m.opts.BeamWidth, m.opts.MaxCandidates*4)
	// Keep the transient child set bounded for large batches.
	if perPage := n * m.cMax; perPage > 0 {
		capWidth := 2_000_000 / perPage
		if capWidth < 4 {
			capWidth = 4
		}
		if width > capWidth {
			width = capWidth
		}
	}

	root := &beamState{
		page:       -1,
		mask:       newBitset(n),
		lastNum:    -1,
		lastChoice: 0,
		lowerBound: totalLowerBound,
	}
	current := []*beamState{root}
	nextOrder := int64(1)

	for depth := 0; depth < n; depth++ {
		h := make(beamHeap, 0, width)
		for _, st := range current {
			for page := 0; page < n; page++ {
				if st.mask.has(page) {
					continue
				}
				for ci := range m.choices[page] {
					nextMask := st.mask.clone()
					nextMask.set(page)
					order, continuity := m.sequenceCost(page, ci, st.lastNum, st.lastChoice)
					cost := st.cost +
						m.unaryTotal(page, ci) +
						m.fileCost(st.mask, page) +
						order + continuity
					nextLast, nextChoice := m.neededLast(page, ci, st.lastNum, st.lastChoice)
					child := &beamState{
						parent:     st,
						page:       page,
						choice:     ci,
						mask:       nextMask,
						cost:       cost,
						lowerBound: st.lowerBound - minUnary[page],
						lastNum:    nextLast,
						lastChoice: nextChoice,
						depth:      depth + 1,
						order:      nextOrder,
					}
					nextOrder++

					if len(h) < width {
						heap.Push(&h, child)
					} else if beamBetter(child, h[0]) {
						heap.Pop(&h)
						heap.Push(&h, child)
					}
				}
			}
		}
		current = current[:0]
		for len(h) > 0 {
			current = append(current, heap.Pop(&h).(*beamState))
		}
		sort.Slice(current, func(i, j int) bool {
			return beamBetter(current[i], current[j])
		})
	}

	cands := make([]solvedArrangement, 0, len(current))
	for _, st := range current {
		seq, choices := reconstructBeam(st)
		s, err := m.solved(seq, choices)
		if err != nil {
			return Result{}, err
		}
		cands = append(cands, s)
	}
	if len(cands) == 0 {
		return Result{}, fmt.Errorf("dataeng: beam search produced no arrangements")
	}
	return m.buildResult(cands, false, false), nil
}

func reconstructBeam(st *beamState) ([]int, []int) {
	n := st.depth
	seq := make([]int, n)
	choices := make([]int, n)
	for cur := st; cur.parent != nil; cur = cur.parent {
		seq[n-1] = cur.page
		choices[n-1] = cur.choice
		n--
	}
	return seq, choices
}

func absf(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
