package placement

// solver is a two-phase branch-and-bound over the assignment tree.
//
// Phase 1 finds the optimal cost C*: depth-first search in lexicographic
// order, pruning every subtree whose admissible lower bound is not cheaper
// than the incumbent. Phase 2 re-runs the search pruning only subtrees
// whose bound is strictly above C*, so the first complete plan reached in
// lexicographic order is the lexicographically smallest optimal plan.
type solver struct {
	tasks    []Task // sorted by ID
	machines []Machine
	oldIdx   []int // old machine index per task, -1 if new

	allowed   []uint32 // per task bitmask over machines
	anti      []uint32 // per task bitmask over tasks (symmetric)
	moveCost  [][]int64
	suffixLB  []int64 // suffix sums of per-task minimum migration cost
	suffixCPU []int64 // suffix sums of CPU demand
	suffixMem []int64 // suffix sums of memory demand

	nodes int64

	// search state
	assign     []int
	cpuUsed    []int64
	memUsed    []int64
	totUsedCPU int64
	totUsedMem int64
	taskMask   []uint32 // per machine bitmask of tasks on it
	usedMask   uint32
	curCost    int64
	totCapCPU  int64
	totCapMem  int64
}

func newSolver(req Request) *solver {
	tasks := sortedTasks(req.Tasks)
	n := len(tasks)
	m := len(req.Machines)
	machineIdx := make(map[string]int, m)
	for i, mc := range req.Machines {
		machineIdx[mc.ID] = i
	}
	s := &solver{
		tasks:    tasks,
		machines: req.Machines,
		oldIdx:   make([]int, n),
		allowed:  make([]uint32, n),
		anti:     make([]uint32, n),
		moveCost: make([][]int64, n),
		suffixLB: make([]int64, n+1),
		assign:   make([]int, n),
		cpuUsed:  make([]int64, m),
		memUsed:  make([]int64, m),
		taskMask: make([]uint32, m),
	}
	for i, t := range tasks {
		s.oldIdx[i] = -1
		if old, ok := req.Old[t.ID]; ok {
			s.oldIdx[i] = machineIdx[old]
		}
		var mask uint32
		for j := 0; j < m; j++ {
			if len(t.Allowed) == 0 || t.Allowed[j] {
				mask |= 1 << uint(j)
			}
		}
		s.allowed[i] = mask
		s.moveCost[i] = make([]int64, m)
		for j := 0; j < m; j++ {
			if s.oldIdx[i] >= 0 && s.oldIdx[i] != j {
				s.moveCost[i][j] = t.MigrationCost
			}
		}
	}
	anti := antiMatrix(req, tasks)
	for i := range anti {
		for j := range anti[i] {
			if anti[i][j] {
				s.anti[i] |= 1 << uint(j)
			}
		}
	}
	for i := n - 1; i >= 0; i-- {
		best := int64(-1)
		for j := 0; j < m; j++ {
			if s.allowed[i]&(1<<uint(j)) == 0 {
				continue
			}
			if c := s.moveCost[i][j]; best < 0 || c < best {
				best = c
			}
		}
		if best < 0 {
			best = 0
		}
		s.suffixLB[i] = s.suffixLB[i+1] + best
	}
	s.suffixCPU = make([]int64, n+1)
	s.suffixMem = make([]int64, n+1)
	for i := n - 1; i >= 0; i-- {
		s.suffixCPU[i] = s.suffixCPU[i+1] + tasks[i].CPU
		s.suffixMem[i] = s.suffixMem[i+1] + tasks[i].Mem
	}
	for _, mc := range req.Machines {
		s.totCapCPU += mc.CPU
		s.totCapMem += mc.Mem
	}
	return s
}

// solve runs both phases and returns the final result.
func (s *solver) solve() Result {
	bestCost, found := s.phase1()
	if !found {
		return s.infeasibleResult()
	}
	assign := s.phase2(bestCost)
	plan := make(map[string]string, len(s.tasks))
	for i, t := range s.tasks {
		plan[t.ID] = s.machines[assign[i]].ID
	}
	return Result{Feasible: true, Plan: plan, Cost: bestCost}
}

// infeasibleResult keeps the old plan. Keeping it costs only the startup
// of the machines it uses; nothing migrates.
func (s *solver) infeasibleResult() Result {
	old := make(map[string]string, len(s.tasks))
	for i, t := range s.tasks {
		if s.oldIdx[i] >= 0 {
			old[t.ID] = s.machines[s.oldIdx[i]].ID
		}
	}
	var cost int64
	seen := make(map[int]bool)
	for _, j := range s.oldIdx {
		if j >= 0 && !seen[j] {
			seen[j] = true
			cost += s.machines[j].StartupCost
		}
	}
	return Result{Feasible: false, Plan: old, Cost: cost}
}

