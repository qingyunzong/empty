// Package placement assigns tasks to machines at minimum cost.
//
// A problem has up to 62 tasks (the library is tuned for <= 18) and a
// small number of machines (tuned for 4). Each task consumes CPU and
// memory on the machine it is placed on. Tasks may carry an affinity
// (the set of machines they are allowed to run on) and pairwise
// anti-affinity constraints (two tasks that must not share a machine).
// The total cost is the sum of startup costs for machines that are
// powered on plus a migration cost for every task that leaves the
// machine it occupied in the old placement. If no feasible placement
// exists, the old placement is kept.
package placement

import (
	"fmt"
	"strings"
)

// Task is a unit of work to place on exactly one machine.
type Task struct {
	Name string
	CPU  int
	Mem  int
	// Allowed lists, per machine, whether the task may run there.
	// A nil slice means every machine is allowed.
	Allowed []bool
}

// Machine is a placement target with two resource capacities.
type Machine struct {
	Name   string
	CPUCap int
	MemCap int
	// StartupCost is paid once if the machine is used while not Running.
	StartupCost int
	// Running reports whether the machine is already powered on.
	Running bool
}

// Problem describes one placement optimisation request.
type Problem struct {
	Tasks    []Task
	Machines []Machine
	// Conflicts lists pairs of task indices that must not share a machine.
	Conflicts [][2]int
	// OldPlacement holds the current machine index per task, -1 if the
	// task is not currently placed anywhere.
	OldPlacement []int
	// MigrationCost is paid for every task whose machine changes.
	MigrationCost int
}

// Validate reports whether the problem is well formed.
func (p Problem) Validate() error {
	n, m := len(p.Tasks), len(p.Machines)
	if m == 0 {
		return fmt.Errorf("no machines")
	}
	if n == 0 {
		return fmt.Errorf("no tasks")
	}
	if n > 62 {
		return fmt.Errorf("too many tasks: %d > 62", n)
	}
	if len(p.OldPlacement) != n {
		return fmt.Errorf("OldPlacement has %d entries, want %d", len(p.OldPlacement), n)
	}
	if p.MigrationCost < 0 {
		return fmt.Errorf("negative MigrationCost")
	}
	for i, t := range p.Tasks {
		if t.CPU < 0 || t.Mem < 0 {
			return fmt.Errorf("task %d has negative demand", i)
		}
		if t.Allowed != nil && len(t.Allowed) != m {
			return fmt.Errorf("task %d Allowed has %d entries, want %d", i, len(t.Allowed), m)
		}
	}
	for x, mc := range p.Machines {
		if mc.CPUCap < 0 || mc.MemCap < 0 {
			return fmt.Errorf("machine %d has negative capacity", x)
		}
		if mc.StartupCost < 0 {
			return fmt.Errorf("machine %d has negative StartupCost", x)
		}
	}
	for i, x := range p.OldPlacement {
		if x < -1 || x >= m {
			return fmt.Errorf("OldPlacement[%d] = %d out of range", i, x)
		}
	}
	for _, c := range p.Conflicts {
		if c[0] < 0 || c[0] >= n || c[1] < 0 || c[1] >= n || c[0] == c[1] {
			return fmt.Errorf("invalid conflict pair %v", c)
		}
	}
	return nil
}

// Certificate is a capacity certificate for a placement: it records the
// per-machine resource usage against capacity and the full cost
// breakdown, so the result can be checked independently of the solver.
type Certificate struct {
	Placement   []int
	MachineCPU  []int
	MachineMem  []int
	Used        []bool
	StartupPaid []bool
	Migrated    []int
	StartupCost int
	MigrateCost int
	TotalCost   int
}

