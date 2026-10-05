package main

import (
	"errors"
	"fmt"
)

// Window 为候选半开窗口 [Start, End)，安排费用为 Cost。
type Window struct {
	Start int `json:"start"`
	End   int `json:"end"`
	Cost  int `json:"cost"`
}

// Job 为一项维修任务。
type Job struct {
	ID        string   `json:"id"`
	Equipment string   `json:"equipment"`
	DependsOn []string `json:"depends_on"`
	Penalty   int      `json:"penalty"`
	Windows   []Window `json:"windows"`
}

// Problem 为输入问题，至多 16 项任务。
type Problem struct {
	Jobs []Job `json:"jobs"`
}

const MaxJobs = 16

// Solution 中 Assign[i] 为任务 i 选中的窗口下标，-1 表示放弃。
type Solution struct {
	Assign []int
	Cost   int
}

// Validate 检查问题合法性，返回错误。
func (p *Problem) Validate() error {
	if len(p.Jobs) == 0 {
		return errors.New("任务列表为空")
	}
	if len(p.Jobs) > MaxJobs {
		return fmt.Errorf("任务数 %d 超过上限 %d", len(p.Jobs), MaxJobs)
	}
	seen := map[string]bool{}
	for i, j := range p.Jobs {
		if j.ID == "" {
			return fmt.Errorf("第 %d 项任务缺少 id", i)
		}
		if seen[j.ID] {
			return fmt.Errorf("任务 id %q 重复", j.ID)
		}
		seen[j.ID] = true
		if j.Equipment == "" {
			return fmt.Errorf("任务 %q 缺少 equipment", j.ID)
		}
		if j.Penalty < 0 {
			return fmt.Errorf("任务 %q 罚费为负", j.ID)
		}
		for k, w := range j.Windows {
			if w.End <= w.Start {
				return fmt.Errorf("任务 %q 窗口 %d 非法：[%d,%d) 非半开正区间", j.ID, k, w.Start, w.End)
			}
			if w.Cost < 0 {
				return fmt.Errorf("任务 %q 窗口 %d 费用为负", j.ID, k)
			}
		}
	}
	for _, j := range p.Jobs {
		for _, d := range j.DependsOn {
			if !seen[d] {
				return fmt.Errorf("任务 %q 依赖未知任务 %q", j.ID, d)
			}
			if d == j.ID {
				return fmt.Errorf("任务 %q 自依赖", j.ID)
			}
		}
	}
	return nil
}

// topoOrder 返回拓扑序（前项先于后项），有环时报错。
func topoOrder(p *Problem) ([]int, [][]int, error) {
	n := len(p.Jobs)
	idx := map[string]int{}
	for i, j := range p.Jobs {
		idx[j.ID] = i
	}
	preds := make([][]int, n)
	indeg := make([]int, n)
	children := make([][]int, n)
	for i, j := range p.Jobs {
		for _, d := range j.DependsOn {
			pr := idx[d]
			preds[i] = append(preds[i], pr)
			children[pr] = append(children[pr], i)
			indeg[i]++
		}
	}
	var queue []int
	for i := 0; i < n; i++ {
		if indeg[i] == 0 {
			queue = append(queue, i)
		}
	}
	var order []int
	for len(queue) > 0 {
		u := queue[0]
		queue = queue[1:]
		order = append(order, u)
		for _, v := range children[u] {
			indeg[v]--
			if indeg[v] == 0 {
				queue = append(queue, v)
			}
		}
	}
	if len(order) != n {
		return nil, nil, errors.New("依赖关系存在环，无法排程")
	}
	return order, preds, nil
}

func overlap(a, b Window) bool { return a.Start < b.End && b.Start < a.End }

// feasible 判断任务 j 选窗口 w 是否与已安排任务冲突。
func feasible(p *Problem, preds [][]int, assign []int, j, w int) bool {
	wj := p.Jobs[j].Windows[w]
	for _, pr := range preds[j] {
		if assign[pr] == -1 {
			return false // 前项被放弃
		}
		if p.Jobs[pr].Windows[assign[pr]].End > wj.Start {
			return false // 前项未完成
		}
	}
	for i := 0; i < len(p.Jobs); i++ {
		if i == j || assign[i] == -1 {
			continue
		}
		if p.Jobs[i].Equipment != p.Jobs[j].Equipment {
			continue
		}
		if overlap(p.Jobs[i].Windows[assign[i]], wj) {
			return false
		}
	}
	return true
}

