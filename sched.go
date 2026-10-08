// Package sched solves small workforce scheduling problems: assign pairs of
// qualified people to time slots minimizing preference cost.
package sched

import (
	"fmt"
	"sort"
)

const (
	// MaxPeople is the maximum supported number of people.
	MaxPeople = 10
	// MaxSlots is the maximum supported number of time slots.
	MaxSlots = 12
	// MaxRun is the maximum number of consecutive slots one person may work.
	MaxRun = 3
)

// Pair is an unordered pair of distinct people, stored with A < B.
type Pair struct {
	A, B int
}

// NewPair builds a normalized Pair (smaller index first).
func NewPair(a, b int) Pair {
	if a > b {
		a, b = b, a
	}
	return Pair{A: a, B: b}
}

// shares reports whether p and q have at least one member in common.
func (p Pair) shares(q Pair) bool {
	return p.A == q.A || p.A == q.B || p.B == q.A || p.B == q.B
}

// less orders pairs lexicographically by (A, B).
func (p Pair) less(q Pair) bool {
	if p.A != q.A {
		return p.A < q.A
	}
	return p.B < q.B
}

// Instance describes one scheduling problem.
type Instance struct {
	NumPeople int      // number of people, 0..MaxPeople
	NumSlots  int      // number of time slots, 0..MaxSlots
	Allowed   [][]Pair // Allowed[s] lists the qualified pairs for slot s
	Cost      [][]int  // Cost[p][s] is the preference cost of person p in slot s; nil means zero
}

// Schedule assigns one pair per slot.
type Schedule []Pair

// Validate checks that the instance itself is well formed.
func (inst Instance) Validate() error {
	if inst.NumPeople < 0 || inst.NumPeople > MaxPeople {
		return fmt.Errorf("NumPeople %d out of range [0,%d]", inst.NumPeople, MaxPeople)
	}
	if inst.NumSlots < 0 || inst.NumSlots > MaxSlots {
		return fmt.Errorf("NumSlots %d out of range [0,%d]", inst.NumSlots, MaxSlots)
	}
	if len(inst.Allowed) != inst.NumSlots {
		return fmt.Errorf("Allowed has %d slots, want %d", len(inst.Allowed), inst.NumSlots)
	}
	for s, pairs := range inst.Allowed {
		for _, p := range pairs {
			if p.A < 0 || p.A >= p.B || p.B >= inst.NumPeople {
				return fmt.Errorf("slot %d: invalid pair (%d,%d)", s, p.A, p.B)
			}
		}
	}
	if inst.Cost != nil {
		if len(inst.Cost) != inst.NumPeople {
			return fmt.Errorf("Cost has %d people, want %d", len(inst.Cost), inst.NumPeople)
		}
		for p, row := range inst.Cost {
			if len(row) != inst.NumSlots {
				return fmt.Errorf("Cost[%d] has %d slots, want %d", p, len(row), inst.NumSlots)
			}
		}
	}
	return nil
}

// Check verifies that s satisfies every hard constraint of inst:
// exactly one qualified pair per slot, adjacent slots share at least one
// person, and nobody works more than MaxRun consecutive slots.
func (inst Instance) Check(s Schedule) error {
	if err := inst.Validate(); err != nil {
		return err
	}
	if len(s) != inst.NumSlots {
		return fmt.Errorf("schedule has %d slots, want %d", len(s), inst.NumSlots)
	}
	qualified := make([]map[Pair]bool, inst.NumSlots)
	for i, pairs := range inst.Allowed {
		qualified[i] = make(map[Pair]bool, len(pairs))
		for _, p := range pairs {
			qualified[i][p] = true
		}
	}
	runs := make([]int, inst.NumPeople)
	for i, p := range s {
		if p.A < 0 || p.A >= p.B || p.B >= inst.NumPeople {
			return fmt.Errorf("slot %d: invalid pair (%d,%d)", i, p.A, p.B)
		}
		if !qualified[i][p] {
			return fmt.Errorf("slot %d: pair (%d,%d) is not qualified", i, p.A, p.B)
		}
		if i > 0 && !s[i-1].shares(p) {
			return fmt.Errorf("slot %d: pair (%d,%d) shares nobody with previous pair (%d,%d)",
				i, p.A, p.B, s[i-1].A, s[i-1].B)
		}
		for m := 0; m < inst.NumPeople; m++ {
			if m == p.A || m == p.B {
				runs[m]++
				if runs[m] > MaxRun {
					return fmt.Errorf("slot %d: person %d works more than %d consecutive slots", i, m, MaxRun)
				}
			} else {
				runs[m] = 0
			}
		}
	}
	return nil
}

