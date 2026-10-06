// Package placement assigns tasks to machines at minimum cost.
//
// The library handles up to MaxTasks tasks and MaxMachines machines with two
// resources (CPU and memory), per-task machine affinity, and pairwise
// anti-colocation constraints. The cost of a plan is the sum of startup
// costs of every machine that hosts at least one task plus the migration
// cost of every task placed on a machine different from its machine in the
// old plan. Among all minimum-cost plans the lexicographically smallest
// assignment sequence is returned (tasks ordered by ID, machines ordered as
// given in the request). If no feasible plan exists, the old plan is kept
// and a certificate explaining the infeasibility is produced.
package placement

import (
	"errors"
	"fmt"
	"sort"
)

const (
	// MaxTasks is the maximum number of tasks the solver accepts.
	MaxTasks = 18
	// MaxMachines is the maximum number of machines the solver accepts.
	MaxMachines = 4
)

// Task is a unit of work to place on exactly one machine.
type Task struct {
	ID  string
	CPU int64
	Mem int64
	// Allowed lists, per machine index, whether the task may run on that
	// machine. A nil slice means every machine is allowed.
	Allowed []bool
	// AntiWith lists IDs of tasks that must not share a machine with this
	// task. The relation is treated as symmetric.
	AntiWith []string
	// MigrationCost is charged when the task is placed on a machine
	// different from its machine in the old plan. Tasks absent from the old
	// plan never incur migration cost.
	MigrationCost int64
}

// Machine is a host with CPU and memory capacities.
type Machine struct {
	ID  string
	CPU int64
	Mem int64
	// StartupCost is charged when at least one task runs on the machine.
	StartupCost int64
}

// Request describes a placement problem.
type Request struct {
	Tasks    []Task
	Machines []Machine
	// Old maps task ID to the machine ID it currently runs on. It is the
	// previous plan: migration costs are measured against it, and it is
	// kept unchanged when no feasible new plan exists.
	Old map[string]string
}

// MachineUsage certifies the load of one machine in a returned plan.
type MachineUsage struct {
	MachineID string
	Tasks     []string
	CPUUsed   int64
	CPUCap    int64
	MemUsed   int64
	MemCap    int64
}

// Certificate is the verifiable evidence attached to a Result. For a
// feasible result it carries the per-machine capacity usage of the returned
// plan. For an infeasible result it carries the reason (over-demand against
// capacity, an empty affinity set, an anti-colocation clique larger than
// the machines available to it, or exhaustive search) together with the
// number of search nodes explored.
type Certificate struct {
	Feasible      bool
	KeptOld       bool
	Usage         []MachineUsage
	TotalCPU      int64
	TotalCPUCap   int64
	TotalMem      int64
	TotalMemCap   int64
	Reason        string
	Clique        []string
	NodesExplored int64
}

// Result is the outcome of Solve.
type Result struct {
	// Feasible reports whether a feasible plan exists.
	Feasible bool
	// Plan maps task ID to machine ID. When the request is infeasible the
	// old plan is kept unchanged.
	Plan map[string]string
	// Cost is the total cost (startup + migration) of Plan.
	Cost int64
	Cert Certificate
}

// Validate checks structural limits and references of a request.
func Validate(req Request) error {
	if len(req.Tasks) == 0 {
		return errors.New("placement: no tasks")
	}
	if len(req.Tasks) > MaxTasks {
		return fmt.Errorf("placement: %d tasks exceed the limit of %d", len(req.Tasks), MaxTasks)
	}
	if len(req.Machines) == 0 {
		return errors.New("placement: no machines")
	}
	if len(req.Machines) > MaxMachines {
		return fmt.Errorf("placement: %d machines exceed the limit of %d", len(req.Machines), MaxMachines)
	}
	machineIdx := make(map[string]int, len(req.Machines))
	for i, m := range req.Machines {
		if m.ID == "" {
			return fmt.Errorf("placement: machine %d has empty ID", i)
		}
		if _, dup := machineIdx[m.ID]; dup {
			return fmt.Errorf("placement: duplicate machine ID %q", m.ID)
		}
		if m.CPU < 0 || m.Mem < 0 {
			return fmt.Errorf("placement: machine %q has negative capacity", m.ID)
		}
		machineIdx[m.ID] = i
	}
	taskIdx := make(map[string]int, len(req.Tasks))
	for i, t := range req.Tasks {
		if t.ID == "" {
			return fmt.Errorf("placement: task %d has empty ID", i)
		}
		if _, dup := taskIdx[t.ID]; dup {
			return fmt.Errorf("placement: duplicate task ID %q", t.ID)
		}
		if t.CPU < 0 || t.Mem < 0 {
			return fmt.Errorf("placement: task %q has negative demand", t.ID)
		}
		if len(t.Allowed) != 0 && len(t.Allowed) != len(req.Machines) {
			return fmt.Errorf("placement: task %q Allowed has %d entries, want %d", t.ID, len(t.Allowed), len(req.Machines))
		}
		taskIdx[t.ID] = i
	}
	for _, t := range req.Tasks {
		for _, other := range t.AntiWith {
			if other == t.ID {
				return fmt.Errorf("placement: task %q is anti-colocated with itself", t.ID)
			}
			if _, ok := taskIdx[other]; !ok {
				return fmt.Errorf("placement: task %q references unknown task %q in AntiWith", t.ID, other)
			}
		}
	}
	for id, mid := range req.Old {
		if _, ok := taskIdx[id]; !ok {
			return fmt.Errorf("placement: old plan references unknown task %q", id)
		}
		if _, ok := machineIdx[mid]; !ok {
			return fmt.Errorf("placement: old plan references unknown machine %q", mid)
		}
	}
	return nil
}

