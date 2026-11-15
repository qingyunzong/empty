package dataeng

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// ErrVerification marks a split plan that violates its hard constraints or
// disagrees with its reported statistics.
var ErrVerification = errors.New("dataeng: verification failed")

// Verify independently re-groups the input and checks that result satisfies
// every hard constraint. It also recomputes the class counts, proportions, and
// objective.
func Verify(records []Record, cfg Config, result Result) error {
	p, err := prepare(records, cfg)
	if err != nil {
		return err
	}
	if !result.Feasible {
		if result.Status == StatusOptimal || len(result.Assignments) != 0 {
			return fmt.Errorf("%w: infeasible result carries assignments or optimal status", ErrVerification)
		}
		return nil
	}

	assigned := make(map[int]SplitName, len(p.records))
	for i, record := range p.records {
		split, ok := result.Assignments[record.ID]
		if !ok {
			return fmt.Errorf("%w: record %q is unassigned", ErrVerification, record.ID)
		}
		if !validSplitName(split) {
			return fmt.Errorf("%w: record %q has invalid split %q", ErrVerification, record.ID, split)
		}
		assigned[i] = split
	}
	if len(result.Assignments) != len(p.records) {
		return fmt.Errorf("%w: assignment contains unknown record IDs", ErrVerification)
	}

	var maxTrain, minTest timeValue
	var hasTrain, hasTest bool
	var splitCount [3]int
	for _, b := range p.blocks {
		var blockSplit SplitName
		for pos, idx := range b.recordIdx {
			split := assigned[idx]
			if pos == 0 {
				blockSplit = split
			} else if split != blockSplit {
				return fmt.Errorf("%w: leakage block %q crosses splits", ErrVerification, b.key)
			}
		}
		switch blockSplit {
		case Train:
			splitCount[0]++
			if !maxTrain.set || b.latest.After(maxTrain.time) {
				maxTrain.time = b.latest
				maxTrain.set = true
			}
			hasTrain = true
		case Validation:
			splitCount[1]++
		case Test:
			splitCount[2]++
			if !minTest.set || b.earliest.Before(minTest.time) {
				minTest.time = b.earliest
				minTest.set = true
			}
			hasTest = true
		default:
			return fmt.Errorf("%w: leakage block %q has no split", ErrVerification, b.key)
		}
	}
	if !p.allowEmptySplits {
		for split, count := range splitCount {
			if count == 0 {
				return fmt.Errorf("%w: split %s is empty", ErrVerification, SplitOrder[split])
			}
		}
	}
	if p.hasTime && hasTrain && hasTest && !maxTrain.time.Before(minTest.time) {
		return fmt.Errorf("%w: test is not strictly later than train (%s <= %s)", ErrVerification, maxTrain.time, minTest.time)
	}

	counts := make([]float64, 3*len(p.classes))
	classIndex := make(map[string]int, len(p.classes))
	for i, class := range p.classes {
		classIndex[class] = i
	}
	for i, record := range p.records {
		split := assigned[i]
		splitIndex := splitIndex(split)
		counts[splitIndex*len(p.classes)+classIndex[record.Class]] += record.Weight / p.totalWeight
	}
	s := newSolver(p, Unlimited, 0)
	objective := s.objective(counts)
	tolerance := math.Max(1e-9, p.epsilon*10)
	if math.Abs(objective-result.Objective) > tolerance {
		return fmt.Errorf("%w: objective is %v, reported %v", ErrVerification, objective, result.Objective)
	}

	for _, split := range SplitOrder {
		ids := result.Splits[split]
		if len(ids) != len(result.Indices[split]) {
			return fmt.Errorf("%w: %s split has mismatched IDs and indices", ErrVerification, split)
		}
		seenIDs := make(map[string]struct{}, len(ids))
		expectedCounts := make(map[string]float64, len(p.classes))
		for _, class := range p.classes {
			expectedCounts[class] = 0
		}
		for _, idx := range result.Indices[split] {
			if idx < 0 || idx >= len(p.records) {
				return fmt.Errorf("%w: %s split has out-of-range index %d", ErrVerification, split, idx)
			}
			record := p.records[idx]
			if assigned[idx] != split {
				return fmt.Errorf("%w: index %d is listed under %s but assigned %s", ErrVerification, idx, split, assigned[idx])
			}
			if _, exists := seenIDs[record.ID]; exists {
				return fmt.Errorf("%w: record %q appears twice in %s", ErrVerification, record.ID, split)
			}
			seenIDs[record.ID] = struct{}{}
			expectedCounts[record.Class] += record.Weight
		}
		if len(seenIDs) != len(ids) {
			return fmt.Errorf("%w: %s split ID/index mismatch", ErrVerification, split)
		}
		for _, id := range ids {
			if _, exists := seenIDs[id]; !exists {
				return fmt.Errorf("%w: %s split lists unknown or misplaced record %q", ErrVerification, split, id)
			}
		}
		for _, class := range p.classes {
			got := result.Counts[split][class]
			if math.Abs(got-expectedCounts[class]) > tolerance {
				return fmt.Errorf("%w: %s/%q count is %v, expected %v", ErrVerification, split, class, got, expectedCounts[class])
			}
			proportion := expectedCounts[class] / p.totalWeight
			if math.Abs(result.Proportions[split][class]-proportion) > tolerance {
				return fmt.Errorf("%w: %s/%q proportion is %v, expected %v", ErrVerification, split, class, result.Proportions[split][class], proportion)
			}
		}
	}
	return nil
}

type timeValue struct {
	time time.Time
	set  bool
}

func validSplitName(split SplitName) bool {
	return split == Train || split == Validation || split == Test
}

func splitIndex(split SplitName) int {
	for i, name := range SplitOrder {
		if name == split {
			return i
		}
	}
	return 0
}

// SplitOf returns the output partition of a record.
func (r Result) SplitOf(recordID string) (SplitName, bool) {
	split, ok := r.Assignments[recordID]
	return split, ok
}
