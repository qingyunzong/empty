package frameindex

import "sort"

// Plan 是 seek 的结果：目标显示区间所需的最小依赖闭包及其诊断信息。
type Plan struct {
	Start, End int64        // 目标显示区间（闭区间）
	Targets    []string     // 显示时间落在区间内的帧（按显示时间升序）
	Closure    []string     // 最小依赖闭包（帧 ID 集合，无序；含环上帧）
	Missing    []MissingRef // 缺失的参考
	Cycles     []Cycle      // 依赖环
}

// SeekInterval 求显示区间 [start, end] 所需的最小依赖闭包：
// 从显示时间落入区间的目标帧出发，沿显式参考边做传递闭包。
// 缺失参考与依赖环被显式报告；闭包中不含缺失帧。
func (ix *Index) SeekInterval(start, end int64) *Plan {
	if end < start {
		start, end = end, start
	}
	p := &Plan{Start: start, End: end}

	// 目标帧：按显示时间归属区间。显示时间只用于选目标，不参与排序解码。
	for _, f := range ix.frames {
		if f.DisplayTime >= start && f.DisplayTime <= end {
			p.Targets = append(p.Targets, f.ID)
		}
	}
	sort.Slice(p.Targets, func(i, j int) bool {
		a, b := ix.frames[p.Targets[i]], ix.frames[p.Targets[j]]
		if a.DisplayTime != b.DisplayTime {
			return a.DisplayTime < b.DisplayTime
		}
		return a.ID < b.ID
	})

	// 三色 DFS 求传递闭包，同时检测环。
	const (
		white = 0 // 未访问
		gray  = 1 // 在栈上
		black = 2 // 已完成
	)
	color := make(map[string]int, len(ix.frames))
	inClosure := make(map[string]bool)
	var stack []string

	var visit func(id string)
	visit = func(id string) {
		f, ok := ix.frames[id]
		if !ok {
			return // 缺失参考由调用处记录
		}
		color[id] = gray
		stack = append(stack, id)
		inClosure[id] = true
		for _, ref := range f.Refs {
			if _, ok := ix.frames[ref]; !ok {
				p.Missing = append(p.Missing, MissingRef{From: id, RefID: ref})
				continue
			}
			switch color[ref] {
			case white:
				visit(ref)
			case gray:
				// 找到环：从栈中 ref 的位置到栈顶。
				for i := len(stack) - 1; i >= 0; i-- {
					if stack[i] == ref {
						cyc := make(Cycle, 0, len(stack)-i+1)
						cyc = append(cyc, stack[i:]...)
						cyc = append(cyc, ref)
						p.Cycles = append(p.Cycles, cyc)
						break
					}
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[id] = black
	}

	for _, t := range p.Targets {
		if color[t] == white {
			visit(t)
		}
	}

	for id := range inClosure {
		p.Closure = append(p.Closure, id)
	}
	sort.Strings(p.Closure)
	sort.Slice(p.Missing, func(i, j int) bool {
		if p.Missing[i].From != p.Missing[j].From {
			return p.Missing[i].From < p.Missing[j].From
		}
		return p.Missing[i].RefID < p.Missing[j].RefID
	})
	return p
}

// onCycle 报告帧是否位于某个依赖环上（环上帧无法给出拓扑序）。
func (p *Plan) onCycle() map[string]bool {
	bad := make(map[string]bool)
	for _, c := range p.Cycles {
		for _, id := range c {
			bad[id] = true
		}
	}
	return bad
}
