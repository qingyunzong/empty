package sched

// BruteForce enumerates every permutation of every subset of tasks and
// returns the maximum-profit feasible execution sequence, breaking ties
// by lexicographic order. It is exponential and intended only as a
// cross-check oracle for small instances.
func BruteForce(tasks []Task) Solution {
	byID := make(map[int]Task, len(tasks))
	for _, task := range tasks {
		byID[task.ID] = task
	}
	best := Solution{Profit: 0, Order: []int{}, Tasks: byID}
	perm := make([]int, 0, len(tasks))
	used := make([]bool, len(tasks))
	var dfs func()
	dfs = func() {
		if profit, ok := evalOrder(tasks, perm); ok {
			if profit > best.Profit ||
				(profit == best.Profit && lessSeq(perm, best.Order)) {
				best.Profit = profit
				best.Order = append([]int(nil), perm...)
			}
		}
		if len(perm) == len(tasks) {
			return
		}
		for i := range tasks {
			if used[i] {
				continue
			}
			used[i] = true
			perm = append(perm, tasks[i].ID)
			dfs()
			perm = perm[:len(perm)-1]
			used[i] = false
		}
	}
	dfs()
	best.Slots = assignSlots(byID, best.Order)
	return best
}

// evalOrder greedily places the given execution sequence at the earliest
// legal slots and reports its total profit and feasibility.
func evalOrder(tasks []Task, order []int) (int64, bool) {
	byID := make(map[int]Task, len(tasks))
	for _, task := range tasks {
		byID[task.ID] = task
	}
	var profit int64
	prev := -1 << 60
	for _, id := range order {
		task := byID[id]
		t := task.Release
		if t <= prev {
			t = prev + 1
		}
		if t >= task.Deadline {
			return 0, false
		}
		prev = t
		profit += task.Profit
	}
	return profit, true
}