// Verify checks a placement against every constraint and computes its
// cost. The returned certificate is valid for inspection even when ok
// is false; ok reports whether every constraint holds.
func (p Problem) Verify(pl []int) (cert Certificate, ok bool) {
	m := len(p.Machines)
	cert = Certificate{
		Placement:   append([]int(nil), pl...),
		MachineCPU:  make([]int, m),
		MachineMem:  make([]int, m),
		Used:        make([]bool, m),
		StartupPaid: make([]bool, m),
	}
	ok = true
	if len(pl) != len(p.Tasks) {
		return cert, false
	}
	for i, x := range pl {
		if x < 0 || x >= m {
			ok = false
			continue
		}
		t := p.Tasks[i]
		if t.Allowed != nil && !t.Allowed[x] {
			ok = false
		}
		cert.MachineCPU[x] += t.CPU
		cert.MachineMem[x] += t.Mem
		cert.Used[x] = true
		if p.OldPlacement[i] >= 0 && p.OldPlacement[i] != x {
			cert.Migrated = append(cert.Migrated, i)
		}
	}
	for _, c := range p.Conflicts {
		if pl[c[0]] >= 0 && pl[c[0]] == pl[c[1]] {
			ok = false
		}
	}
	for x := 0; x < m; x++ {
		if cert.MachineCPU[x] > p.Machines[x].CPUCap || cert.MachineMem[x] > p.Machines[x].MemCap {
			ok = false
		}
		if cert.Used[x] && !p.Machines[x].Running {
			cert.StartupPaid[x] = true
			cert.StartupCost += p.Machines[x].StartupCost
		}
	}
	cert.MigrateCost = p.MigrationCost * len(cert.Migrated)
	cert.TotalCost = cert.StartupCost + cert.MigrateCost
	return cert, ok
}

// Result is the outcome of Solve.
type Result struct {
	// Placement is the minimum-cost placement, or the old placement
	// when no feasible placement exists.
	Placement []int
	// Cost is the total cost of Placement under the cost model.
	Cost int
	// Optimal reports whether a feasible minimum-cost placement was found.
	Optimal bool
	// KeptOld reports whether the old placement was kept because the
	// problem is infeasible.
	KeptOld bool
	// Certificate is the capacity certificate for Placement.
	Certificate Certificate
	// CertificateValid reports whether Placement satisfies every
	// constraint. It may be false when an infeasible old plan is kept.
	CertificateValid bool
	// Reason explains why the old placement was kept, if it was.
	Reason string
}

func taskName(p Problem, i int) string {
	if p.Tasks[i].Name != "" {
		return p.Tasks[i].Name
	}
	return fmt.Sprintf("T%d", i)
}

func machineName(p Problem, x int) string {
	if p.Machines[x].Name != "" {
		return p.Machines[x].Name
	}
	return fmt.Sprintf("M%d", x)
}

// String renders the result: the assignment list followed by the
// capacity certificate.
func (r Result) String(p Problem) string {
	var b strings.Builder
	if r.KeptOld {
		fmt.Fprintf(&b, "infeasible: %s; keeping old placement\n", r.Reason)
	} else {
		fmt.Fprintf(&b, "optimal placement, total cost %d\n", r.Cost)
	}
	b.WriteString("assignment:\n")
	for i, x := range r.Placement {
		name := "unassigned"
		if x >= 0 && x < len(p.Machines) {
			name = machineName(p, x)
		}
		fmt.Fprintf(&b, "  %s -> %s\n", taskName(p, i), name)
	}
	b.WriteString("capacity certificate:\n")
	c := r.Certificate
	for x := range p.Machines {
		fmt.Fprintf(&b, "  %s: cpu %d/%d mem %d/%d",
			machineName(p, x), c.MachineCPU[x], p.Machines[x].CPUCap,
			c.MachineMem[x], p.Machines[x].MemCap)
		if c.StartupPaid[x] {
			fmt.Fprintf(&b, " startup=%d", p.Machines[x].StartupCost)
		}
		if !c.Used[x] {
			b.WriteString(" (unused)")
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "  startup cost %d + migration cost %d (%d tasks) = %d\n",
		c.StartupCost, c.MigrateCost, len(c.Migrated), c.TotalCost)
	if !r.CertificateValid {
		b.WriteString("  WARNING: placement violates constraints\n")
	}
	return b.String()
}
