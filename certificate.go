package placement

import "fmt"

// buildCertificate assembles the capacity certificate for a result. For a
// feasible plan it records per-machine usage against capacity. For an
// infeasible request it records the reason: a simple standalone proof when
// one exists (empty affinity, single-task over-demand, aggregate
// over-demand, or a blocking anti-colocation clique), otherwise the
// exhaustive-search verdict with its node count.
func buildCertificate(req Request, res Result, nodes int64) Certificate {
	cert := Certificate{
		Feasible:      res.Feasible,
		KeptOld:       !res.Feasible,
		NodesExplored: nodes,
	}
	for _, m := range req.Machines {
		cert.TotalCPUCap += m.CPU
		cert.TotalMemCap += m.Mem
	}
	for _, t := range req.Tasks {
		cert.TotalCPU += t.CPU
		cert.TotalMem += t.Mem
	}
	usage := make([]MachineUsage, len(req.Machines))
	for i, m := range req.Machines {
		usage[i] = MachineUsage{MachineID: m.ID, CPUCap: m.CPU, MemCap: m.Mem}
	}
	machineIdx := make(map[string]int, len(req.Machines))
	for i, m := range req.Machines {
		machineIdx[m.ID] = i
	}
	for _, t := range sortedTasks(req.Tasks) {
		mid, ok := res.Plan[t.ID]
		if !ok {
			continue
		}
		u := &usage[machineIdx[mid]]
		u.Tasks = append(u.Tasks, t.ID)
		u.CPUUsed += t.CPU
		u.MemUsed += t.Mem
	}
	cert.Usage = usage
	if res.Feasible {
		cert.Reason = "feasible: per-machine usage within capacity"
		return cert
	}
	reason, clique, certain := precheckInfeasible(req)
	if !certain {
		reason = "no feasible assignment exists (verified by exhaustive branch-and-bound search)"
	}
	cert.Reason, cert.Clique = reason, clique
	return cert
}

// precheckInfeasible looks for a simple standalone proof of infeasibility,
// checked cheapest first. Every check is sound, so a certain result lets
// Solve skip the search entirely.
func precheckInfeasible(req Request) (reason string, clique []string, certain bool) {
	tasks := sortedTasks(req.Tasks)
	m := len(req.Machines)
	for _, t := range tasks {
		allowed := 0
		for j := 0; j < m; j++ {
			if len(t.Allowed) == 0 || t.Allowed[j] {
				allowed++
			}
		}
		if allowed == 0 {
			return fmt.Sprintf("task %q has no allowed machine", t.ID), nil, true
		}
	}
	for _, t := range tasks {
		fits := false
		for j := 0; j < m; j++ {
			if (len(t.Allowed) == 0 || t.Allowed[j]) &&
				t.CPU <= req.Machines[j].CPU && t.Mem <= req.Machines[j].Mem {
				fits = true
				break
			}
		}
		if !fits {
			return fmt.Sprintf("task %q alone exceeds the capacity of every allowed machine", t.ID), nil, true
		}
	}
	var totalCPU, totalMem, capCPU, capMem int64
	for _, t := range tasks {
		totalCPU += t.CPU
		totalMem += t.Mem
	}
	for _, mc := range req.Machines {
		capCPU += mc.CPU
		capMem += mc.Mem
	}
	if totalCPU > capCPU {
		return fmt.Sprintf("aggregate CPU demand %d exceeds total capacity %d", totalCPU, capCPU), nil, true
	}
	if totalMem > capMem {
		return fmt.Sprintf("aggregate memory demand %d exceeds total capacity %d", totalMem, capMem), nil, true
	}
	if c, avail := blockingClique(req, tasks); c != nil {
		return fmt.Sprintf("anti-colocation clique of %d tasks shares only %d usable machine(s)", len(c), avail), c, true
	}
	return "", nil, false
}

// blockingClique finds a clique in the anti-colocation graph whose size
// exceeds the number of machines usable by at least one of its members.
// Such a clique is a standalone proof of infeasibility. Returns nil when no
// clique larger than the machine count exists.
func blockingClique(req Request, tasks []Task) ([]string, int) {
	n := len(tasks)
	m := len(req.Machines)
	anti := antiMatrix(req, tasks)
	adj := make([]uint32, n)
	for i := range anti {
		for j := range anti[i] {
			if anti[i][j] {
				adj[i] |= 1 << uint(j)
			}
		}
	}
	allowedMask := make([]uint32, n)
	for i, t := range tasks {
		for j := 0; j < m; j++ {
			if len(t.Allowed) == 0 || t.Allowed[j] {
				allowedMask[i] |= 1 << uint(j)
			}
		}
	}
	var best []int
	var bestAvail int
	// Bron-Kerbosch over bitmasks; n <= 18 so this is instant.
	var expand func(clique []int, candidates uint32)
	expand = func(clique []int, candidates uint32) {
		if len(clique) > len(best) {
			var union uint32
			for _, v := range clique {
				union |= allowedMask[v]
			}
			if avail := popcount(union); len(clique) > avail {
				best = append([]int(nil), clique...)
				bestAvail = avail
			}
		}
		// Upper bound: even taking every candidate we cannot beat best.
		if len(clique)+popcount(candidates) <= len(best) {
			return
		}
		for candidates != 0 {
			v := trailingZeros(candidates)
			candidates &^= 1 << uint(v)
			expand(append(clique, v), candidates&adj[v])
			if len(clique)+popcount(candidates) <= len(best) {
				return
			}
		}
	}
	expand(nil, (1<<uint(n))-1)
	if best == nil {
		return nil, 0
	}
	ids := make([]string, len(best))
	for i, v := range best {
		ids[i] = tasks[v].ID
	}
	return ids, bestAvail
}

func popcount(x uint32) int {
	c := 0
	for x != 0 {
		x &= x - 1
		c++
	}
	return c
}

func trailingZeros(x uint32) int {
	c := 0
	for x&1 == 0 {
		x >>= 1
		c++
	}
	return c
}
