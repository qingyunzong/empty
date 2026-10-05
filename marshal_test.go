package main

import (
	"bytes"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sampleProblem() Problem {
	return Problem{
		MaxLength: 30,
		MaxWeight: 120,
		TrainBase: 10,
		TypeCost:  map[string]float64{"box": 3, "tank": 5, "flat": 2},
		Cars: []Car{
			{ID: "C1", Type: "box", Length: 12, Weight: 40},
			{ID: "C2", Type: "box", Length: 12, Weight: 40},
			{ID: "C3", Type: "tank", Length: 10, Weight: 50, Hazard: 3},
			{ID: "C4", Type: "tank", Length: 10, Weight: 50, Hazard: 3},
			{ID: "C5", Type: "flat", Length: 14, Weight: 30},
			{ID: "C6", Type: "box", Length: 12, Weight: 45},
		},
	}
}

func TestValidate(t *testing.T) {
	p := sampleProblem()
	if err := p.Validate(); err != nil {
		t.Fatalf("合法输入被拒绝: %v", err)
	}

	bad := sampleProblem()
	bad.Cars = nil
	if err := bad.Validate(); err == nil {
		t.Fatal("空车厢列表应报错")
	}

	bad = sampleProblem()
	bad.Cars = make([]Car, MaxCars+1)
	for i := range bad.Cars {
		bad.Cars[i] = Car{ID: "X", Type: "box", Length: 1, Weight: 1}
	}
	if err := bad.Validate(); err == nil {
		t.Fatal("超过 18 节应报错")
	}

	bad = sampleProblem()
	bad.Cars[0].Length = 100
	if err := bad.Validate(); err == nil {
		t.Fatal("单节超限应报错")
	}

	bad = sampleProblem()
	bad.MaxWeight = 0
	if err := bad.Validate(); err == nil {
		t.Fatal("非正上限应报错")
	}
}

func TestFeasibleSegmentLimits(t *testing.T) {
	p := sampleProblem()
	if !p.feasibleSegment(0, 2) { // 24 ≤ 30, 80 ≤ 120
		t.Fatal("C1+C2 应可行")
	}
	if p.feasibleSegment(0, 4) { // 长 44 > 30
		t.Fatal("C1..C4 长度超限，应不可行")
	}
	if p.feasibleSegment(2, 6) { // 重 175 > 120
		t.Fatal("C3..C6 重量超限，应不可行")
	}
}

func TestHazardAdjacency(t *testing.T) {
	p := sampleProblem()
	if !p.feasibleSegment(2, 4) { // 危3 邻 危3，同品类允许
		t.Fatal("同品类危险品相邻应允许")
	}
	p.Cars[3].Hazard = 5 // 危3 邻 危5，不同品类禁止
	if p.feasibleSegment(2, 4) {
		t.Fatal("不同品类危险品相邻应禁止")
	}
	if !p.feasibleSegment(3, 5) { // 危5 邻 非危险品，允许
		t.Fatal("危险品与非危险品相邻应允许")
	}
}

func TestSegmentCost(t *testing.T) {
	p := sampleProblem()
	// C1..C4: 车型 box,tank → 10 + 3 + 5 = 18
	if got := p.segmentCost(0, 4); got != 18 {
		t.Fatalf("segmentCost(0,4) = %v, 期望 18", got)
	}
	// 缺省车型费为 1
	p.TypeCost = nil
	p.TrainBase = 0
	if got := p.segmentCost(0, 4); got != 2 {
		t.Fatalf("缺省费用 segmentCost(0,4) = %v, 期望 2", got)
	}
}

func TestSolveMatchesExhaustive(t *testing.T) {
	p := sampleProblem()
	cuts, val, ok := p.Solve()
	if !ok {
		t.Fatal("样例应有可行解")
	}
	st := p.Exhaustive()
	if math.Abs(val.Cost-st.BestCost) > eps || val.Trains != st.BestTrains {
		t.Fatalf("DP=%+v 与穷举最优(费用 %g, 列数 %d) 不一致", val, st.BestCost, st.BestTrains)
	}
	if _, err := p.ValidateCertificate(cuts); err != nil {
		t.Fatalf("证书校验失败: %v", err)
	}
}

// TestSolveVsExhaustiveRandom 随机对拍：DP 结果必须与穷举最优一致。
func TestSolveVsExhaustiveRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	types := []string{"box", "tank", "flat", "hopper"}
	for trial := 0; trial < 200; trial++ {
		n := 1 + rng.Intn(12)
		p := Problem{
			MaxLength: 20 + rng.Float64()*40,
			MaxWeight: 60 + rng.Float64()*120,
			TrainBase: rng.Float64() * 20,
			TypeCost:  map[string]float64{},
			Cars:      make([]Car, n),
		}
		for _, ty := range types {
			p.TypeCost[ty] = 1 + rng.Float64()*8
		}
		for i := range p.Cars {
			p.Cars[i] = Car{
				ID:     string(rune('A' + i)),
				Type:   types[rng.Intn(len(types))],
				Length: 5 + rng.Float64()*10,
				Weight: 10 + rng.Float64()*30,
				Hazard: rng.Intn(4),
			}
		}
		cuts, val, ok := p.Solve()
		st := p.Exhaustive()
		if st.Feasible == 0 {
			if ok {
				t.Fatalf("trial %d: 穷举无可行解但 DP 有解", trial)
			}
			continue
		}
		if !ok {
			t.Fatalf("trial %d: 穷举有 %d 个可行解但 DP 无解", trial, st.Feasible)
		}
		if math.Abs(val.Cost-st.BestCost) > eps || val.Trains != st.BestTrains {
			t.Fatalf("trial %d: DP=%+v 穷举最优=(%g,%d)", trial, val, st.BestCost, st.BestTrains)
		}
		v, err := p.ValidateCertificate(cuts)
		if err != nil {
			t.Fatalf("trial %d: 证书无效: %v", trial, err)
		}
		if math.Abs(v.Cost-val.Cost) > eps || v.Trains != val.Trains {
			t.Fatalf("trial %d: 证书重算 %+v 与 DP %+v 不符", trial, v, val)
		}
	}
}

