package main

import (
	"math/rand"
	"testing"
)

func mustSolve(t *testing.T, p *Problem) *Solution {
	t.Helper()
	s, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve 出错: %v", err)
	}
	if err := CheckSolution(p, s); err != nil {
		t.Fatalf("解不可行: %v", err)
	}
	return s
}

// 手工可算的小例子：B 依赖 A，A/B 共享 crane。
func TestHandComputed(t *testing.T) {
	p := &Problem{Jobs: []Job{
		{ID: "A", Equipment: "crane", Penalty: 20,
			Windows: []Window{{0, 4, 5}, {6, 10, 3}}},
		{ID: "B", Equipment: "crane", DependsOn: []string{"A"}, Penalty: 8,
			Windows: []Window{{4, 7, 6}, {10, 13, 2}}},
	}}
	s := mustSolve(t, p)
	// 全部安排：A[0,4)+B[4,7)=11，A[6,10)+B[10,13)=5，最优为 5。
	if s.Cost != 5 {
		t.Fatalf("期望费用 5，得到 %d（安排 %v）", s.Cost, s.Assign)
	}
}

// 半开窗口：首尾相接不算重叠。
func TestHalfOpenAdjacency(t *testing.T) {
	p := &Problem{Jobs: []Job{
		{ID: "A", Equipment: "eq", Penalty: 100, Windows: []Window{{0, 5, 1}}},
		{ID: "B", Equipment: "eq", Penalty: 100, Windows: []Window{{5, 9, 1}}},
	}}
	s := mustSolve(t, p)
	if s.Cost != 2 {
		t.Fatalf("半开窗口应允许相接，期望费用 2，得到 %d", s.Cost)
	}
}

// 前项被放弃时后项必须放弃。
func TestDependencyDropCascade(t *testing.T) {
	p := &Problem{Jobs: []Job{
		{ID: "A", Equipment: "e1", Penalty: 1, Windows: []Window{{0, 3, 50}}},
		{ID: "B", Equipment: "e2", DependsOn: []string{"A"}, Penalty: 2,
			Windows: []Window{{3, 5, 1}}},
	}}
	s := mustSolve(t, p)
	// A 安排需 50，放弃仅 1；A 放弃则 B 必须放弃。总费 1+2=3。
	if s.Cost != 3 || s.Assign[0] != -1 || s.Assign[1] != -1 {
		t.Fatalf("期望两者放弃、费用 3，得到费用 %d 安排 %v", s.Cost, s.Assign)
	}
}

// 依赖未完成则后项不能占用过早窗口。
func TestDependencyTiming(t *testing.T) {
	p := &Problem{Jobs: []Job{
		{ID: "A", Equipment: "e1", Penalty: 100, Windows: []Window{{0, 6, 1}}},
		{ID: "B", Equipment: "e2", DependsOn: []string{"A"}, Penalty: 100,
			Windows: []Window{{2, 4, 1}, {6, 8, 5}}},
	}}
	s := mustSolve(t, p)
	// B 的 [2,4) 在 A 完成前，只能选 [6,8)。总费 1+5=6。
	if s.Cost != 6 || s.Assign[1] != 1 {
		t.Fatalf("期望费用 6 且 B 选窗口 1，得到费用 %d 安排 %v", s.Cost, s.Assign)
	}
}

// 共享设备冲突时，放弃罚费低者更优。
func TestEquipmentConflictDrop(t *testing.T) {
	p := &Problem{Jobs: []Job{
		{ID: "A", Equipment: "eq", Penalty: 3, Windows: []Window{{0, 5, 10}}},
		{ID: "B", Equipment: "eq", Penalty: 50, Windows: []Window{{2, 7, 1}}},
	}}
	s := mustSolve(t, p)
	// 两者窗口重叠：安排 A+B 不可行；放弃 A 费用 3+1=4 优于放弃 B 的 10+50。
	if s.Cost != 4 || s.Assign[0] != -1 || s.Assign[1] != 0 {
		t.Fatalf("期望放弃 A、费用 4，得到费用 %d 安排 %v", s.Cost, s.Assign)
	}
}

func TestDependencyCycle(t *testing.T) {
	p := &Problem{Jobs: []Job{
		{ID: "A", Equipment: "e", Penalty: 1, DependsOn: []string{"B"}, Windows: []Window{{0, 1, 1}}},
		{ID: "B", Equipment: "e", Penalty: 1, DependsOn: []string{"A"}, Windows: []Window{{0, 1, 1}}},
	}}
	if _, err := Solve(p); err == nil {
		t.Fatal("依赖环应报错")
	}
}

func TestValidation(t *testing.T) {
	bad := &Problem{Jobs: []Job{
		{ID: "A", Equipment: "e", Penalty: 1, Windows: []Window{{5, 5, 1}}},
	}}
	if _, err := Solve(bad); err == nil {
		t.Fatal("空窗口应报错")
	}
	tooMany := &Problem{}
	for i := 0; i < MaxJobs+1; i++ {
		tooMany.Jobs = append(tooMany.Jobs, Job{
			ID: string(rune('a' + i)), Equipment: "e", Penalty: 1,
			Windows: []Window{{0, 1, 1}},
		})
	}
	if _, err := Solve(tooMany); err == nil {
		t.Fatal("超过 16 项应报错")
	}
}

// 随机小数据：分支定界结果必须与完整枚举一致。
func TestRandomAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(8) // 1..8 项
		equips := []string{"e1", "e2", "e3"}
		p := &Problem{}
		for i := 0; i < n; i++ {
			j := Job{
				ID:        string(rune('A' + i)),
				Equipment: equips[rng.Intn(len(equips))],
				Penalty:   rng.Intn(20),
			}
			// 仅依赖更早任务，保证无环。
			for k := 0; k < i; k++ {
				if rng.Float64() < 0.25 {
					j.DependsOn = append(j.DependsOn, string(rune('A'+k)))
				}
			}
			nw := 1 + rng.Intn(3)
			for w := 0; w < nw; w++ {
				start := rng.Intn(15)
				j.Windows = append(j.Windows, Window{
					Start: start,
					End:   start + 1 + rng.Intn(5),
					Cost:  rng.Intn(20),
				})
			}
			p.Jobs = append(p.Jobs, j)
		}
		s := mustSolve(t, p)
		bf, err := BruteForce(p)
		if err != nil {
			t.Fatalf("BruteForce 出错: %v", err)
		}
		if err := CheckSolution(p, bf); err != nil {
			t.Fatalf("枚举解不可行: %v", err)
		}
		if s.Cost != bf.Cost {
			t.Fatalf("第 %d 例不一致：分支定界 %d，枚举 %d\n问题: %+v", trial, s.Cost, bf.Cost, p.Jobs)
		}
	}
}

// 16 项上限规模也可在合理时间内求解。
func TestSixteenJobs(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	p := &Problem{}
	for i := 0; i < MaxJobs; i++ {
		j := Job{
			ID:        string(rune('A' + i)),
			Equipment: []string{"e1", "e2"}[rng.Intn(2)],
			Penalty:   5 + rng.Intn(20),
		}
		if i > 0 && rng.Float64() < 0.5 {
			j.DependsOn = []string{string(rune('A' + rng.Intn(i)))}
		}
		for w := 0; w < 3; w++ {
			start := rng.Intn(30)
			j.Windows = append(j.Windows, Window{start, start + 2 + rng.Intn(4), rng.Intn(15)})
		}
		p.Jobs = append(p.Jobs, j)
	}
	mustSolve(t, p)
}
