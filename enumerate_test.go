package main

import (
	"math"
	"math/rand"
	"testing"
)

func TestEnumerateCounts(t *testing.T) {
	p := &Problem{
		Cars:  []Car{{ID: "a"}, {ID: "b"}, {ID: "c"}, {ID: "d"}},
		Types: []TrainType{{Name: "通", Cost: 5, AllowHazmat: true}},
	}
	enum := Enumerate(p)
	if enum.Total != 8 {
		t.Fatalf("4 节车厢应有 2^3=8 种切分，得到 %d", enum.Total)
	}
	if enum.Feasible != 8 {
		t.Fatalf("无约束下全部切分可行，得到 %d", enum.Feasible)
	}
	if enum.Best == nil || enum.Best.Cost != 5 || enum.Best.Trains != 1 {
		t.Fatalf("最优应为 1 列费用 5，得到 %+v", enum.Best)
	}
}

// 随机小规模问题上交叉验证：DP 结果必须与穷举一致。
func TestEnumerateMatchesDP(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	haz := []string{"", "", "A", "B"}
	for trial := 0; trial < 200; trial++ {
		n := 1 + rng.Intn(8)
		p := &Problem{Incompatible: [][2]string{{"A", "B"}}}
		for i := 0; i < n; i++ {
			p.Cars = append(p.Cars, Car{
				ID:     string(rune('a' + i)),
				Length: float64(1 + rng.Intn(15)),
				Weight: float64(1 + rng.Intn(40)),
				Hazmat: haz[rng.Intn(len(haz))],
			})
		}
		for k := 0; k < 1+rng.Intn(3); k++ {
			p.Types = append(p.Types, TrainType{
				Name:        string(rune('T' + k)),
				MaxCars:     rng.Intn(5),
				MaxLength:   float64(rng.Intn(60)),
				MaxWeight:   float64(rng.Intn(120)),
				Cost:        float64(1 + rng.Intn(200)),
				AllowHazmat: rng.Intn(2) == 0,
			})
		}
		if err := p.Validate(); err != nil {
			t.Fatal(err)
		}
		sol, err := Solve(p)
		enum := Enumerate(p)
		if err != nil {
			if enum.Best != nil {
				t.Fatalf("trial %d: DP 判不可行但穷举找到 %.2f", trial, enum.Best.Cost)
			}
			continue
		}
		if enum.Best == nil {
			t.Fatalf("trial %d: DP 找到 %.2f 但穷举无可行解", trial, sol.Cost)
		}
		if math.Abs(sol.Cost-enum.Best.Cost) > eps || sol.Trains != enum.Best.Trains {
			t.Fatalf("trial %d: DP(%.2f,%d) != 穷举(%.2f,%d)",
				trial, sol.Cost, sol.Trains, enum.Best.Cost, enum.Best.Trains)
		}
	}
}

func TestEnumerateAllInfeasible(t *testing.T) {
	p := &Problem{
		Cars:         []Car{{ID: "a", Hazmat: "A"}, {ID: "b", Hazmat: "B"}},
		Incompatible: [][2]string{{"A", "B"}},
		Types:        []TrainType{{Name: "禁危", Cost: 1, AllowHazmat: false}},
	}
	enum := Enumerate(p)
	if enum.Feasible != 0 || enum.Best != nil {
		t.Fatalf("全部不可行：Feasible=%d, Best=%v", enum.Feasible, enum.Best)
	}
}
