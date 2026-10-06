package sched

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
)

// bruteForce 独立地有限枚举全部 4^N 指派，返回最小可行费用与是否可行。
// 它与求解器不共享任何搜索代码，用于验收求解器的最优性。
func bruteForce(shifts []Shift, emps []Employee, p Params) (int, bool) {
	sorted := make([]Shift, len(shifts))
	copy(sorted, shifts)
	// 与求解器相同的排序，保证换人费定义一致。
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && lessShift(sorted[j], sorted[j-1]); j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	n, m := len(sorted), len(emps)
	assign := make([]int, n)
	best := math.MaxInt
	var rec func(i int)
	rec = func(i int) {
		if i == n {
			cost, ok := evalAssign(sorted, emps, p, assign)
			if ok && cost < best {
				best = cost
			}
			return
		}
		for e := 0; e < m; e++ {
			assign[i] = e
			rec(i + 1)
		}
	}
	rec(0)
	return best, best != math.MaxInt
}

func lessShift(a, b Shift) bool {
	if a.Start != b.Start {
		return a.Start < b.Start
	}
	if a.End != b.End {
		return a.End < b.End
	}
	return a.ID < b.ID
}

// evalAssign 直接按定义核验并计价一个完整指派。
func evalAssign(sorted []Shift, emps []Employee, p Params, assign []int) (int, bool) {
	hours := make([]int, len(emps))
	lastEnd := make([]int, len(emps))
	for e := range lastEnd {
		lastEnd[e] = -1
	}
	cost := 0
	for i, s := range sorted {
		e := assign[i]
		if !emps[e].hasQual(s.Qual) {
			return 0, false
		}
		d := s.End - s.Start
		if hours[e]+d > emps[e].MaxHours {
			return 0, false
		}
		if lastEnd[e] >= 0 && s.Start-lastEnd[e] < p.MinRest {
			return 0, false
		}
		hours[e] += d
		lastEnd[e] = s.End
		if i > 0 && assign[i-1] != e {
			cost += p.ChangeoverCost
		}
	}
	for e := range emps {
		cost += tierCost(emps[e].Tiers, hours[e])
	}
	return cost, true
}

func randTiers(rng *rand.Rand) []Tier {
	reg := 240 + 60*rng.Intn(5) // 常规段 4~8 小时
	r1 := 1 + rng.Intn(3)
	r2 := r1 + 1 + rng.Intn(3)
	return []Tier{{UpTo: reg, Rate: r1}, {UpTo: math.MaxInt, Rate: r2}}
}

// TestFiniteEnumeration 是核心验收：对随机生成的实例，
// 求解器结果必须与有限枚举的最小费用一致，且证书通过独立复核。
func TestFiniteEnumeration(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	quals := []string{"a", "b", "c"}
	for trial := 0; trial < 60; trial++ {
		m := 1 + rng.Intn(MaxEmployees)
		emps := make([]Employee, m)
		for e := range emps {
			// 随机资质子集（非空）。
			var qs []string
			for _, q := range quals {
				if rng.Intn(2) == 0 {
					qs = append(qs, q)
				}
			}
			if len(qs) == 0 {
				qs = []string{quals[rng.Intn(len(quals))]}
			}
			emps[e] = Employee{
				ID:       fmt.Sprintf("E%d", e),
				Quals:    qs,
				MaxHours: 300 + 60*rng.Intn(11), // 5~15 小时
				Tiers:    randTiers(rng),
			}
		}
		n := 2 + rng.Intn(9) // 2~10 个班次，保证 4^N 枚举可承受
		shifts := make([]Shift, n)
		for i := range shifts {
			start := 30 * rng.Intn(48) // 一天内，30 分钟粒度
			dur := 60 + 30*rng.Intn(11)
			shifts[i] = Shift{
				ID:    fmt.Sprintf("S%d", i),
				Start: start,
				End:   start + dur,
				Qual:  quals[rng.Intn(len(quals))],
			}
		}
		p := Params{MinRest: 30 * rng.Intn(9), ChangeoverCost: 50 * rng.Intn(6)}

		want, feasible := bruteForce(shifts, emps, p)
		res, err := Solve(shifts, emps, p)
		if !feasible {
			if err == nil {
				t.Fatalf("trial %d: 枚举判定不可行，但 Solve 返回费用 %d", trial, res.Cost)
			}
			continue
		}
		if err != nil {
			t.Fatalf("trial %d: 枚举最小费用 %d，但 Solve 报错 %v", trial, want, err)
		}
		if res.Cost != want {
			t.Fatalf("trial %d: Solve 费用 %d，枚举最小费用 %d", trial, res.Cost, want)
		}
		if err := Verify(shifts, emps, p, res); err != nil {
			t.Fatalf("trial %d: 证书复核失败: %v", trial, err)
		}
		// 费用表内部一致：人工费 + 换人费 = 总费用。
		if res.LaborCost+res.ChangeCost != res.Cost {
			t.Fatalf("trial %d: 费用表不平：%d+%d != %d", trial, res.LaborCost, res.ChangeCost, res.Cost)
		}
		sum := 0
		for _, c := range res.Certs {
			sum += c.LaborCost
		}
		if sum != res.LaborCost {
			t.Fatalf("trial %d: 逐员工人工费合计 %d != 表内 %d", trial, sum, res.LaborCost)
		}
	}
}