func TestTieBreakFewerTrains(t *testing.T) {
	// 两种切分费用相同：列数少者胜出。
	p := Problem{
		MaxLength: 100,
		MaxWeight: 100,
		TrainBase: 0,
		TypeCost:  map[string]float64{"box": 5},
		Cars: []Car{
			{ID: "A", Type: "box", Length: 10, Weight: 10},
			{ID: "B", Type: "box", Length: 10, Weight: 10},
		},
	}
	cuts, val, ok := p.Solve()
	if !ok {
		t.Fatal("应有解")
	}
	if val.Trains != 1 || len(cuts) != 2 {
		t.Fatalf("同费用应选列数少者, got cuts=%v val=%+v", cuts, val)
	}
	if val.Cost != 5 {
		t.Fatalf("费用应为 5, got %v", val.Cost)
	}
}

func TestCostPrefersGroupingSameType(t *testing.T) {
	// box,flat,box：同车型聚在一起更省（box 费只计一次），
	// 但保序约束下 [box][flat,box] 等切分费用更高，验证最优把两节 box 分在不同列也不拆分 flat。
	p := Problem{
		MaxLength: 100,
		MaxWeight: 100,
		TrainBase: 1,
		TypeCost:  map[string]float64{"box": 4, "flat": 1},
		Cars: []Car{
			{ID: "A", Type: "box", Length: 10, Weight: 10},
			{ID: "B", Type: "flat", Length: 10, Weight: 10},
			{ID: "C", Type: "box", Length: 10, Weight: 10},
		},
	}
	cuts, val, ok := p.Solve()
	if !ok {
		t.Fatal("应有解")
	}
	// 全部一列: 1+4+1=6；[A][B,C]: (1+4)+(1+1+4)=11；最优为单列 6。
	if val.Cost != 6 || val.Trains != 1 {
		t.Fatalf("got cuts=%v val=%+v, 期望单列费用 6", cuts, val)
	}
}

