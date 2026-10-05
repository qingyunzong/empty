// Package sched solves single-executor scheduling of unit-duration tasks
// with release times, deadlines and profits, for up to MaxTasks tasks.
//
// A task scheduled in integer slot t occupies [t, t+1) and must satisfy
// Release <= t && t+1 <= Deadline. The objective is to select a feasible
// subset of maximum total profit; ties are broken by choosing the
// lexicographically smallest execution sequence of task IDs.
package sched

import (
	"fmt"
	"sort"
)

// MaxTasks is the largest instance size Solve accepts (2^18 subsets).
const MaxTasks = 18

// Task is a unit-duration job with a release time, a deadline and a profit.
type Task struct {
	ID       int
	Release  int
	Deadline int
	Profit   int64
}

// Solution is the optimal schedule plus its time certificate data.
type Solution struct {
	Profit int64        // total profit of the selected subset
	Order  []int        // task IDs in execution order (by slot)
	Slots  map[int]int  // task ID -> start slot
	Tasks  map[int]Task // task ID -> task, for certificate checks
}

// feasible reports whether all given tasks can be scheduled, one per
// integer slot t with Release <= t < Deadline. The greedy processes jobs
// by increasing deadline and places each at the earliest free slot >= its
// release; this computes a maximum matching in the convex bipartite
// job/slot graph, so it schedules every job iff the set is feasible.
func feasible(tasks []Task) bool {
	ord := make([]Task, len(tasks))
	copy(ord, tasks)
	sort.Slice(ord, func(i, j int) bool {
		if ord[i].Deadline != ord[j].Deadline {
			return ord[i].Deadline < ord[j].Deadline
		}
		return ord[i].ID < ord[j].ID
	})
	used := make([]int, 0, len(ord)) // occupied slots, sorted ascending
	for _, task := range ord {
		t := task.Release
		i := sort.SearchInts(used, t)
		for i < len(used) && used[i] == t {
			t++
			i++
		}
		if t >= task.Deadline {
			return false
		}
		used = append(used, 0)
		copy(used[i+1:], used[i:])
		used[i] = t
	}
	return true
}

// subset returns the tasks selected by mask.
func subset(tasks []Task, mask uint32) []Task {
	sub := make([]Task, 0, 8)
	for i, task := range tasks {
		if mask&(1<<uint(i)) != 0 {
			sub = append(sub, task)
		}
	}
	return sub
}

// bestMasks enumerates all 2^n subsets and returns the maximum profit
// among feasible subsets together with every mask attaining it.
func bestMasks(tasks []Task) (int64, []uint32) {
	n := len(tasks)
	total := 1 << uint(n)
	profit := make([]int64, total)
	for mask := 1; mask < total; mask++ {
		lsb := mask & (-mask)
		i := 0
		for lsb>>uint(i) != 1 {
			i++
		}
		profit[mask] = profit[mask^lsb] + tasks[i].Profit
	}
	best := int64(0) // the empty subset is always feasible
	var masks []uint32
	for mask := 0; mask < total; mask++ {
		if profit[mask] < best {
			continue
		}
		if !feasible(subset(tasks, uint32(mask))) {
			continue
		}
		if profit[mask] > best {
			best = profit[mask]
			masks = masks[:0]
		}
		masks = append(masks, uint32(mask))
	}
	return best, masks
}

// lessSeq reports whether ID sequence a is lexicographically smaller
// than b (a proper prefix counts as smaller).
func lessSeq(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// lexMinSequence returns the lexicographically smallest execution
// sequence among all feasible schedules of a feasible task set.
//
// Greedy prefix construction: the next element is the smallest task ID
// that can be scheduled earliest among the remaining tasks. A candidate
// c can be earliest iff, placing it at its earliest legal slot
// t = max(Release_c, minSlot), the rest stays feasible with all slots
// forced above t; feasibility is monotone in t, so the smallest t
// suffices.
func lexMinSequence(tasks []Task) []int {
	remaining := make([]Task, len(tasks))
	copy(remaining, tasks)
	sort.Slice(remaining, func(i, j int) bool { return remaining[i].ID < remaining[j].ID })

	seq := make([]int, 0, len(tasks))
	minSlot := -1 << 60
	for len(remaining) > 0 {
		chosen := -1
		chosenSlot := 0
		for i, c := range remaining {
			t := c.Release
			if t < minSlot {
				t = minSlot
			}
			if t >= c.Deadline {
				continue
			}
			rest := make([]Task, 0, len(remaining)-1)
			for j, o := range remaining {
				if j == i {
					continue
				}
				if o.Release < t+1 {
					o.Release = t + 1
				}
				rest = append(rest, o)
			}
			if feasible(rest) {
				chosen = i
				chosenSlot = t
				break
			}
		}
		if chosen < 0 {
			panic("lexMinSequence: infeasible task set")
		}
		seq = append(seq, remaining[chosen].ID)
		minSlot = chosenSlot + 1
		remaining = append(remaining[:chosen], remaining[chosen+1:]...)
	}
	return seq
}

// assignSlots places the tasks of order (a feasible execution sequence)
// at their earliest legal slots, yielding the time certificate.
func assignSlots(byID map[int]Task, order []int) map[int]int {
	slots := make(map[int]int, len(order))
	prev := -1 << 60
	for _, id := range order {
		t := byID[id].Release
		if t <= prev {
			t = prev + 1
		}
		slots[id] = t
		prev = t
	}
	return slots
}

// Solve returns the maximum-profit feasible schedule, breaking ties by
// the lexicographically smallest execution sequence of task IDs.
func Solve(tasks []Task) (Solution, error) {
	if len(tasks) > MaxTasks {
		return Solution{}, fmt.Errorf("too many tasks: %d > %d", len(tasks), MaxTasks)
	}
	byID := make(map[int]Task, len(tasks))
	for _, task := range tasks {
		if _, dup := byID[task.ID]; dup {
			return Solution{}, fmt.Errorf("duplicate task ID %d", task.ID)
		}
		byID[task.ID] = task
	}
	best, masks := bestMasks(tasks)
	var order []int
	for _, mask := range masks {
		seq := lexMinSequence(subset(tasks, mask))
		if order == nil || lessSeq(seq, order) {
			order = seq
		}
	}
	return Solution{
		Profit: best,
		Order:  order,
		Slots:  assignSlots(byID, order),
		Tasks:  byID,
	}, nil
}

// Verify checks the time certificate: distinct slots, each within
// [Release, Deadline), execution order consistent with slots, and total
// profit matching the solution.
func (s Solution) Verify() error {
	seen := make(map[int]int, len(s.Slots)) // slot -> task ID
	var total int64
	for _, id := range s.Order {
		task, ok := s.Tasks[id]
		if !ok {
			return fmt.Errorf("unknown task %d", id)
		}
		t, ok := s.Slots[id]
		if !ok {
			return fmt.Errorf("task %d has no slot", id)
		}
		if t < task.Release || t >= task.Deadline {
			return fmt.Errorf("task %d at slot %d outside [%d, %d)", id, t, task.Release, task.Deadline)
		}
		if other, clash := seen[t]; clash {
			return fmt.Errorf("slot %d shared by tasks %d and %d", t, other, id)
		}
		seen[t] = id
		total += task.Profit
	}
	if total != s.Profit {
		return fmt.Errorf("profit mismatch: certificate sums to %d, want %d", total, s.Profit)
	}
	for i := 1; i < len(s.Order); i++ {
		if s.Slots[s.Order[i-1]] >= s.Slots[s.Order[i]] {
			return fmt.Errorf("execution order inconsistent with slots at position %d", i)
		}
	}
	return nil
}
