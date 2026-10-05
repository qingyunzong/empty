package main

import (
	"math"
	"testing"
)

func TestValidate(t *testing.T) {
	p := &Problem{}
	if err := p.Validate(); err == nil {
		t.Fatal("空问题应报错")
	}
	cars := make([]Car, MaxCarsAllowed+1)
	for i := range cars {
		cars[i] = Car{ID: string(rune('A' + i))}
	}
	p = &Problem{Cars: cars, Types: []TrainType{{Name: "x"}}}
	if err := p.Validate(); err == nil {
		t.Fatalf("超过 %d 节车厢应报错", MaxCarsAllowed)
	}
	p = &Problem{Cars: []Car{{ID: "a"}, {ID: "a"}}, Types: []TrainType{{Name: "x"}}}
	if err := p.Validate(); err == nil {
		t.Fatal("车厢 id 重复应报错")
	}
	p = &Problem{Cars: []Car{{ID: "a"}}}
	if err := p.Validate(); err == nil {
		t.Fatal("缺少车型应报错")
	}
}

func TestFeasibleLimits(t *testing.T) {
	p := &Problem{
		Cars: []Car{
			{ID: "a", Length: 10, Weight: 10},
			{ID: "b", Length: 10, Weight: 10},
			{ID: "c", Length: 10, Weight: 10},
		},
		Types: []TrainType{
			{Name: "限长", MaxLength: 15, Cost: 1, AllowHazmat: true},
			{Name: "限重", MaxWeight: 15, Cost: 1, AllowHazmat: true},
			{Name: "限节", MaxCars: 1, Cost: 1, AllowHazmat: true},
			{Name: "宽松", Cost: 1, AllowHazmat: true},
		},
	}
	s := newSolver(p)
	if ok, _ := s.feasible(0, 2, p.Types[0]); ok {
		t.Error("长度超限却判可行")
	}
	if ok, _ := s.feasible(0, 2, p.Types[1]); ok {
		t.Error("重量超限却判可行")
	}
	if ok, _ := s.feasible(0, 2, p.Types[2]); ok {
		t.Error("车厢数超限却判可行")
	}
	if ok, _ := s.feasible(0, 3, p.Types[3]); !ok {
		t.Error("宽松车型应可行")
	}
}

func TestFeasibleHazmat(t *testing.T) {
	p := &Problem{
		Cars: []Car{
			{ID: "a", Hazmat: "A"},
			{ID: "b", Hazmat: "B"},
			{ID: "c"},
			{ID: "d", Hazmat: "B"},
		},
		Incompatible: [][2]string{{"A", "B"}},
		Types: []TrainType{
			{Name: "普", Cost: 1, AllowHazmat: true},
			{Name: "净", Cost: 1, AllowHazmat: false},
		},
	}
	s := newSolver(p)
	if ok, why := s.feasible(0, 2, p.Types[0]); ok {
		t.Error("A 与 B 相邻应不可行")
	} else if why == "" {
		t.Error("不可行应给出原因")
	}
	// 不相容是无序对：B 后接 A 同样禁止。
	p.Cars[0], p.Cars[1] = p.Cars[1], p.Cars[0]
	s = newSolver(p)
	if ok, _ := s.feasible(0, 2, p.Types[0]); ok {
		t.Error("B 与 A 相邻（反向）应不可行")
	}
	// 中间隔一节非危险品则相邻约束不触发。
	p.Cars = []Car{{ID: "a", Hazmat: "A"}, {ID: "x"}, {ID: "b", Hazmat: "B"}}
	s = newSolver(p)
	if ok, _ := s.feasible(0, 3, p.Types[0]); !ok {
		t.Error("A 与 B 不相邻时应可行")
	}
	// 禁止危险品的车型。
	if ok, _ := s.feasible(0, 3, p.Types[1]); ok {
		t.Error("含危险品区间对禁危车型应不可行")
	}
	if ok, _ := s.feasible(1, 2, p.Types[1]); !ok {
		t.Error("纯非危险品区间对禁危车型应可行")
	}
}

func TestSolveOptimal(t *testing.T) {
	// 3 节车厢，两种车型：单节 10、任意段 25。
	// 最优：三段各 10 共 30，或一段 25 → 一段 25 费用更低。
	p := &Problem{
		Cars:  []Car{{ID: "a"}, {ID: "b"}, {ID: "c"}},
		Types: []TrainType{{Name: "单", MaxCars: 1, Cost: 10, AllowHazmat: true}, {Name: "通", Cost: 25, AllowHazmat: true}},
	}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if sol.Cost != 25 || sol.Trains != 1 {
		t.Fatalf("期望费用 25、1 列，得到 %.2f、%d 列", sol.Cost, sol.Trains)
	}
}

func TestSolveTieBreakFewerTrains(t *testing.T) {
	// 两种切分费用相同（2×10 = 1×20），应选列车数更少者。
	p := &Problem{
		Cars:  []Car{{ID: "a"}, {ID: "b"}},
		Types: []TrainType{{Name: "单", MaxCars: 1, Cost: 10, AllowHazmat: true}, {Name: "双", MaxCars: 2, Cost: 20, AllowHazmat: true}},
	}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if sol.Trains != 1 || math.Abs(sol.Cost-20) > eps {
		t.Fatalf("费用相同应选列车数少：期望 1 列 20，得到 %d 列 %.2f", sol.Trains, sol.Cost)
	}
}

func TestSolveInfeasible(t *testing.T) {
	p := &Problem{
		Cars:  []Car{{ID: "a", Weight: 100}},
		Types: []TrainType{{Name: "小", MaxWeight: 10, Cost: 1, AllowHazmat: true}},
	}
	if _, err := Solve(p); err == nil {
		t.Fatal("无可行方案应报错")
	}
}

func TestSolveRespectsOrderAndContiguity(t *testing.T) {
	p := demoProblem()
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	pos := 0
	for _, seg := range sol.Segments {
		if seg.Start != pos {
			t.Fatalf("分段不连续：期望起点 %d，得到 %d", pos, seg.Start)
		}
		pos = seg.End
	}
	if pos != len(p.Cars) {
		t.Fatalf("分段未覆盖全部车厢：覆盖到 %d/%d", pos, len(p.Cars))
	}
}
