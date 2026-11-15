package dataeng

import (
	"math"
	"sort"
)

func (s *solver) result() Result {
	r := Result{
		Assignments: make(map[string]SplitName),
		Splits:      make(map[SplitName][]string, len(SplitOrder)),
		Indices:     make(map[SplitName][]int, len(SplitOrder)),
		Counts:      make(map[SplitName]map[string]float64, len(SplitOrder)),
		Proportions: make(map[SplitName]map[string]float64, len(SplitOrder)),
		TimeBounds:  make(map[SplitName]SplitTime, len(SplitOrder)),
		Targets:     copyTarget(s.p.target),
		Steps:       s.steps,
	}
	for _, split := range SplitOrder {
		r.Counts[split] = make(map[string]float64, len(s.p.classes))
		r.Proportions[split] = make(map[string]float64, len(s.p.classes))
		r.Splits[split] = []string{}
		r.Indices[split] = []int{}
		r.TimeBounds[split] = SplitTime{}
		for _, class := range s.p.classes {
			r.Counts[split][class] = 0
			r.Proportions[split][class] = 0
		}
	}

	r.Blocks = make([]GroupBlock, len(s.p.blocks))
	for i, b := range s.p.blocks {
		gb := GroupBlock{
			Key:          b.key,
			EntityIDs:    append([]string(nil), b.entityIDs...),
			GroupIDs:     append([]string(nil), b.groupIDs...),
			Earliest:     b.earliest,
			Latest:       b.latest,
			ClassWeights: make(map[string]float64, len(s.p.classes)),
			Weight:       b.weight,
		}
		for j, idx := range b.recordIdx {
			gb.RecordIDs = append(gb.RecordIDs, s.p.records[idx].ID)
			if j == 0 {
				gb.Earliest = s.p.records[idx].Time
				gb.Latest = gb.Earliest
			} else {
				t := s.p.records[idx].Time
				if t.Before(gb.Earliest) {
					gb.Earliest = t
				}
				if t.After(gb.Latest) {
					gb.Latest = t
				}
			}
		}
		for j, class := range s.p.classes {
			gb.ClassWeights[class] = b.classWeights[j]
		}
		r.Blocks[i] = gb
	}

	if !s.bestSet {
		r.Status = StatusBudgetExhausted
		if s.complete {
			r.Status = StatusInfeasible
		}
		r.Objective = infinite()
		r.UpperBound = infinite()
		r.LowerBound = 0
		if !s.complete && s.openCount > 0 {
			r.LowerBound = s.openBound
		}
		r.Gap = infinite()
		r.Proof = s.proof(r.LowerBound, r.UpperBound, r.Gap)
		return r
	}

	r.Feasible = true
	r.Objective = s.bestObj
	r.UpperBound = s.bestObj
	r.LowerBound = s.bestObj
	if !s.complete && s.openCount > 0 && s.openBound < r.LowerBound {
		r.LowerBound = s.openBound
	}
	r.Gap = math.Max(0, r.UpperBound-r.LowerBound)
	r.Status = StatusBudgetExhausted
	if s.complete {
		r.Status = StatusOptimal
	}

	for blockIdx, choice := range s.best {
		split := SplitOrder[choice]
		blockRecords := s.p.blocks[blockIdx].recordIdx
		for _, idx := range blockRecords {
			record := s.p.records[idx]
			r.Assignments[record.ID] = split
			r.Splits[split] = append(r.Splits[split], record.ID)
			r.Indices[split] = append(r.Indices[split], idx)
			r.Counts[split][record.Class] += record.Weight
		}
	}
	for _, split := range SplitOrder {
		sort.Strings(r.Splits[split])
		sort.Ints(r.Indices[split])
		for _, class := range s.p.classes {
			r.Proportions[split][class] = r.Counts[split][class] / s.p.totalWeight
		}
		r.TimeBounds[split] = splitTime(s.p.records, r.Indices[split])
	}
	for i, choice := range s.best {
		r.Blocks[i].Split = SplitOrder[choice]
	}

	r.Proof = s.proof(r.LowerBound, r.UpperBound, r.Gap)
	return r
}

func (s *solver) proof(lower, upper, gap float64) Proof {
	proof := Proof{
		Complete:   s.complete,
		LowerBound: lower,
		UpperBound: upper,
		Gap:        gap,
		OpenCount:  s.openCount,
		Open:       append([]OpenSubproblem(nil), s.open...),
	}
	switch {
	case s.complete && s.bestSet:
		proof.Reason = "proved optimal by exhaustive branch-and-bound"
	case s.complete && !s.bestSet:
		proof.Reason = "proved infeasible: every hard-constraint assignment was refuted"
	case s.stopReason != "":
		proof.Reason = s.stopReason
	default:
		proof.Reason = "search budget exhausted"
	}
	return proof
}

func splitTime(records []Record, indices []int) SplitTime {
	result := SplitTime{Count: len(indices)}
	if len(indices) == 0 {
		return result
	}
	result.Earliest = records[indices[0]].Time
	result.Latest = result.Earliest
	for _, idx := range indices[1:] {
		t := records[idx].Time
		if t.Before(result.Earliest) {
			result.Earliest = t
		}
		if t.After(result.Latest) {
			result.Latest = t
		}
	}
	return result
}

func copyTarget(target Target) Target {
	out := make(Target, len(target))
	for split, cells := range target {
		out[split] = make(map[string]float64, len(cells))
		for class, value := range cells {
			out[split][class] = value
		}
	}
	return out
}