// Solve computes the minimum-cost feasible plan. On ties it returns the
// lexicographically smallest assignment sequence (tasks ordered by ID,
// machines ordered as in req.Machines). When no feasible plan exists the
// old plan is kept and the certificate explains why.
func Solve(req Request) (Result, error) {
	if err := Validate(req); err != nil {
		return Result{}, err
	}
	s := newSolver(req)
	if reason, clique, certain := precheckInfeasible(req); certain {
		res := s.infeasibleResult()
		res.Cert = buildCertificate(req, res, 0)
		res.Cert.Reason = reason
		res.Cert.Clique = clique
		return res, nil
	}
	res := s.solve()
	res.Cert = buildCertificate(req, res, s.nodes)
	return res, nil
}

// Check verifies that plan is feasible for req and returns its cost. It is
// the verifier accompanying the certificate: any plan can be re-checked
// against capacities, affinity and anti-colocation constraints.
func Check(req Request, plan map[string]string) (int64, error) {
	if err := Validate(req); err != nil {
		return 0, err
	}
	machineIdx := make(map[string]int, len(req.Machines))
	for i, m := range req.Machines {
		machineIdx[m.ID] = i
	}
	tasks := sortedTasks(req.Tasks)
	assign := make([]int, len(tasks))
	for i, t := range tasks {
		mid, ok := plan[t.ID]
		if !ok {
			return 0, fmt.Errorf("placement: plan does not place task %q", t.ID)
		}
		m, ok := machineIdx[mid]
		if !ok {
			return 0, fmt.Errorf("placement: plan places task %q on unknown machine %q", t.ID, mid)
		}
		if len(t.Allowed) != 0 && !t.Allowed[m] {
			return 0, fmt.Errorf("placement: task %q is not allowed on machine %q", t.ID, mid)
		}
		assign[i] = m
	}
	if len(plan) != len(tasks) {
		return 0, errors.New("placement: plan places unknown or duplicate tasks")
	}
	// Anti-colocation (symmetric).
	anti := antiMatrix(req, tasks)
	for i := range tasks {
		for j := i + 1; j < len(tasks); j++ {
			if anti[i][j] && assign[i] == assign[j] {
				return 0, fmt.Errorf("placement: tasks %q and %q share a machine", tasks[i].ID, tasks[j].ID)
			}
		}
	}
	// Capacity.
	cpuUsed := make([]int64, len(req.Machines))
	memUsed := make([]int64, len(req.Machines))
	for i, t := range tasks {
		m := assign[i]
		cpuUsed[m] += t.CPU
		memUsed[m] += t.Mem
	}
	for i, m := range req.Machines {
		if cpuUsed[i] > m.CPU {
			return 0, fmt.Errorf("placement: machine %q CPU over capacity: %d > %d", m.ID, cpuUsed[i], m.CPU)
		}
		if memUsed[i] > m.Mem {
			return 0, fmt.Errorf("placement: machine %q memory over capacity: %d > %d", m.ID, memUsed[i], m.Mem)
		}
	}
	return planCost(req, tasks, assign), nil
}

// sortedTasks returns the tasks sorted by ID, the canonical order used for
// the lexicographic tie-break.
func sortedTasks(tasks []Task) []Task {
	out := make([]Task, len(tasks))
	copy(out, tasks)
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// antiMatrix builds the symmetrized anti-colocation relation over the
// sorted task order.
func antiMatrix(req Request, tasks []Task) [][]bool {
	idx := make(map[string]int, len(tasks))
	for i, t := range tasks {
		idx[t.ID] = i
	}
	anti := make([][]bool, len(tasks))
	for i := range anti {
		anti[i] = make([]bool, len(tasks))
	}
	for i, t := range tasks {
		for _, other := range t.AntiWith {
			j := idx[other]
			anti[i][j] = true
			anti[j][i] = true
		}
	}
	return anti
}

// planCost computes startup + migration cost of an assignment over the
// sorted task order.
func planCost(req Request, tasks []Task, assign []int) int64 {
	used := make([]bool, len(req.Machines))
	var cost int64
	for i, t := range tasks {
		m := assign[i]
		if !used[m] {
			used[m] = true
			cost += req.Machines[m].StartupCost
		}
		if old, ok := req.Old[t.ID]; ok && old != req.Machines[m].ID {
			cost += t.MigrationCost
		}
	}
	return cost
}