// bound is the admissible lower bound for the current partial assignment
// once task `next` is the first unassigned one.
func (s *solver) bound(next int) int64 {
	return s.curCost + s.suffixLB[next]
}

// capacityOK is a necessary aggregate-capacity check for the remaining
// tasks: if their total demand exceeds the total remaining capacity the
// subtree cannot contain a feasible plan.
func (s *solver) capacityOK(next int) bool {
	return s.suffixCPU[next] <= s.totCapCPU-s.totUsedCPU &&
		s.suffixMem[next] <= s.totCapMem-s.totUsedMem
}

// feasible reports whether task i can be placed on machine j.
func (s *solver) feasible(i, j int) bool {
	if s.allowed[i]&(1<<uint(j)) == 0 {
		return false
	}
	t := s.tasks[i]
	if s.cpuUsed[j]+t.CPU > s.machines[j].CPU || s.memUsed[j]+t.Mem > s.machines[j].Mem {
		return false
	}
	return s.taskMask[j]&s.anti[i] == 0
}

// place/unplace update the incremental search state.
func (s *solver) place(i, j int) {
	t := s.tasks[i]
	s.assign[i] = j
	s.cpuUsed[j] += t.CPU
	s.memUsed[j] += t.Mem
	s.totUsedCPU += t.CPU
	s.totUsedMem += t.Mem
	s.taskMask[j] |= 1 << uint(i)
	if s.usedMask&(1<<uint(j)) == 0 {
		s.usedMask |= 1 << uint(j)
		s.curCost += s.machines[j].StartupCost
	}
	s.curCost += s.moveCost[i][j]
}

func (s *solver) unplace(i, j int) {
	t := s.tasks[i]
	s.curCost -= s.moveCost[i][j]
	s.cpuUsed[j] -= t.CPU
	s.memUsed[j] -= t.Mem
	s.totUsedCPU -= t.CPU
	s.totUsedMem -= t.Mem
	s.taskMask[j] &^= 1 << uint(i)
	if s.taskMask[j] == 0 {
		s.usedMask &^= 1 << uint(j)
		s.curCost -= s.machines[j].StartupCost
	}
}

// phase1 returns the optimal cost. The greedy stay-put plan seeds the
// incumbent so branches that cannot beat it are pruned early.
func (s *solver) phase1() (int64, bool) {
	best := int64(-1) // -1 means no incumbent yet
	if cost, ok := s.greedyStayPut(); ok {
		best = cost
	}
	var dfs func(i int)
	dfs = func(i int) {
		s.nodes++
		if best >= 0 && s.bound(i) >= best {
			return
		}
		if !s.capacityOK(i) {
			return
		}
		if i == len(s.tasks) {
			if best < 0 || s.curCost < best {
				best = s.curCost
			}
			return
		}
		for j := 0; j < len(s.machines); j++ {
			if !s.feasible(i, j) {
				continue
			}
			s.place(i, j)
			dfs(i + 1)
			s.unplace(i, j)
		}
	}
	dfs(0)
	return best, best >= 0
}

// phase2 returns the lexicographically smallest assignment with cost equal
// to the optimal cost found in phase 1.
func (s *solver) phase2(optimal int64) []int {
	out := make([]int, len(s.tasks))
	found := false
	var dfs func(i int)
	dfs = func(i int) {
		if found {
			return
		}
		s.nodes++
		if s.bound(i) > optimal {
			return
		}
		if !s.capacityOK(i) {
			return
		}
		if i == len(s.tasks) {
			if s.curCost <= optimal {
				copy(out, s.assign)
				found = true
			}
			return
		}
		for j := 0; j < len(s.machines); j++ {
			if !s.feasible(i, j) {
				continue
			}
			s.place(i, j)
			dfs(i + 1)
			s.unplace(i, j)
			if found {
				return
			}
		}
	}
	dfs(0)
	return out
}

// greedyStayPut returns the cost of the old plan if it is still feasible.
func (s *solver) greedyStayPut() (int64, bool) {
	for i := range s.tasks {
		j := s.oldIdx[i]
		if j < 0 {
			// New task: put it on the first feasible machine.
			j = -1
			for k := 0; k < len(s.machines); k++ {
				if s.feasible(i, k) {
					j = k
					break
				}
			}
			if j < 0 {
				s.rollback(i)
				return 0, false
			}
		} else if !s.feasible(i, j) {
			s.rollback(i)
			return 0, false
		}
		s.place(i, j)
	}
	cost := s.curCost
	s.rollback(len(s.tasks))
	return cost, true
}

// rollback unplaces tasks [0, i).
func (s *solver) rollback(i int) {
	for k := i - 1; k >= 0; k-- {
		s.unplace(k, s.assign[k])
	}
}