func costOf(p *Problem, assign []int) int {
	total := 0
	for i, a := range assign {
		if a == -1 {
			total += p.Jobs[i].Penalty
		} else {
			total += p.Jobs[i].Windows[a].Cost
		}
	}
	return total
}

// Solve 用分支定界求总费最少的安排。
func Solve(p *Problem) (*Solution, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	order, preds, err := topoOrder(p)
	if err != nil {
		return nil, err
	}
	n := len(p.Jobs)

	// 后缀下界：每个未处理任务至少付出 min(最便宜窗口, 罚费)。
	suffixMin := make([]int, n+1)
	for pos := n - 1; pos >= 0; pos-- {
		j := p.Jobs[order[pos]]
		best := j.Penalty
		for _, w := range j.Windows {
			if w.Cost < best {
				best = w.Cost
			}
		}
		suffixMin[pos] = suffixMin[pos+1] + best
	}

	assign := make([]int, n)
	best := make([]int, n)
	bestCost := 0 // 初始上界：全部放弃
	for i, j := range p.Jobs {
		assign[i] = -1
		best[i] = -1
		bestCost += j.Penalty
	}

	// 贪心可行解收紧上界。
	greedy := make([]int, n)
	for i := range greedy {
		greedy[i] = -1
	}
	for _, j := range order {
		bestW, bestC := -1, p.Jobs[j].Penalty
		for w, win := range p.Jobs[j].Windows {
			if win.Cost < bestC && feasible(p, preds, greedy, j, w) {
				bestW, bestC = w, win.Cost
			}
		}
		greedy[j] = bestW
	}
	if c := costOf(p, greedy); c < bestCost {
		bestCost = c
		copy(best, greedy)
	}

	var dfs func(pos, cost int)
	dfs = func(pos, cost int) {
		if cost+suffixMin[pos] >= bestCost {
			return
		}
		if pos == n {
			bestCost = cost
			copy(best, assign)
			return
		}
		j := order[pos]
		for w := range p.Jobs[j].Windows {
			if !feasible(p, preds, assign, j, w) {
				continue
			}
			assign[j] = w
			dfs(pos+1, cost+p.Jobs[j].Windows[w].Cost)
			assign[j] = -1
		}
		dfs(pos+1, cost+p.Jobs[j].Penalty)
	}
	dfs(0, 0)
	return &Solution{Assign: best, Cost: bestCost}, nil
}

// BruteForce 不做任何剪枝的完整枚举，用于小数据验证最优性。
func BruteForce(p *Problem) (*Solution, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if len(p.Jobs) > 12 {
		return nil, fmt.Errorf("枚举验证限 12 项以内，当前 %d 项", len(p.Jobs))
	}
	order, preds, err := topoOrder(p)
	if err != nil {
		return nil, err
	}
	n := len(p.Jobs)
	assign := make([]int, n)
	best := make([]int, n)
	for i := range assign {
		assign[i] = -1
		best[i] = -1
	}
	bestCost := -1
	var dfs func(pos, cost int)
	dfs = func(pos, cost int) {
		if pos == n {
			if bestCost == -1 || cost < bestCost {
				bestCost = cost
				copy(best, assign)
			}
			return
		}
		j := order[pos]
		for w := range p.Jobs[j].Windows {
			if !feasible(p, preds, assign, j, w) {
				continue
			}
			assign[j] = w
			dfs(pos+1, cost+p.Jobs[j].Windows[w].Cost)
			assign[j] = -1
		}
		dfs(pos+1, cost+p.Jobs[j].Penalty)
	}
	dfs(0, 0)
	return &Solution{Assign: best, Cost: bestCost}, nil
}

