package main

import (
	"math/rand"
	"strings"
	"testing"
)

// computeCost 计算一个安排的总费用。
func computeCost(p *Problem, a Assignment) int {
	total := 0
	for i, t := range p.Tasks {
		if a[i] < 0 {
			total += t.Penalty
		} else {
			total += t.Windows[a[i]].Cost
		}
	}
	return total
}

// checkFeasible 校验安排是否满足全部约束。
func checkFeasible(t *testing.T, p *Problem, a Assignment) {
	t.Helper()
	idx := map[string]int{}
	for i, task := range p.Tasks {
		idx[task.ID] = i
	}
	for i, task := range p.Tasks {
		if a[i] < 0 {
			continue
		}
		w := task.Windows[a[i]]
		for _, d := range task.Deps {
			j := idx[d]
			if a[j] < 0 {
				t.Fatalf("任务 %s 已排程但前置 %s 被放弃", task.ID, d)
			}
			dw := p.Tasks[j].Windows[a[j]]
			if dw.End > w.Start {
				t.Fatalf("任务 %s 开始于 %d，但前置 %s 完成于 %d", task.ID, w.Start, d, dw.End)
			}
		}
		for j := i + 1; j < len(p.Tasks); j++ {
			if a[j] < 0 || p.Tasks[j].Equipment != task.Equipment {
				continue
			}
			if overlap(w, p.Tasks[j].Windows[a[j]]) {
				t.Fatalf("任务 %s 与 %s 在设备 %s 上时间重叠", task.ID, p.Tasks[j].ID, task.Equipment)
			}
		}
	}
}

func solveAndCheck(t *testing.T, p *Problem, wantCost int) Solution {
	t.Helper()
	_, order, err := p.validate()
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	sol := Solve(p, order)
	if sol.Cost != wantCost {
		t.Fatalf("Solve 费用 = %d，期望 %d（安排 %v）", sol.Cost, wantCost, sol.Assign)
	}
	checkFeasible(t, p, sol.Assign)
	if got := computeCost(p, sol.Assign); got != sol.Cost {
		t.Fatalf("费用不一致: 安排重算 %d，报告 %d", got, sol.Cost)
	}
	return sol
}

func TestDependencyOrder(t *testing.T) {
	// B 依赖 A：A 只有晚窗口可行时，B 必须选更晚的窗口
	p := &Problem{Tasks: []Task{
		{ID: "A", Equipment: "e1", Penalty: 100, Windows: []Window{{Start: 5, End: 8, Cost: 3}}},
		{ID: "B", Equipment: "e2", Penalty: 100, Windows: []Window{
			{Start: 0, End: 4, Cost: 1}, // 早于 A 完成，不可行
			{Start: 8, End: 10, Cost: 5},
		}, Deps: []string{"A"}},
	}}
	sol := solveAndCheck(t, p, 8)
	if sol.Assign[1] != 1 {
		t.Fatalf("B 应选窗口 1，实际 %v", sol.Assign)
	}
}

func TestEquipmentConflict(t *testing.T) {
	// 两任务共享设备且窗口重叠，放弃罚费高者更优
	p := &Problem{Tasks: []Task{
		{ID: "A", Equipment: "e1", Penalty: 50, Windows: []Window{{Start: 0, End: 10, Cost: 5}}},
		{ID: "B", Equipment: "e1", Penalty: 8, Windows: []Window{{Start: 3, End: 6, Cost: 4}}},
	}}
	sol := solveAndCheck(t, p, 5+8) // 排 A，放弃 B
	if sol.Assign[0] != 0 || sol.Assign[1] != -1 {
		t.Fatalf("安排不符预期: %v", sol.Assign)
	}
}

func TestAbandonCheaperThanWindows(t *testing.T) {
	p := &Problem{Tasks: []Task{
		{ID: "A", Equipment: "e1", Penalty: 3, Windows: []Window{
			{Start: 0, End: 2, Cost: 10},
			{Start: 5, End: 9, Cost: 7},
		}},
	}}
	sol := solveAndCheck(t, p, 3)
	if sol.Assign[0] != -1 {
		t.Fatalf("A 应被放弃，实际 %v", sol.Assign)
	}
}

func TestAbandonedDepPropagates(t *testing.T) {
	// A 罚费极低必被放弃，B 依赖 A 因而也只能放弃
	p := &Problem{Tasks: []Task{
		{ID: "A", Equipment: "e1", Penalty: 1, Windows: []Window{{Start: 0, End: 5, Cost: 100}}},
		{ID: "B", Equipment: "e2", Penalty: 2, Windows: []Window{{Start: 5, End: 6, Cost: 1}}, Deps: []string{"A"}},
	}}
	sol := solveAndCheck(t, p, 3)
	if sol.Assign[0] != -1 || sol.Assign[1] != -1 {
		t.Fatalf("两者均应放弃，实际 %v", sol.Assign)
	}
}

func TestHalfOpenBoundary(t *testing.T) {
	// 半开区间：一个任务结束时刻等于另一个开始时刻，不算重叠
	p := &Problem{Tasks: []Task{
		{ID: "A", Equipment: "e1", Penalty: 100, Windows: []Window{{Start: 0, End: 5, Cost: 2}}},
		{ID: "B", Equipment: "e1", Penalty: 100, Windows: []Window{{Start: 5, End: 9, Cost: 3}}},
	}}
	sol := solveAndCheck(t, p, 5)
	if sol.Assign[0] != 0 || sol.Assign[1] != 0 {
		t.Fatalf("两者都应排程，实际 %v", sol.Assign)
	}
}