// TestKnownOptimum 手工可验的小实例。
func TestKnownOptimum(t *testing.T) {
	emps := []Employee{
		{ID: "甲", Quals: []string{"a"}, MaxHours: 600, Tiers: []Tier{{UpTo: 480, Rate: 2}, {UpTo: math.MaxInt, Rate: 5}}},
		{ID: "乙", Quals: []string{"a"}, MaxHours: 600, Tiers: []Tier{{UpTo: 480, Rate: 2}, {UpTo: math.MaxInt, Rate: 5}}},
	}
	shifts := []Shift{
		{ID: "S1", Start: 0, End: 480, Qual: "a"},
		{ID: "S2", Start: 600, End: 1080, Qual: "a"},
	}
	p := Params{MinRest: 60, ChangeoverCost: 100}
	res, err := Solve(shifts, emps, p)
	if err != nil {
		t.Fatal(err)
	}
	// 全给一人：480*2 + 480*5 = 3360（加班阶梯），无换人。
	// 两人分担：2*(480*2) + 100(换人) = 2020。最优为 2020。
	if res.Cost != 2020 {
		t.Fatalf("期望最小费用 2020，实际 %d", res.Cost)
	}
	if res.Changeovers != 1 {
		t.Fatalf("期望换人 1 次，实际 %d", res.Changeovers)
	}
	if err := Verify(shifts, emps, p, res); err != nil {
		t.Fatal(err)
	}
}

// TestOvertimeLadder 验证加班阶梯：时数超限被迫拆分前，加班费率生效。
func TestOvertimeLadder(t *testing.T) {
	emps := []Employee{
		{ID: "独苗", Quals: []string{"x"}, MaxHours: 1200, Tiers: []Tier{{UpTo: 300, Rate: 1}, {UpTo: 600, Rate: 3}, {UpTo: math.MaxInt, Rate: 10}}},
	}
	shifts := []Shift{
		{ID: "A", Start: 0, End: 300, Qual: "x"},
		{ID: "B", Start: 400, End: 700, Qual: "x"},
		{ID: "C", Start: 800, End: 1100, Qual: "x"},
	}
	res, err := Solve(shifts, emps, Params{MinRest: 60})
	if err != nil {
		t.Fatal(err)
	}
	// 900 分钟：300*1 + 300*3 + 300*10 = 4200。
	if res.Cost != 4200 {
		t.Fatalf("期望阶梯费用 4200，实际 %d", res.Cost)
	}
	c := res.Certs[0]
	wantTier := []int{300, 300, 300}
	for i := range wantTier {
		if c.TierMin[i] != wantTier[i] {
			t.Fatalf("阶梯分钟 %v，期望 %v", c.TierMin, wantTier)
		}
	}
}

// TestInfeasible 覆盖三类不可行情形。
func TestInfeasible(t *testing.T) {
	base := []Employee{{ID: "E", Quals: []string{"a"}, MaxHours: 480, Tiers: []Tier{{UpTo: math.MaxInt, Rate: 1}}}}

	// 资质不兼容。
	_, err := Solve([]Shift{{ID: "S", Start: 0, End: 60, Qual: "z"}}, base, Params{})
	if err == nil {
		t.Fatal("资质不兼容应报不可行")
	}
	// 时数上限。
	_, err = Solve([]Shift{
		{ID: "S1", Start: 0, End: 480, Qual: "a"},
		{ID: "S2", Start: 600, End: 1080, Qual: "a"},
	}, base, Params{})
	if err == nil {
		t.Fatal("时数超限应报不可行")
	}
	// 休息不足且只有一名员工。
	_, err = Solve([]Shift{
		{ID: "S1", Start: 0, End: 100, Qual: "a"},
		{ID: "S2", Start: 110, End: 200, Qual: "a"},
	}, base, Params{MinRest: 60})
	if err == nil {
		t.Fatal("休息不足应报不可行")
	}
}

