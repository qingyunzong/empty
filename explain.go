package main

import (
	"fmt"
	"strings"
)

// Explain 为每项任务生成安排说明与冲突解释。
func Explain(p *Problem, sol Solution) []string {
	n := len(p.Tasks)
	idx := make(map[string]int, n)
	for i, t := range p.Tasks {
		idx[t.ID] = i
	}
	deps := depIndices(p, idx)
	lines := make([]string, n)
	for i, t := range p.Tasks {
		a := sol.Assign[i]
		if a >= 0 {
			w := t.Windows[a]
			var b strings.Builder
			fmt.Fprintf(&b, "任务 %s：安排于窗口 [%d,%d)，设备 %s，费用 %d", t.ID, w.Start, w.End, t.Equipment, w.Cost)
			if len(deps[i]) > 0 {
				var parts []string
				for _, d := range deps[i] {
					dw := p.Tasks[d].Windows[sol.Assign[d]]
					parts = append(parts, fmt.Sprintf("%s(完成于 %d)", p.Tasks[d].ID, dw.End))
				}
				fmt.Fprintf(&b, "；前置 %s 均已按时完成", strings.Join(parts, "、"))
			}
			lines[i] = b.String()
			continue
		}
		// 放弃的任务：解释原因
		var abandonedDeps []string
		for _, d := range deps[i] {
			if sol.Assign[d] < 0 {
				abandonedDeps = append(abandonedDeps, p.Tasks[d].ID)
			}
		}
		if len(abandonedDeps) > 0 {
			lines[i] = fmt.Sprintf("任务 %s：放弃，罚费 %d；前置任务 %s 被放弃，无法排程",
				t.ID, t.Penalty, strings.Join(abandonedDeps, "、"))
			continue
		}
		// 在其他任务安排固定的情况下，逐窗口分析可行性
		bestCost := -1
		var reasons []string
		for wi, w := range t.Windows {
			var why []string
			for _, d := range deps[i] {
				dw := p.Tasks[d].Windows[sol.Assign[d]]
				if dw.End > w.Start {
					why = append(why, fmt.Sprintf("前置 %s 完成于 %d 晚于窗口开始 %d", p.Tasks[d].ID, dw.End, w.Start))
				}
			}
			for j, u := range p.Tasks {
				if j == i || sol.Assign[j] < 0 || u.Equipment != t.Equipment {
					continue
				}
				uw := u.Windows[sol.Assign[j]]
				if overlap(uw, w) {
					why = append(why, fmt.Sprintf("与任务 %s 在设备 %s 上的占用 [%d,%d) 冲突", u.ID, u.Equipment, uw.Start, uw.End))
				}
			}
			if len(why) == 0 {
				if bestCost < 0 || w.Cost < bestCost {
					bestCost = w.Cost
				}
			} else {
				reasons = append(reasons, fmt.Sprintf("窗口%d[%d,%d)：%s", wi, w.Start, w.End, strings.Join(why, "；")))
			}
		}
		if bestCost < 0 {
			lines[i] = fmt.Sprintf("任务 %s：放弃，罚费 %d；所有候选窗口均不可行——%s",
				t.ID, t.Penalty, strings.Join(reasons, "；"))
		} else {
			lines[i] = fmt.Sprintf("任务 %s：放弃，罚费 %d；最优可行窗口费用 %d 高于罚费，放弃更省",
				t.ID, t.Penalty, bestCost)
		}
	}
	return lines
}
