package main

import (
	"math/rand"
	"testing"
)

// 半开边界：窗口 [1,3)、时长 2 => 唯一可行起点 s=1（1+2<=3），
// 占用时刻 1,2，时刻 3 不占用。
func TestHalfOpenWindowLatestStart(t *testing.T) {
	p := Problem{
		K:    1,
		Loss: []int{1, 1, 1, 1, 1},
		Devices: []Device{
			{Dur: 2, Start: 1, End: 3},
		},
	}
	ok, cost, starts, occ := Solve(p)
	if !ok {
		t.Fatal("expected feasible")
	}
	if starts[0] != 1 {
		t.Fatalf("start = %d, want 1 (s+Dur<=End 半开边界)", starts[0])
	}
	want := []int{0, 1, 1, 0, 0}
	for i := range want {
		if occ[i] != want[i] {
			t.Fatalf("occ = %v, want %v（时刻 %d 不应被占用）", occ, want, 3)
		}
	}
	if cost != 2 {
		t.Fatalf("cost = %d, want 2", cost)
	}
}

// 半开边界：占用 [s, s+Dur)，结束时刻 s+Dur 本身不计入占用。
func TestHalfOpenOccupancyEnd(t *testing.T) {
	p := Problem{
		K:    2,
		Loss: []int{0, 0, 0, 0, 0, 0},
		Devices: []Device{
			{Dur: 3, Start: 2, End: 5}, // 唯一起点 s=2，占用 2,3,4
		},
	}
	ok, _, starts, occ := Solve(p)
	if !ok {
		t.Fatal("expected feasible")
	}
	if starts[0] != 2 {
		t.Fatalf("start = %d, want 2", starts[0])
	}
	if occ[4] != 1 || occ[5] != 0 || occ[1] != 0 {
		t.Fatalf("occ = %v, 占用应恰为时刻 2,3,4", occ)
	}
}

// K=1 时两台设备必须串行，占用曲线峰值 <=1。
func TestConcurrencyLimit(t *testing.T) {
	p := Problem{
		K:    1,
		Loss: []int{1, 1, 1, 1},
		Devices: []Device{
			{Dur: 2, Start: 0, End: 4},
			{Dur: 2, Start: 0, End: 4},
		},
	}
	ok, cost, _, occ := Solve(p)
	if !ok {
		t.Fatal("expected feasible")
	}
	for tm, o := range occ {
		if o > 1 {
			t.Fatalf("occ[%d] = %d 超过 K=1", tm, o)
		}
	}
	if cost != 4 {
		t.Fatalf("cost = %d, want 4", cost)
	}
}

// 损失低谷选择：时长 1 的设备应落在损失最小的时刻。
func TestLossValley(t *testing.T) {
	p := Problem{
		K:    1,
		Loss: []int{5, 5, 1, 5},
		Devices: []Device{
			{Dur: 1, Start: 0, End: 4},
		},
	}
	ok, cost, starts, _ := Solve(p)
	if !ok || starts[0] != 2 || cost != 1 {
		t.Fatalf("ok=%v start=%d cost=%d, want start=2 cost=1", ok, starts[0], cost)
	}
}

// 重叠损失按台数累计：两台同时停机时该时刻损失翻倍。
func TestOverlapCostScales(t *testing.T) {
	p := Problem{
		K:    2,
		Loss: []int{3, 3},
		Devices: []Device{
			{Dur: 2, Start: 0, End: 2},
			{Dur: 2, Start: 0, End: 2},
		},
	}
	ok, cost, _, occ := Solve(p)
	if !ok {
		t.Fatal("expected feasible")
	}
	if occ[0] != 2 || occ[1] != 2 {
		t.Fatalf("occ = %v, want [2 2]", occ)
	}
	if cost != 12 { // (2+2)*3
		t.Fatalf("cost = %d, want 12", cost)
	}
}

// 不可行：K=1 时窗内放不下两台时长 3 的设备。
func TestInfeasible(t *testing.T) {
	p := Problem{
		K:    1,
		Loss: []int{1, 1, 1},
		Devices: []Device{
			{Dur: 3, Start: 0, End: 3},
			{Dur: 3, Start: 0, End: 3},
		},
	}
	if ok, _, _, _ := Solve(p); ok {
		t.Fatal("expected infeasible")
	}
	if ok, _, _ := Brute(p); ok {
		t.Fatal("brute: expected infeasible")
	}
}

// 非法输入：窗口超出时域。
func TestInvalidWindow(t *testing.T) {
	p := Problem{
		K:    1,
		Loss: []int{1, 1},
		Devices: []Device{
			{Dur: 1, Start: 0, End: 3}, // End > T
		},
	}
	if ok, _, _, _ := Solve(p); ok {
		t.Fatal("expected invalid input rejected")
	}
}

// 短时域随机穷举核验：DP 与 Brute 的最优值/可行性必须一致，
// 且 DP 解自身满足 K 约束、半开窗约束与成本一致。
func TestBruteForceCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 500; iter++ {
		T := 1 + rng.Intn(8)
		n := 1 + rng.Intn(4)
		p := Problem{K: 1 + rng.Intn(3), Loss: make([]int, T)}
		for t := range p.Loss {
			p.Loss[t] = rng.Intn(10)
		}
		for i := 0; i < n; i++ {
			dur := 1 + rng.Intn(min(3, T))
			lo := rng.Intn(T - dur + 1)
			hi := lo + dur + rng.Intn(T-dur-lo+1) // hi <= T, hi >= lo+dur
			p.Devices = append(p.Devices, Device{Dur: dur, Start: lo, End: hi})
		}

		okDP, costDP, starts, occ := Solve(p)
		okBF, costBF, _ := Brute(p)
		if okDP != okBF {
			t.Fatalf("iter %d: feasibility mismatch dp=%v brute=%v\n%+v", iter, okDP, okBF, p)
		}
		if !okDP {
			continue
		}
		if costDP != costBF {
			t.Fatalf("iter %d: cost mismatch dp=%d brute=%d\n%+v", iter, costDP, costBF, p)
		}
		// 校验 DP 解的约束与成本
		for i, s := range starts {
			d := p.Devices[i]
			if s < d.Start || s+d.Dur > d.End {
				t.Fatalf("iter %d: device %d start %d 违反半开窗 [%d,%d)", iter, i, s, d.Start, d.End)
			}
		}
		total := 0
		for tm, o := range occ {
			if o > p.K {
				t.Fatalf("iter %d: occ[%d]=%d 超过 K=%d", iter, tm, o, p.K)
			}
			total += p.Loss[tm] * o
		}
		if total != costDP {
			t.Fatalf("iter %d: occ 曲线成本 %d != 报告成本 %d", iter, total, costDP)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
