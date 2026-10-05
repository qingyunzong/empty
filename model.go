package main

import (
	"fmt"
	"sort"
)

// Window 为候选半开窗口 [Start, End)，选中即表示任务在该区间内占用设备。
type Window struct {
	Start int `json:"start"`
	End   int `json:"end"`
	Cost  int `json:"cost"`
}

// Task 为一项维修任务。
type Task struct {
	ID        string   `json:"id"`
	Equipment string   `json:"equipment"`
	Windows   []Window `json:"windows"`
	Penalty   int      `json:"penalty"` // 放弃该任务的罚费
	Deps      []string `json:"deps"`    // 前置任务 ID，前置完成(窗口结束)后方可开始
}

// Problem 为一次排程问题，任务数至多为 MaxTasks。
type Problem struct {
	Tasks []Task `json:"tasks"`
}

const MaxTasks = 16

// validate 校验输入并返回 ID->下标 映射与拓扑序（前置任务排在前）。
func (p *Problem) validate() (map[string]int, []int, error) {
	n := len(p.Tasks)
	if n == 0 {
		return nil, nil, fmt.Errorf("任务列表为空")
	}
	if n > MaxTasks {
		return nil, nil, fmt.Errorf("任务数 %d 超过上限 %d", n, MaxTasks)
	}
	idx := make(map[string]int, n)
	for i, t := range p.Tasks {
		if t.ID == "" {
			return nil, nil, fmt.Errorf("第 %d 项任务缺少 id", i)
		}
		if _, dup := idx[t.ID]; dup {
			return nil, nil, fmt.Errorf("任务 id %q 重复", t.ID)
		}
		if t.Equipment == "" {
			return nil, nil, fmt.Errorf("任务 %q 缺少 equipment", t.ID)
		}
		if t.Penalty < 0 {
			return nil, nil, fmt.Errorf("任务 %q 罚费为负", t.ID)
		}
		for j, w := range t.Windows {
			if w.Start < 0 || w.End <= w.Start {
				return nil, nil, fmt.Errorf("任务 %q 第 %d 个窗口非法: [%d,%d)", t.ID, j, w.Start, w.End)
			}
			if w.Cost < 0 {
				return nil, nil, fmt.Errorf("任务 %q 第 %d 个窗口费用为负", t.ID, j)
			}
		}
		idx[t.ID] = i
	}
	// 依赖解析
	deps := make([][]int, n)
	for i, t := range p.Tasks {
		seen := map[int]bool{}
		for _, d := range t.Deps {
			j, ok := idx[d]
			if !ok {
				return nil, nil, fmt.Errorf("任务 %q 依赖未知任务 %q", t.ID, d)
			}
			if j == i {
				return nil, nil, fmt.Errorf("任务 %q 依赖自身", t.ID)
			}
			if !seen[j] {
				seen[j] = true
				deps[i] = append(deps[i], j)
			}
		}
	}
	// Kahn 拓扑排序，同时检测环
	indeg := make([]int, n)
	children := make([][]int, n)
	for i := range deps {
		indeg[i] = len(deps[i])
		for _, j := range deps[i] {
			children[j] = append(children[j], i)
		}
	}
	var queue []int
	for i := 0; i < n; i++ {
		if indeg[i] == 0 {
			queue = append(queue, i)
		}
	}
	sort.Ints(queue)
	var order []int
	for len(queue) > 0 {
		v := queue[0]
		queue = queue[1:]
		order = append(order, v)
		var next []int
		for _, c := range children[v] {
			indeg[c]--
			if indeg[c] == 0 {
				next = append(next, c)
			}
		}
		sort.Ints(next)
		queue = append(queue, next...)
	}
	if len(order) != n {
		return nil, nil, fmt.Errorf("依赖关系存在环")
	}
	return idx, order, nil
}

// depIndices 返回每个任务的前置任务下标集合。
func depIndices(p *Problem, idx map[string]int) [][]int {
	deps := make([][]int, len(p.Tasks))
	for i, t := range p.Tasks {
		seen := map[int]bool{}
		for _, d := range t.Deps {
			j := idx[d]
			if !seen[j] {
				seen[j] = true
				deps[i] = append(deps[i], j)
			}
		}
		sort.Ints(deps[i])
	}
	return deps
}

// overlap 判断两个半开区间是否重叠。
func overlap(a, b Window) bool {
	return a.Start < b.End && b.Start < a.End
}
