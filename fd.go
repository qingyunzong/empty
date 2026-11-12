package dataeng

import (
	"errors"
	"sort"
)

// MaxColumns is the largest number of columns a relation may contain.
const MaxColumns = 16

// Cell is a single relation value. A nil *string represents null, which is a
// distinct value equal only to another null.
type Cell = *string

// Relation is a finite set of rows, each row a slice of column cells.
type Relation = [][]Cell

// Dependency is a minimal exact functional dependency Left -> Target.
// Left holds ascending column indices and never contains Target; Left is a
// non-nil empty slice when the target column is constant.
type Dependency struct {
	Target int   `json:"target"`
	Left   []int `json:"left"`
}

// RejectedCandidate records a candidate Left -> Target that does not hold,
// together with one original counterexample pair of zero-based row indices.
// The two rows agree on every column of Left but differ on Target.
type RejectedCandidate struct {
	Target int   `json:"target"`
	Left   []int `json:"left"`
	Row1   int   `json:"row1"`
	Row2   int   `json:"row2"`
}

// Report contains the discovery result for a whole relation.
type Report struct {
	Dependencies       []Dependency        `json:"dependencies"`
	RejectedCandidates []RejectedCandidate `json:"rejected_candidates"`
}

var (
	// ErrTooManyColumns is returned when a relation has more than MaxColumns.
	ErrTooManyColumns = errors.New("dataeng: relation has more than 16 columns")
	// ErrRaggedRows is returned when rows do not share the same width.
	ErrRaggedRows = errors.New("dataeng: relation rows have inconsistent lengths")
)

// FindFunctionalDependencies returns the minimal exact functional
// dependencies of rows. It is an alias of Discover that returns only the
// accepted dependencies, ordered by target column and then by the ascending
// left-hand-side index list.
func FindFunctionalDependencies(rows Relation) ([]Dependency, error) {
	report, err := Discover(rows)
	if err != nil {
		return nil, err
	}
	return report.Dependencies, nil
}

// FunctionalDependencies is an alternate spelling of FindFunctionalDependencies.
func FunctionalDependencies(rows Relation) ([]Dependency, error) {
	return FindFunctionalDependencies(rows)
}

// Discover enumerates every candidate left-hand side for each target column
// using subset enumeration and row-by-row comparison, returning the minimal
// dependencies and a counterexample pair for every rejected candidate.
func Discover(rows Relation) (Report, error) {
	report := Report{
		Dependencies:       []Dependency{},
		RejectedCandidates: []RejectedCandidate{},
	}

	width := 0
	if len(rows) > 0 {
		width = len(rows[0])
	}
	if width > MaxColumns {
		return report, ErrTooManyColumns
	}
	for rowIndex := range rows {
		if len(rows[rowIndex]) != width {
			return report, ErrRaggedRows
		}
	}

	for target := 0; target < width; target++ {
		columns := make([]int, 0, width-1)
		for column := 0; column < width; column++ {
			if column != target {
				columns = append(columns, column)
			}
		}
		universeSize := len(columns)
		limit := uint16(1) << universeSize
		holds := make([]bool, limit)

		// witness maps the disagreement mask of a target-violating row pair
		// to the first pair (row-major order) producing that mask;
		// violationMasks keeps those masks in first-seen order.
		witness := make(map[uint16]badPair)
		violationMasks := make([]uint16, 0)
		for i := 0; i < len(rows); i++ {
			for j := i + 1; j < len(rows); j++ {
				if cellsEqual(rows[i][target], rows[j][target]) {
					continue
				}
				mask := uint16(0)
				for k, column := range columns {
					if !cellsEqual(rows[i][column], rows[j][column]) {
						mask |= uint16(1) << k
					}
				}
				if _, seen := witness[mask]; !seen {
					witness[mask] = badPair{row1: i, row2: j, diffMask: mask}
					violationMasks = append(violationMasks, mask)
				}
			}
		}
		// violationLookup[mask] is the row-major first disagreement mask of a
		// pair agreeing on every selected column of mask; violationSet[mask]
		// distinguishes a held candidate from the zero disagreement mask.
		violationLookup := make([]uint16, limit)
		violationSet := make([]bool, limit)
		for _, diffMask := range violationMasks {
			complement := (limit - 1) ^ diffMask
			sub := complement
			for {
				if !violationSet[sub] {
					violationLookup[sub] = diffMask
					violationSet[sub] = true
				}
				if sub == 0 {
					break
				}
				sub = (sub - 1) & complement
			}
		}

		for mask := uint16(0); mask < limit; mask++ {
			violating := false
			var violationMask uint16
			switch {
			case holdsViaSubset(mask, holds):
				// A known holding subset means the superset holds as well.
			case violationSet[mask]:
				// Row-by-row verification: the recorded pair agrees on
				// every selected column but differs on the target.
				violating = true
				violationMask = violationLookup[mask]
			default:
				// No counterexample: the candidate holds.
			}
			list := maskToList(mask, columns)
			if violating {
				pair := witness[violationMask]
				report.RejectedCandidates = append(report.RejectedCandidates, RejectedCandidate{
					Target: target,
					Left:   list,
					Row1:   pair.row1,
					Row2:   pair.row2,
				})
				continue
			}

			holds[mask] = true
			if !isMinimal(mask, holds) {
				continue
			}
			report.Dependencies = append(report.Dependencies, Dependency{
				Target: target,
				Left:   list,
			})
		}
	}

	sortDependencies(report.Dependencies)
	sortRejected(report.RejectedCandidates)
	return report, nil
}

