package main

// BruteForce 枚举所有“每任务选一窗口或放弃”的组合，返回最优解。
// 仅用于小规模数据的最优性验证。
func BruteForce(p *Problem, order []int) Solution {
	n := len(p.Tasks)
	idx := make(map[string]int, n)
	for i, t := range p.Tasks {
		idx[t.ID] = i
	}
	deps := depIndices(p, idx)

	best := -1
	var bestAssign Assignment
	assign := make(Assignment, n)
	for i := range assign {
		assign[i] = -2 // 未决定
	}

	var visit func(pos, cost int)
	visit = func(pos, cost int) {
		if best >= 0 && cost >= best {
			return
		}
		if pos == n {
			if best < 0 || cost < best {
				best = cost
				bestAssign = make(Assignment, n)
				copy(bestAssign, assign)
			}
			return
		}
		t := order[pos]
		task := p.Tasks[t]
		schedulable := true
		for _, d := range deps[t] {
			if assign[d] < 0 {
				schedulable = false
				break
			}
		}
		if schedulable {
			for wi, w := range task.Windows {
				ok := true
				for _, d := range deps[t] {
					dw := p.Tasks[d].Windows[assign[d]]
					if dw.End > w.Start {
						ok = false
						break
					}
				}
				if ok {
					for u := 0; u < n && ok; u++ {
						if u == t || assign[u] < 0 || p.Tasks[u].Equipment != task.Equipment {
							continue
						}
						if overlap(p.Tasks[u].Windows[assign[u]], w) {
							ok = false
						}
					}
				}
				if ok {
					assign[t] = wi
					visit(pos+1, cost+w.Cost)
				}
			}
		}
		assign[t] = -1
		visit(pos+1, cost+task.Penalty)
		assign[t] = -2
	}
	visit(0, 0)
	return Solution{Assign: bestAssign, Cost: best}
}
