package dataeng

import (
	"fmt"
	"math"
	"math/bits"
	"sort"
)

type dpEntry struct {
	cost float64
	prev int32
	rank uint16
}

type dpList struct {
	entries []dpEntry
}

func (m *model) exactState(mask uint64, lastNum, lastChoice int) int {
	return (int(mask)*(len(m.pages)+1)+lastNum)*m.cMax + lastChoice
}

func (m *model) decodeExactState(state int) (mask uint64, lastNum, lastChoice int) {
	mask = uint64(state / ((len(m.pages) + 1) * m.cMax))
	rem := state % ((len(m.pages) + 1) * m.cMax)
	lastNum = rem / m.cMax
	lastChoice = rem % m.cMax
	return
}

func (m *model) exactFileCost(mask uint64, page int) float64 {
	// The exact solver only accepts at most maxExactPages <= 64 pages,
	// so the first bitset word is the complete placed-set mask.
	inv := bits.OnesCount64(mask & m.higherBits[page][0])
	return m.opts.Weights.FileOrder * float64(inv)
}

func addDPEntry(list *dpList, e dpEntry, limit int) bool {
	pos := sort.Search(len(list.entries), func(i int) bool {
		cur := list.entries[i]
		if math.Abs(cur.cost-e.cost) > costEpsilon {
			return cur.cost > e.cost
		}
		if cur.prev != e.prev {
			return cur.prev > e.prev
		}
		return cur.rank > e.rank
	})
	list.entries = append(list.entries, dpEntry{})
	copy(list.entries[pos+1:], list.entries[pos:])
	list.entries[pos] = e
	if len(list.entries) > limit {
		dropped := list.entries[len(list.entries)-1]
		list.entries = list.entries[:limit]
		cutoff := list.entries[limit-1].cost
		return math.Abs(cutoff-dropped.cost) <= costEpsilon
	}
	return false
}

func (m *model) solveExact() (Result, error) {
	n := len(m.pages)
	if n == 0 {
		arr, err := m.evaluate(nil, nil)
		if err != nil {
			return Result{}, err
		}
		return Result{
			Candidates: []Arrangement{arr},
			Exhaustive: true,
		}, nil
	}
	if n > maxExactPages {
		return Result{}, fmt.Errorf("%w: %d pages, limit %d", ErrTooManyPages, n, maxExactPages)
	}
	stateCount := (1 << uint(n)) * (n + 1) * m.cMax
	if stateCount > maxExactState {
		return Result{}, fmt.Errorf("%w: %d states, limit %d", ErrTooManyPages, stateCount, maxExactState)
	}

	listLimit := max(m.opts.MaxCandidates*2, 8)
	if listLimit > 64 {
		listLimit = 64
	}
	dp := make([]dpList, stateCount)
	start := m.exactState(0, n, 0)
	dp[start].entries = []dpEntry{{cost: 0, prev: -1}}

	fullMask := uint64(1)<<uint(n) - 1
	truncated := false
	for mask := 0; mask <= (1<<uint(n))-1; mask++ {
		if mask == 1<<uint(n)-1 {
			continue
		}
		mask64 := uint64(mask)
		for lastNum := 0; lastNum <= n; lastNum++ {
			if lastNum == n {
				state := m.exactState(mask64, n, 0)
				m.expandExactState(dp, state, mask64, n, 0, fullMask, listLimit, &truncated)
				break
			}
			for ci := 0; ci < len(m.choices[lastNum]); ci++ {
				state := m.exactState(mask64, lastNum, ci)
				m.expandExactState(dp, state, mask64, lastNum, ci, fullMask, listLimit, &truncated)
			}
		}
	}

	var cands []solvedArrangement
	for lastNum := 0; lastNum <= n; lastNum++ {
		if lastNum == n {
			state := m.exactState(fullMask, n, 0)
			if err := m.collectExactState(dp, state, fullMask, n, 0, &cands, &truncated); err != nil {
				return Result{}, err
			}
			continue
		}
		for ci := 0; ci < len(m.choices[lastNum]); ci++ {
			state := m.exactState(fullMask, lastNum, ci)
			if err := m.collectExactState(dp, state, fullMask, lastNum, ci, &cands, &truncated); err != nil {
				return Result{}, err
			}
		}
	}
	if len(cands) == 0 {
		return Result{}, fmt.Errorf("dataeng: exact solver produced no arrangements")
	}
	return m.buildResult(cands, true, truncated), nil
}