// TestLimits 验证规模上限校验。
func TestLimits(t *testing.T) {
	emp := Employee{ID: "E", Quals: []string{"a"}, MaxHours: 100000, Tiers: []Tier{{UpTo: math.MaxInt, Rate: 1}}}
	shifts := make([]Shift, MaxShifts+1)
	for i := range shifts {
		shifts[i] = Shift{ID: fmt.Sprintf("S%d", i), Start: i * 10, End: i*10 + 5, Qual: "a"}
	}
	if _, err := Solve(shifts, []Employee{emp}, Params{}); err == nil {
		t.Fatal("超过 16 班次应报错")
	}
	emps := make([]Employee, MaxEmployees+1)
	for i := range emps {
		emps[i] = emp
		emps[i].ID = fmt.Sprintf("E%d", i)
	}
	if _, err := Solve(shifts[:1], emps, Params{}); err == nil {
		t.Fatal("超过 4 名员工应报错")
	}
}

// TestSixteenShifts 求解器须在上限规模（16 班次、4 员工）下完成。
func TestSixteenShifts(t *testing.T) {
	emps := []Employee{
		{ID: "E0", Quals: []string{"a", "b"}, MaxHours: 900, Tiers: []Tier{{UpTo: 480, Rate: 2}, {UpTo: math.MaxInt, Rate: 4}}},
		{ID: "E1", Quals: []string{"a"}, MaxHours: 900, Tiers: []Tier{{UpTo: 480, Rate: 2}, {UpTo: math.MaxInt, Rate: 3}}},
		{ID: "E2", Quals: []string{"b"}, MaxHours: 900, Tiers: []Tier{{UpTo: 480, Rate: 1}, {UpTo: math.MaxInt, Rate: 6}}},
		{ID: "E3", Quals: []string{"a", "b"}, MaxHours: 900, Tiers: []Tier{{UpTo: 480, Rate: 3}, {UpTo: math.MaxInt, Rate: 5}}},
	}
	var shifts []Shift
	for i := 0; i < MaxShifts; i++ {
		q := "a"
		if i%3 == 0 {
			q = "b"
		}
		shifts = append(shifts, Shift{ID: fmt.Sprintf("S%02d", i), Start: i * 150, End: i*150 + 120, Qual: q})
	}
	p := Params{MinRest: 30, ChangeoverCost: 40}
	res, err := Solve(shifts, emps, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(shifts, emps, p, res); err != nil {
		t.Fatal(err)
	}
}

// Example 展示最小费用表与逐员工证书的输出。
func Example() {
	emps := []Employee{
		{ID: "甲", Quals: []string{"收银", "理货"}, MaxHours: 600,
			Tiers: []Tier{{UpTo: 480, Rate: 2}, {UpTo: math.MaxInt, Rate: 5}}},
		{ID: "乙", Quals: []string{"收银"}, MaxHours: 600,
			Tiers: []Tier{{UpTo: 480, Rate: 2}, {UpTo: math.MaxInt, Rate: 5}}},
	}
	shifts := []Shift{
		{ID: "早班", Start: 0, End: 480, Qual: "收银"},
		{ID: "晚班", Start: 600, End: 1080, Qual: "理货"},
	}
	res, err := Solve(shifts, emps, Params{MinRest: 60, ChangeoverCost: 100})
	if err != nil {
		panic(err)
	}
	fmt.Print(res.Table())
	for _, c := range res.Certs {
		fmt.Print(c.String())
	}
	// Output:
	// 最小费用表
	// ──────────────┬──────────
	// 总费用        │ 2020
	// 人工费        │ 1920
	// 换人费        │ 100 (1 次)
	// ──────────────┴──────────
	// 甲             │ 时数 480/600 人工费 960
	// 乙             │ 时数 480/600 人工费 960
	// 员工 甲 证书
	//   班次 晚班 [600,1080) 资质=理货
	//   总时数 480 分钟（上限 600）
	//   计费: 阶梯1=480分钟, 阶梯2=0分钟 → 人工费 960
	//   核验: 资质✓ 时数✓ 休息✓
	// 员工 乙 证书
	//   班次 早班 [0,480) 资质=收银
	//   总时数 480 分钟（上限 600）
	//   计费: 阶梯1=480分钟, 阶梯2=0分钟 → 人工费 960
	//   核验: 资质✓ 时数✓ 休息✓
}