// holdsViaSubset reports whether mask contains a proper subset already known
// to hold, in which case mask necessarily holds as well because adding
// columns to a left-hand side preserves the dependency.
func holdsViaSubset(mask uint16, holds []bool) bool {
	if mask == 0 {
		return false
	}
	for bit := uint16(1); bit != 0 && bit <= mask; bit <<= 1 {
		if mask&bit != 0 && holds[mask^bit] {
			return true
		}
	}
	return false
}

// badPair is two rows whose target values differ, with diffMask marking
// every candidate column where the rows also differ.
type badPair struct {
	row1     int
	row2     int
	diffMask uint16
}

// isMinimal reports whether no proper subset of mask is itself a holding
// candidate. The empty mask has no proper subsets and is minimal whenever
// it holds.
func isMinimal(mask uint16, holds []bool) bool {
	sub := (mask - 1) & mask
	for sub != mask {
		if holds[sub] {
			return false
		}
		if sub == 0 {
			break
		}
		sub = (sub - 1) & mask
	}
	return true
}

// maskToList converts a subset mask to the ascending list of relation column
// indices represented by columns.
func maskToList(mask uint16, columns []int) []int {
	list := make([]int, 0, bitCount(mask))
	for k, column := range columns {
		if mask&(uint16(1)<<k) != 0 {
			list = append(list, column)
		}
	}
	return list
}

// cellsEqual compares two cells with null as a distinct equatable value.
func cellsEqual(a, b Cell) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func bitCount(mask uint16) int {
	count := 0
	for mask != 0 {
		mask &= mask - 1
		count++
	}
	return count
}

func sortDependencies(dependencies []Dependency) {
	sort.Slice(dependencies, func(i, j int) bool {
		if dependencies[i].Target != dependencies[j].Target {
			return dependencies[i].Target < dependencies[j].Target
		}
		return compareLists(dependencies[i].Left, dependencies[j].Left) < 0
	})
}

func sortRejected(rejected []RejectedCandidate) {
	sort.Slice(rejected, func(i, j int) bool {
		if rejected[i].Target != rejected[j].Target {
			return rejected[i].Target < rejected[j].Target
		}
		return compareLists(rejected[i].Left, rejected[j].Left) < 0
	})
}

// compareLists orders ascending index lists lexicographically; a proper
// prefix sorts first.
func compareLists(a, b []int) int {
	for k := 0; k < len(a) && k < len(b); k++ {
		if a[k] != b[k] {
			if a[k] < b[k] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	default:
		return 0
	}
}
