// Package timetable chooses discrete departure offsets for transit lines
// that share a common cyclic period.
//
// Each line picks one offset from its own discrete domain. A directed
// transfer pair (From -> To) is penalized when the cyclic waiting time
// exceeds its threshold. Waiting time is measured modulo the period, and
// a same-time connection (waiting time 0) is always feasible: there is no
// minimum connection time, so wait 0 never exceeds a non-negative
// threshold and never incurs a penalty.
//
// The solver minimizes the total penalty; ties are broken by choosing the
// lexicographically smallest offset vector.
package timetable

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// Limits required by the problem statement.
const (
	MaxLines      = 8
	MaxDomainSize = 12
)

// Line is one transit line whose departure offset must be chosen.
type Line struct {
	// Domain lists the candidate departure offsets, each in [0, Period).
	// It holds at most MaxDomainSize values; duplicates are ignored.
	Domain []int
}

// Transfer penalizes the connection from line From to line To when the
// cyclic waiting time exceeds Threshold. The incurred penalty is
// Weight * (wait - Threshold); it is zero when wait <= Threshold.
type Transfer struct {
	From, To  int
	Threshold int
	Weight    int
}

// Problem bundles the shared cyclic period, the lines, and the
// transfer pairs to optimize over.
type Problem struct {
	Period    int
	Lines     []Line
	Transfers []Transfer
}

// Solution is the optimal offset assignment.
type Solution struct {
	Offsets []int
	Penalty int
}

// WaitingTime returns the cyclic waiting time for a transfer from a
// departure at offset from to the next departure at offset to, measured
// modulo period. The result lies in [0, period); 0 means the two
// departures coincide and the transfer is immediate.
func WaitingTime(from, to, period int) int {
	wait := (to - from) % period
	if wait < 0 {
		wait += period
	}
	return wait
}

// transferPenalty computes the penalty of one transfer pair.
func transferPenalty(tr Transfer, fromOffset, toOffset, period int) int {
	wait := WaitingTime(fromOffset, toOffset, period)
	if wait <= tr.Threshold {
		return 0
	}
	return tr.Weight * (wait - tr.Threshold)
}

// Validate checks the problem against the structural limits.
func Validate(p Problem) error {
	if p.Period <= 0 {
		return fmt.Errorf("period must be positive, got %d", p.Period)
	}
	if len(p.Lines) == 0 {
		return errors.New("at least one line is required")
	}
	if len(p.Lines) > MaxLines {
		return fmt.Errorf("at most %d lines, got %d", MaxLines, len(p.Lines))
	}
	for i, ln := range p.Lines {
		if len(ln.Domain) == 0 {
			return fmt.Errorf("line %d has an empty domain", i)
		}
		if len(ln.Domain) > MaxDomainSize {
			return fmt.Errorf("line %d domain has %d values, max %d", i, len(ln.Domain), MaxDomainSize)
		}
		for _, off := range ln.Domain {
			if off < 0 || off >= p.Period {
				return fmt.Errorf("line %d domain offset %d outside [0, %d)", i, off, p.Period)
			}
		}
	}
	for i, tr := range p.Transfers {
		if tr.From < 0 || tr.From >= len(p.Lines) || tr.To < 0 || tr.To >= len(p.Lines) {
			return fmt.Errorf("transfer %d references line (%d, %d) outside [0, %d)", i, tr.From, tr.To, len(p.Lines))
		}
		if tr.Threshold < 0 {
			return fmt.Errorf("transfer %d has negative threshold %d", i, tr.Threshold)
		}
		if tr.Weight < 0 {
			return fmt.Errorf("transfer %d has negative weight %d", i, tr.Weight)
		}
	}
	return nil
}

// Evaluate returns the total penalty of a complete offset assignment.
// Every offset must belong to its line's domain.
func Evaluate(p Problem, offsets []int) (int, error) {
	if err := Validate(p); err != nil {
		return 0, err
	}
	if len(offsets) != len(p.Lines) {
		return 0, fmt.Errorf("got %d offsets for %d lines", len(offsets), len(p.Lines))
	}
	for i, off := range offsets {
		if !contains(p.Lines[i].Domain, off) {
			return 0, fmt.Errorf("offset %d not in domain of line %d", off, i)
		}
	}
	total := 0
	for _, tr := range p.Transfers {
		total += transferPenalty(tr, offsets[tr.From], offsets[tr.To], p.Period)
	}
	return total, nil
}

func contains(domain []int, v int) bool {
	for _, d := range domain {
		if d == v {
			return true
		}
	}
	return false
}

// Solve finds the offset vector with the minimum total penalty, breaking
// ties toward the lexicographically smallest vector.
//
// It enumerates the Cartesian product of the per-line domains in
// lexicographic order, evaluating transfer penalties incrementally and
// pruning any partial assignment whose accumulated penalty already
// reaches the best complete penalty (penalties are non-negative, so the
// accumulated value is a valid lower bound). The first optimal leaf in
// lexicographic order is the answer, which makes the tie-break exact.
func Solve(p Problem) (Solution, error) {
	if err := Validate(p); err != nil {
		return Solution{}, err
	}

	n := len(p.Lines)
	domains := make([][]int, n)
	for i, ln := range p.Lines {
		dedup := make(map[int]struct{}, len(ln.Domain))
		for _, off := range ln.Domain {
			dedup[off] = struct{}{}
		}
		domains[i] = make([]int, 0, len(dedup))
		for off := range dedup {
			domains[i] = append(domains[i], off)
		}
		sort.Ints(domains[i])
	}

	// Group transfers by their larger endpoint so the penalty of a pair
	// becomes known exactly when that endpoint is assigned.
	byMaxEndpoint := make([][]Transfer, n)
	for _, tr := range p.Transfers {
		m := tr.From
		if tr.To > m {
			m = tr.To
		}
		byMaxEndpoint[m] = append(byMaxEndpoint[m], tr)
	}

	best := Solution{Penalty: math.MaxInt}
	current := make([]int, n)

	var search func(line, penalty int)
	search = func(line, penalty int) {
		if penalty >= best.Penalty {
			return
		}
		if line == n {
			best.Penalty = penalty
			best.Offsets = append([]int(nil), current...)
			return
		}
		for _, off := range domains[line] {
			current[line] = off
			added := 0
			for _, tr := range byMaxEndpoint[line] {
				added += transferPenalty(tr, current[tr.From], current[tr.To], p.Period)
			}
			search(line+1, penalty+added)
		}
	}
	search(0, 0)
	return best, nil
}
