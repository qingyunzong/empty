package main

import "sort"

// Assignment 记录每项任务的决策：-1 表示放弃，否则为所选窗口下标。
type Assignment []int

// Solution 为求解结果。
type Solution struct {
	Assign Assignment
	Cost   int
}

// Solve 用分支定界求总费最少的安排。order 为拓扑序。
func Solve(p *Problem, order []int) Solution {
	n := len(p.Tasks)
	idx := make(map[string]int, n)
	for i, t := range p.Tasks {
		idx[t.ID] = i
	}
	deps := depIndices(p, idx)

	s := &solver{
		p:        p,
		order:    order,
		deps:     deps,
		assign:   make(Assignment, n),
		occ:      make(map[string][]Window),
		best:     -1,
		sortedWs: make([][]int, n),
	}
	for i := range s.assign {
		s.assign[i] = -2 // 未决定
	}
	// 每个任务的窗口按费用升序，加速收敛
	for i, t := range p.Tasks {
		ws := make([]int, len(t.Windows))
		for j := range ws {
			ws[j] = j
		}
		sort.Slice(ws, func(a, b int) bool {
			wa, wb := t.Windows[ws[a]], t.Windows[ws[b]]
			if wa.Cost != wb.Cost {
				return wa.Cost < wb.Cost
			}
			return wa.Start < wb.Start
		})
		s.sortedWs[i] = ws
	}
	// 后缀下界：剩余每项任务的最小可选费用（忽略冲突与依赖完成时间）
	s.suffixLB = make([]int, n+1)
	for pos := n - 1; pos >= 0; pos-- {
		t := p.Tasks[order[pos]]
		lo := t.Penalty
		for _, w := range t.Windows {
			if w.Cost < lo {
				lo = w.Cost
			}
		}
		s.suffixLB[pos] = s.suffixLB[pos+1] + lo
	}
	s.dfs(0, 0)
	best := make(Assignment, n)
	copy(best, s.bestAssign)
	return Solution{Assign: best, Cost: s.best}
}

type solver struct {
	p          *Problem
	order      []int
	deps       [][]int
	assign     Assignment
	occ        map[string][]Window // 各设备已占用的半开区间
	best       int
	bestAssign Assignment
	sortedWs   [][]int
	suffixLB   []int
}

func (s *solver) dfs(pos, cost int) {
	n := len(s.order)
	if cost+s.suffixLB[pos] >= s.best && s.best >= 0 {
		return
	}
	if pos == n {
		if s.best < 0 || cost < s.best {
			s.best = cost
			s.bestAssign = make(Assignment, n)
			copy(s.bestAssign, s.assign)
		}
		return
	}
	t := s.order[pos]
	task := s.p.Tasks[t]
	// 前置全部已安排（未被放弃）时才可排程
	schedulable := true
	for _, d := range s.deps[t] {
		if s.assign[d] < 0 {
			schedulable = false
			break
		}
	}
	if schedulable {
		for _, wi := range s.sortedWs[t] {
			w := task.Windows[wi]
			if !s.depsDoneBy(t, w.Start) {
				continue
			}
			if s.conflicts(task.Equipment, w) {
				continue
			}
			s.assign[t] = wi
			s.occ[task.Equipment] = append(s.occ[task.Equipment], w)
			s.dfs(pos+1, cost+w.Cost)
			s.occ[task.Equipment] = s.occ[task.Equipment][:len(s.occ[task.Equipment])-1]
			s.assign[t] = -2
		}
	}
	// 选项：放弃
	s.assign[t] = -1
	s.dfs(pos+1, cost+task.Penalty)
	s.assign[t] = -2
}

// depsDoneBy 检查所有前置任务的窗口结束时间均不晚于 t0。
func (s *solver) depsDoneBy(t, t0 int) bool {
	for _, d := range s.deps[t] {
		w := s.p.Tasks[d].Windows[s.assign[d]]
		if w.End > t0 {
			return false
		}
	}
	return true
}

// conflicts 检查窗口 w 是否与同设备已占用区间重叠。
func (s *solver) conflicts(equip string, w Window) bool {
	for _, o := range s.occ[equip] {
		if overlap(o, w) {
			return true
		}
	}
	return false
}