// TotalCost returns the summed preference cost of a schedule.
func (inst Instance) TotalCost(s Schedule) int {
	total := 0
	for i, p := range s {
		total += inst.costAt(p.A, i) + inst.costAt(p.B, i)
	}
	return total
}

func (inst Instance) costAt(person, slot int) int {
	if inst.Cost == nil {
		return 0
	}
	return inst.Cost[person][slot]
}

// Solve finds a feasible schedule minimizing total preference cost, breaking
// ties by the lexicographically smallest sequence of pairs. It returns
// ok=false when no feasible schedule exists.
func (inst Instance) Solve() (sched Schedule, ok bool) {
	if err := inst.Validate(); err != nil {
		return nil, false
	}
	if inst.NumSlots == 0 {
		return Schedule{}, true
	}

	allowed := make([][]Pair, inst.NumSlots)
	for i, pairs := range inst.Allowed {
		sorted := append([]Pair(nil), pairs...)
		sort.Slice(sorted, func(a, b int) bool { return sorted[a].less(sorted[b]) })
		dedup := sorted[:0]
		for _, p := range sorted {
			if len(dedup) == 0 || dedup[len(dedup)-1] != p {
				dedup = append(dedup, p)
			}
		}
		allowed[i] = dedup
	}

	// runs packs each person's consecutive-slot count in 2 bits. Invariant:
	// only members of the previous pair may have a nonzero count.
	getRun := func(runs uint32, person int) int {
		return int(runs>>(2*person)) & 3
	}
	setRun := func(runs uint32, person, v int) uint32 {
		runs &^= 3 << (2 * person)
		return runs | uint32(v)<<(2*person)
	}

	type key struct {
		slot int
		prev Pair
		runs uint32
	}
	type entry struct {
		cost int
		seq  Schedule
		ok   bool
	}
	memo := make(map[key]entry)

	var rec func(slot int, prev Pair, runs uint32) (int, Schedule, bool)
	rec = func(slot int, prev Pair, runs uint32) (int, Schedule, bool) {
		if slot == inst.NumSlots {
			return 0, nil, true
		}
		k := key{slot, prev, runs}
		if e, hit := memo[k]; hit {
			return e.cost, e.seq, e.ok
		}
		bestCost := 0
		var bestSeq Schedule
		found := false
		for _, p := range allowed[slot] {
			if slot > 0 && !prev.shares(p) {
				continue
			}
			runA, runB := getRun(runs, p.A), getRun(runs, p.B)
			if runA >= MaxRun || runB >= MaxRun {
				continue
			}
			next := setRun(setRun(0, p.A, runA+1), p.B, runB+1)
			subCost, subSeq, ok := rec(slot+1, p, next)
			if !ok {
				continue
			}
			cost := inst.costAt(p.A, slot) + inst.costAt(p.B, slot) + subCost
			seq := append(Schedule{p}, subSeq...)
			if !found || cost < bestCost || (cost == bestCost && seqLess(seq, bestSeq)) {
				found, bestCost, bestSeq = true, cost, seq
			}
		}
		memo[k] = entry{bestCost, bestSeq, found}
		return bestCost, bestSeq, found
	}

	_, seq, ok := rec(0, Pair{}, 0)
	if !ok {
		return nil, false
	}
	return seq, true
}

// seqLess compares two schedules lexicographically pair by pair.
func seqLess(a, b Schedule) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i].less(b[i])
		}
	}
	return len(a) < len(b)
}

// AllPairs returns every pair (a,b) with 0 <= a < b < n, in lexicographic
// order. It is a convenience for building fully qualified Allowed lists.
func AllPairs(n int) []Pair {
	if n < 0 || n > MaxPeople {
		return nil
	}
	pairs := make([]Pair, 0, n*(n-1)/2)
	for a := 0; a < n; a++ {
		for b := a + 1; b < n; b++ {
			pairs = append(pairs, Pair{A: a, B: b})
		}
	}
	return pairs
}