func TestNoFeasible(t *testing.T) {
	p := Problem{
		MaxLength: 100,
		MaxWeight: 100,
		Cars: []Car{
			{ID: "A", Type: "tank", Length: 10, Weight: 10, Hazard: 1},
			{ID: "B", Type: "tank", Length: 10, Weight: 10, Hazard: 2},
		},
	}
	// 两节不同品类危险品不能同列相邻，但分成两列是可行的。
	if _, _, ok := p.Solve(); !ok {
		t.Fatal("分成两列应可行")
	}
	// 三节车：相邻两两危险品冲突，只能全部各自成列。
	p2 := Problem{
		MaxLength: 25,
		MaxWeight: 100,
		Cars: []Car{
			{ID: "A", Type: "tank", Length: 10, Weight: 10, Hazard: 1},
			{ID: "B", Type: "tank", Length: 10, Weight: 10, Hazard: 2},
			{ID: "C", Type: "tank", Length: 10, Weight: 10, Hazard: 1},
		},
	}
	// 任意两节长度 20 ≤ 25 可同列但危险品冲突；三节 30 > 25。
	// 只能 [A][B][C] 或 [A][B,C] 等——[B,C] 冲突、[A,B] 冲突、[A][B][C] 可行。
	cuts, _, ok := p2.Solve()
	if !ok || len(cuts) != 4 {
		t.Fatalf("期望只能全拆成 3 列, got cuts=%v ok=%v", cuts, ok)
	}
}

func TestValidateCertificateErrors(t *testing.T) {
	p := sampleProblem()
	if _, err := p.ValidateCertificate([]int{0, 3}); err == nil {
		t.Fatal("未覆盖全部车厢应报错")
	}
	if _, err := p.ValidateCertificate([]int{0, 2, 2, 6}); err == nil {
		t.Fatal("非严格递增应报错")
	}
	if _, err := p.ValidateCertificate([]int{0, 4, 6}); err == nil {
		t.Fatal("含不可行列车应报错")
	}
}

func TestRunEndToEnd(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "in.json")
	data := `{
	  "maxLength": 30, "maxWeight": 120, "trainBase": 10,
	  "typeCost": {"box": 3, "tank": 5, "flat": 2},
	  "cars": [
	    {"id":"C1","type":"box","length":12,"weight":40},
	    {"id":"C2","type":"box","length":12,"weight":40},
	    {"id":"C3","type":"tank","length":10,"weight":50,"hazard":3},
	    {"id":"C4","type":"tank","length":10,"weight":50,"hazard":3},
	    {"id":"C5","type":"flat","length":14,"weight":30},
	    {"id":"C6","type":"box","length":12,"weight":45}
	  ]
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := run(path, 0, 0, false, &buf); err != nil {
		t.Fatalf("run 失败: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"分段证书", "穷举对照", "最优", "总费用"} {
		if !strings.Contains(out, want) {
			t.Fatalf("输出缺少 %q:\n%s", want, out)
		}
	}

	// 覆盖参数生效：把长度上限压到 14，任意两节组合都超限，只能各自成列。
	buf.Reset()
	if err := run(path, 14, 0, false, &buf); err != nil {
		t.Fatalf("run 失败: %v", err)
	}
	if !strings.Contains(buf.String(), "列数: 6") {
		t.Fatalf("覆盖 max-len 后应得 6 列:\n%s", buf.String())
	}
}

func TestRunInfeasible(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "in.json")
	// 单节车厢长度 20 超过上限 15，校验即拒绝。
	data := `{
	  "maxLength": 15, "maxWeight": 100,
	  "cars": [
	    {"id":"A","type":"tank","length":20,"weight":10,"hazard":1}
	  ]
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := run(path, 0, 0, false, &buf); err == nil {
		t.Fatal("无可行编组应返回错误")
	}
}