func (m *model) expandExactState(
	dp []dpList,
	state int,
	mask uint64,
	lastNum, lastChoice int,
	fullMask uint64,
	listLimit int,
	truncated *bool,
) {
	list := &dp[state]
	if len(list.entries) == 0 {
		return
	}
	for rank, e := range list.entries {
		remaining := fullMask &^ mask
		for remaining != 0 {
			page := bits.TrailingZeros64(remaining)
			remaining &= remaining - 1
			if page >= len(m.pages) {
				continue
			}
			for ci := range m.choices[page] {
				nextLast, nextChoice := m.neededLast(page, ci, lastNum, lastChoice)
				cost := e.cost + m.unaryTotal(page, ci) +
					m.exactFileCost(mask, page)
				order, continuity := m.sequenceCost(page, ci, lastNum, lastChoice)
				cost += order + continuity
				nextMask := mask | (uint64(1) << uint(page))
				nextState := m.exactState(nextMask, nextLast, nextChoice)
				if addDPEntry(&dp[nextState], dpEntry{
					cost: cost,
					prev: int32(state),
					rank: uint16(rank),
				}, listLimit) {
					*truncated = true
				}
			}
		}
	}
}

func (m *model) collectExactState(
	dp []dpList,
	state int,
	mask uint64,
	lastNum, lastChoice int,
	cands *[]solvedArrangement,
	truncated *bool,
) error {
	list := &dp[state]
	for _, e := range list.entries {
		seq, choices, err := m.reconstructExact(dp, mask, lastNum, lastChoice, e)
		if err != nil {
			return err
		}
		s, err := m.solved(seq, choices)
		if err != nil {
			return err
		}
		if math.Abs(s.arr.Cost-e.cost) > 1e-6 {
			return fmt.Errorf("dataeng: exact cost mismatch: dp=%v evaluated=%v", e.cost, s.arr.Cost)
		}
		*cands = append(*cands, s)
	}
	return nil
}

func (m *model) reconstructExact(
	dp []dpList,
	mask uint64,
	lastNum, lastChoice int,
	e dpEntry,
) ([]int, []int, error) {
	n := len(m.pages)
	revSeq := make([]int, 0, n)
	revChoices := make([]int, 0, n)

	curMask := mask
	curLastNum := lastNum
	curLastChoice := lastChoice
	curEntry := e

	for curEntry.prev >= 0 {
		prevState := int(curEntry.prev)
		prevMask, prevLastNum, prevLastChoice := m.decodeExactState(prevState)
		diff := curMask &^ prevMask
		if diff == 0 || diff&(diff-1) != 0 {
			return nil, nil, fmt.Errorf("dataeng: invalid exact predecessor chain")
		}
		page := bits.TrailingZeros64(diff)
		ci := 0
		if page < n && m.pages[page].Role == RoleContent && curLastNum == page {
			ci = curLastChoice
		}
		revSeq = append(revSeq, page)
		revChoices = append(revChoices, ci)

		if int(curEntry.rank) >= len(dp[prevState].entries) {
			return nil, nil, fmt.Errorf("dataeng: invalid exact predecessor rank")
		}
		curEntry = dp[prevState].entries[curEntry.rank]
		curMask = prevMask
		curLastNum = prevLastNum
		curLastChoice = prevLastChoice
	}

	if len(revSeq) != n {
		return nil, nil, fmt.Errorf("dataeng: exact chain has %d pages, want %d", len(revSeq), n)
	}
	seq := make([]int, n)
	choices := make([]int, n)
	for i := range revSeq {
		seq[n-1-i] = revSeq[i]
		choices[n-1-i] = revChoices[i]
	}
	return seq, choices, nil
}
