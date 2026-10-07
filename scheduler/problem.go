// Package scheduler builds minimum-cost shift schedules for small teams.
//
// A problem assigns exactly two qualified people to every time slot.
// Adjacent slots must share at least one person, and no person may work
// more than MaxConsec consecutive slots. The solver minimizes total
// preference cost, breaking ties by the lexicographically smallest
// sequence of person pairs.
package scheduler

import "fmt"

const (
	// MaxPeople is the largest supported team size.
	MaxPeople = 10
	// MaxSlots is the largest supported number of time slots.
	MaxSlots = 12
	// MaxConsec is the maximum number of consecutive slots one person
	// may work.
	MaxConsec = 3
)

// Pair identifies the two people working one slot, with Pair[0] < Pair[1].
type Pair [2]int

// Schedule holds one pair per slot.
type Schedule []Pair

// Problem describes a single scheduling instance.
type Problem struct {
	NumPeople int
	NumSlots  int
	// Qualified[p][s] reports whether person p may work slot s.
	Qualified [][]bool
	// Cost[p][s] is the preference cost of assigning person p to slot s.
	Cost [][]int
}

// Validate reports whether the problem is well formed and within the
// supported size limits.
func (p Problem) Validate() error {
	if p.NumPeople < 2 || p.NumPeople > MaxPeople {
		return fmt.Errorf("scheduler: NumPeople %d out of range [2, %d]", p.NumPeople, MaxPeople)
	}
	if p.NumSlots < 1 || p.NumSlots > MaxSlots {
		return fmt.Errorf("scheduler: NumSlots %d out of range [1, %d]", p.NumSlots, MaxSlots)
	}
	if len(p.Qualified) != p.NumPeople {
		return fmt.Errorf("scheduler: Qualified has %d rows, want %d", len(p.Qualified), p.NumPeople)
	}
	if len(p.Cost) != p.NumPeople {
		return fmt.Errorf("scheduler: Cost has %d rows, want %d", len(p.Cost), p.NumPeople)
	}
	for person := 0; person < p.NumPeople; person++ {
		if len(p.Qualified[person]) != p.NumSlots {
			return fmt.Errorf("scheduler: Qualified[%d] has %d columns, want %d", person, len(p.Qualified[person]), p.NumSlots)
		}
		if len(p.Cost[person]) != p.NumSlots {
			return fmt.Errorf("scheduler: Cost[%d] has %d columns, want %d", person, len(p.Cost[person]), p.NumSlots)
		}
	}
	return nil
}

// TotalCost sums the preference costs of a schedule. It assumes the
// schedule is valid for the problem.
func TotalCost(p Problem, s Schedule) int {
	total := 0
	for slot, pr := range s {
		total += p.Cost[pr[0]][slot] + p.Cost[pr[1]][slot]
	}
	return total
}

// pairLess orders pairs lexicographically.
func pairLess(a, b Pair) bool {
	if a[0] != b[0] {
		return a[0] < b[0]
	}
	return a[1] < b[1]
}

// lexLess orders equal-length schedules lexicographically by pair.
func lexLess(a, b Schedule) bool {
	for i := range a {
		if a[i] != b[i] {
			return pairLess(a[i], b[i])
		}
	}
	return false
}

// sharesPerson reports whether two pairs have at least one common member.
func sharesPerson(a, b Pair) bool {
	return a[0] == b[0] || a[0] == b[1] || a[1] == b[0] || a[1] == b[1]
}

// contains reports whether person is a member of pr.
func contains(pr Pair, person int) bool {
	return pr[0] == person || pr[1] == person
}