func TestSixteenTasksSharedEquipment(t *testing.T) {
	// 16 项任务共用一台设备且窗口完全重叠：至多排一项。
	// 最优 = 总罚费 - max(0, 最大节省(罚费-费用))。
	p := &Problem{}
	sumPenalty, bestSave := 0, 0
	for i := 0; i < 16; i++ {
		cost := 2 + i%5
		penalty := 10 + i
		p.Tasks = append(p.Tasks, Task{
			ID:        string(rune('A' + i)),
			Equipment: "e1",
			Penalty:   penalty,
			Windows:   []Window{{Start: 0, End: 10, Cost: cost}},
		})
		sumPenalty += penalty
		if s := penalty - cost; s > bestSave {
			bestSave = s
		}
	}
	solveAndCheck(t, p, sumPenalty-bestSave)
}

func TestSixteenTaskChain(t *testing.T) {
	// 16 项任务连成依赖链，每项两个窗口，仅晚窗口满足依赖。
	p := &Problem{}
	for i := 0; i < 16; i++ {
		tk := Task{
			ID:        string(rune('A' + i)),
			Equipment: "e" + string(rune('a'+i)),
			Penalty:   1000,
			Windows: []Window{
				{Start: 0, End: 1, Cost: 1},
				{Start: 10 * i, End: 10*i + 2, Cost: 2},
			},
		}
		if i > 0 {
			tk.Deps = []string{string(rune('A' + i - 1))}
		}
		p.Tasks = append(p.Tasks, tk)
	}
	solveAndCheck(t, p, 1+15*2) // 首项可选早窗口，其余必须晚窗口
}

func TestSolveMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(6) // 1..6 项，保证枚举规模可控
		p := &Problem{}
		for i := 0; i < n; i++ {
			nw := 1 + rng.Intn(3)
			tk := Task{
				ID:        string(rune('A' + i)),
				Equipment: string(rune('x' + rng.Intn(2))),
				Penalty:   rng.Intn(40),
			}
			for k := 0; k < nw; k++ {
				s := rng.Intn(20)
				tk.Windows = append(tk.Windows, Window{Start: s, End: s + 1 + rng.Intn(6), Cost: rng.Intn(30)})
			}
			for j := 0; j < i; j++ {
				if rng.Float64() < 0.3 {
					tk.Deps = append(tk.Deps, string(rune('A'+j)))
				}
			}
			p.Tasks = append(p.Tasks, tk)
		}
		_, order, err := p.validate()
		if err != nil {
			t.Fatalf("validate: %v", err)
		}
		got := Solve(p, order)
		want := BruteForce(p, order)
		if got.Cost != want.Cost {
			t.Fatalf("trial %d: Solve=%d, BruteForce=%d\n问题: %+v", trial, got.Cost, want.Cost, p)
		}
		checkFeasible(t, p, got.Assign)
		if c := computeCost(p, got.Assign); c != got.Cost {
			t.Fatalf("trial %d: 安排费用 %d 与报告费用 %d 不符", trial, c, got.Cost)
		}
	}
}

func TestValidation(t *testing.T) {
	cases := []struct {
		name string
		p    Problem
	}{
		{"空任务", Problem{}},
		{"重复ID", Problem{Tasks: []Task{
			{ID: "A", Equipment: "e", Windows: []Window{{0, 1, 1}}},
			{ID: "A", Equipment: "e", Windows: []Window{{0, 1, 1}}},
		}}},
		{"依赖环", Problem{Tasks: []Task{
			{ID: "A", Equipment: "e", Windows: []Window{{0, 1, 1}}, Deps: []string{"B"}},
			{ID: "B", Equipment: "e", Windows: []Window{{0, 1, 1}}, Deps: []string{"A"}},
		}}},
		{"未知依赖", Problem{Tasks: []Task{
			{ID: "A", Equipment: "e", Windows: []Window{{0, 1, 1}}, Deps: []string{"Z"}},
		}}},
		{"非法窗口", Problem{Tasks: []Task{
			{ID: "A", Equipment: "e", Windows: []Window{{5, 5, 1}}},
		}}},
	}
	for _, c := range cases {
		if _, _, err := c.p.validate(); err == nil {
			t.Errorf("%s: 期望校验失败", c.name)
		}
	}
	// 超过 16 项
	big := Problem{}
	for i := 0; i < 17; i++ {
		big.Tasks = append(big.Tasks, Task{ID: string(rune('A' + i)), Equipment: "e", Windows: []Window{{0, 1, 1}}})
	}
	if _, _, err := big.validate(); err == nil {
		t.Errorf("超过 16 项任务应校验失败")
	}
}

func TestExplain(t *testing.T) {
	p := &Problem{Tasks: []Task{
		{ID: "A", Equipment: "e1", Penalty: 50, Windows: []Window{{Start: 0, End: 10, Cost: 5}}},
		{ID: "B", Equipment: "e1", Penalty: 8, Windows: []Window{{Start: 3, End: 6, Cost: 4}}},
	}}
	_, order, _ := p.validate()
	sol := Solve(p, order)
	lines := Explain(p, sol)
	if len(lines) != 2 {
		t.Fatalf("解释行数 = %d，期望 2", len(lines))
	}
	// B 被放弃，解释中应提及与 A 的冲突
	found := false
	for _, l := range lines {
		if strings.HasPrefix(l, "任务 B：") && strings.Contains(l, "冲突") {
			found = true
		}
	}
	if !found {
		t.Errorf("未找到 B 的冲突解释: %v", lines)
	}
}