// Explain 对最优解逐任务给出安排与冲突解释（中文）。
func Explain(p *Problem, s *Solution) []string {
	var lines []string
	for i, j := range p.Jobs {
		a := s.Assign[i]
		if a >= 0 {
			w := j.Windows[a]
			lines = append(lines, fmt.Sprintf(
				"任务 %s：安排于设备 %s 的窗口 [%d,%d)，费用 %d；满足全部依赖与设备不重叠约束。",
				j.ID, j.Equipment, w.Start, w.End, w.Cost))
			continue
		}
		lines = append(lines, fmt.Sprintf("任务 %s：放弃，计罚费 %d。原因如下：", j.ID, j.Penalty))
		idx := map[string]int{}
		for k, jj := range p.Jobs {
			idx[jj.ID] = k
		}
		droppedPred := ""
		for _, d := range j.DependsOn {
			if s.Assign[idx[d]] == -1 {
				droppedPred = d
				break
			}
		}
		// 逐窗口说明为何不可行或不划算。
		for _, win := range j.Windows {
			conflict := ""
			if droppedPred != "" {
				conflict = fmt.Sprintf("前项 %s 被放弃，依赖无法满足", droppedPred)
			}
			for _, d := range j.DependsOn {
				pi := idx[d]
				if conflict == "" && s.Assign[pi] >= 0 && p.Jobs[pi].Windows[s.Assign[pi]].End > win.Start {
					conflict = fmt.Sprintf("前项 %s 完成于 %d，晚于窗口开始 %d",
						d, p.Jobs[pi].Windows[s.Assign[pi]].End, win.Start)
				}
			}
			if conflict == "" {
				for k, jj := range p.Jobs {
					if k == i || jj.Equipment != j.Equipment || s.Assign[k] == -1 {
						continue
					}
					ow := jj.Windows[s.Assign[k]]
					if overlap(ow, win) {
						conflict = fmt.Sprintf("与任务 %s 在共享设备 %s 上的窗口 [%d,%d) 重叠",
							jj.ID, j.Equipment, ow.Start, ow.End)
						break
					}
				}
			}
			if conflict != "" {
				lines = append(lines, fmt.Sprintf("  - 窗口 [%d,%d) 费用 %d：%s", win.Start, win.End, win.Cost, conflict))
			} else if win.Cost >= j.Penalty {
				lines = append(lines, fmt.Sprintf("  - 窗口 [%d,%d) 费用 %d：本身可行，但不低于罚费 %d，放弃更省",
					win.Start, win.End, win.Cost, j.Penalty))
			} else {
				lines = append(lines, fmt.Sprintf("  - 窗口 [%d,%d) 费用 %d：本身可行且低于罚费 %d（提示：解可能非最优）",
					win.Start, win.End, win.Cost, j.Penalty))
			}
		}
	}
	return lines
}

// CheckSolution 独立校验解的可行性与费用，供测试使用。
func CheckSolution(p *Problem, s *Solution) error {
	if len(s.Assign) != len(p.Jobs) {
		return errors.New("解长度与任务数不符")
	}
	_, preds, err := topoOrder(p)
	if err != nil {
		return err
	}
	for i, a := range s.Assign {
		if a < -1 || a >= len(p.Jobs[i].Windows) {
			return fmt.Errorf("任务 %s 安排下标非法", p.Jobs[i].ID)
		}
	}
	for j := range p.Jobs {
		if s.Assign[j] == -1 {
			continue
		}
		wj := p.Jobs[j].Windows[s.Assign[j]]
		for _, pr := range preds[j] {
			if s.Assign[pr] == -1 {
				return fmt.Errorf("任务 %s 的前项 %s 被放弃", p.Jobs[j].ID, p.Jobs[pr].ID)
			}
			if p.Jobs[pr].Windows[s.Assign[pr]].End > wj.Start {
				return fmt.Errorf("任务 %s 开始前项 %s 未完成", p.Jobs[j].ID, p.Jobs[pr].ID)
			}
		}
		for i := 0; i < j; i++ {
			if s.Assign[i] == -1 || p.Jobs[i].Equipment != p.Jobs[j].Equipment {
				continue
			}
			if overlap(p.Jobs[i].Windows[s.Assign[i]], wj) {
				return fmt.Errorf("任务 %s 与 %s 在设备 %s 上重叠", p.Jobs[i].ID, p.Jobs[j].ID, p.Jobs[j].Equipment)
			}
		}
	}
	if got := costOf(p, s.Assign); got != s.Cost {
		return fmt.Errorf("费用不符：记录 %d，实算 %d", s.Cost, got)
	}
	return nil
}
