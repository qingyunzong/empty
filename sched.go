// Package sched 是一个小规模排班库：把至多 16 个班次分配给至多 4 名员工。
//
// 约束：
//   - 资质兼容：员工必须具备班次要求的资质；
//   - 总时数上限：每名员工分配的总时数不得超过其上限；
//   - 相邻班次休息：同一员工相邻班次之间至少间隔 MinRest 分钟。
//
// 代价：
//   - 人工费按加班阶梯计价（每名员工各自累计时数，分段费率）；
//   - 换人费：时间相邻的两个班次若由不同员工承担，收取一次换人费。
//
// 求解器使用分支限界在全部有限指派中搜索最小费用解；
// 结果附带最小费用表与逐员工证书，证书可由 Verify 独立复核。
package sched

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// MaxShifts 是求解器接受的班次数量上限。
const MaxShifts = 16

// MaxEmployees 是求解器接受的员工数量上限。
const MaxEmployees = 4

// ErrInfeasible 表示不存在满足全部约束的指派。
var ErrInfeasible = errors.New("sched: 无可行指派")

// Tier 是加班阶梯的一段：累计时数在 (上一段UpTo, UpTo] 内的部分按 Rate 计费（每分钟）。
// 最后一段必须使用 UpTo = math.MaxInt 表示不设上限。
type Tier struct {
	UpTo int // 分钟
	Rate int // 每分钟费用
}

// Employee 描述一名可排班员工。
type Employee struct {
	ID       string
	Quals    []string // 具备的资质
	MaxHours int      // 总时数上限（分钟）
	Tiers    []Tier   // 加班阶梯，按 UpTo 升序，最后一段 UpTo 为 math.MaxInt
}

// Shift 描述一个待分配班次，时间以分钟计。
type Shift struct {
	ID    string
	Start int
	End   int
	Qual  string // 要求的资质
}

// Params 是全局排班参数。
type Params struct {
	MinRest        int // 同一员工相邻班次的最小休息分钟数
	ChangeoverCost int // 相邻班次换人一次的固定费用
}

// Assignment 把一个班次指派给一名员工。
type Assignment struct {
	ShiftID    string
	EmployeeID string
}

// tierCost 返回累计 minutes 分钟在阶梯 tiers 下的总人工费。
func tierCost(tiers []Tier, minutes int) int {
	cost, prev := 0, 0
	for _, t := range tiers {
		if minutes <= prev {
			break
		}
		m := minutes
		if m > t.UpTo {
			m = t.UpTo
		}
		cost += (m - prev) * t.Rate
		prev = t.UpTo
	}
	return cost
}

// tierMinutes 返回累计 minutes 分钟落在每一阶梯段内的分钟数。
func tierMinutes(tiers []Tier, minutes int) []int {
	out := make([]int, len(tiers))
	prev := 0
	for i, t := range tiers {
		if minutes <= prev {
			break
		}
		m := minutes
		if m > t.UpTo {
			m = t.UpTo
		}
		out[i] = m - prev
		prev = t.UpTo
	}
	return out
}

func (e Employee) hasQual(q string) bool {
	for _, s := range e.Quals {
		if s == q {
			return true
		}
	}
	return false
}

// validate 检查输入是否合法（规模、阶梯形状、时间区间）。
func validate(shifts []Shift, emps []Employee) error {
	if len(shifts) == 0 {
		return errors.New("sched: 至少需要一个班次")
	}
	if len(shifts) > MaxShifts {
		return fmt.Errorf("sched: 班次数 %d 超过上限 %d", len(shifts), MaxShifts)
	}
	if len(emps) == 0 || len(emps) > MaxEmployees {
		return fmt.Errorf("sched: 员工数须为 1..%d，实际 %d", MaxEmployees, len(emps))
	}
	for _, s := range shifts {
		if s.End <= s.Start {
			return fmt.Errorf("sched: 班次 %s 时间区间非法 [%d,%d)", s.ID, s.Start, s.End)
		}
	}
	for _, e := range emps {
		if len(e.Tiers) == 0 {
			return fmt.Errorf("sched: 员工 %s 缺少计费阶梯", e.ID)
		}
		prev := -1
		for i, t := range e.Tiers {
			if t.UpTo <= prev {
				return fmt.Errorf("sched: 员工 %s 阶梯 UpTo 必须严格递增", e.ID)
			}
			if t.Rate < 0 {
				return fmt.Errorf("sched: 员工 %s 阶梯费率不能为负", e.ID)
			}
			prev = t.UpTo
			if i < len(e.Tiers)-1 && t.UpTo == math.MaxInt {
				return fmt.Errorf("sched: 员工 %s 仅最后一段阶梯可不限量", e.ID)
			}
		}
		if e.Tiers[len(e.Tiers)-1].UpTo != math.MaxInt {
			return fmt.Errorf("sched: 员工 %s 最后一段阶梯 UpTo 必须为 math.MaxInt", e.ID)
		}
		if e.MaxHours < 0 {
			return fmt.Errorf("sched: 员工 %s 时数上限不能为负", e.ID)
		}
	}
	return nil
}

// Solve 求最小费用排班。返回的 Result 含最小费用表数据与逐员工证书。
// 班次按 (Start, End, ID) 排序后处理；同等费用下返回员工序号字典序最小的指派。
func Solve(shifts []Shift, emps []Employee, p Params) (Result, error) {
	if err := validate(shifts, emps); err != nil {
		return Result{}, err
	}
	if p.MinRest < 0 || p.ChangeoverCost < 0 {
		return Result{}, errors.New("sched: MinRest 与 ChangeoverCost 不能为负")
	}

	sorted := make([]Shift, len(shifts))
	copy(sorted, shifts)
	sort.Slice(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		if a.End != b.End {
			return a.End < b.End
		}
		return a.ID < b.ID
	})

	n, m := len(sorted), len(emps)
	durs := make([]int, n)
	// qual[i][e]：员工 e 是否可承担班次 i；minRate[i]：可承担者的最低首段费率。
	qual := make([][]bool, n)
	minRate := make([]int, n)
	for i, s := range sorted {
		durs[i] = s.End - s.Start
		qual[i] = make([]bool, m)
		minRate[i] = -1
		for e := range emps {
			if emps[e].hasQual(s.Qual) {
				qual[i][e] = true
				if r := emps[e].Tiers[0].Rate; minRate[i] < 0 || r < minRate[i] {
					minRate[i] = r
				}
			}
		}
		if minRate[i] < 0 {
			return Result{}, fmt.Errorf("sched: 班次 %s 无任何具备资质 %q 的员工: %w", s.ID, s.Qual, ErrInfeasible)
		}
	}
	// suffix[i]：班次 i..n-1 人工费的（可采纳）下界，用于分支限界。
	suffix := make([]int, n+1)
	for i := n - 1; i >= 0; i-- {
		suffix[i] = suffix[i+1] + durs[i]*minRate[i]
	}

	hours := make([]int, m)   // 每名员工累计分钟
	lastEnd := make([]int, m) // 每名员工最近班次的结束时间，-1 表示尚未排班
	for e := range lastEnd {
		lastEnd[e] = -1
	}
	assign := make([]int, n) // 每个班次指派的员工序号
	best := make([]int, n)
	bestCost := math.MaxInt

	var dfs func(i, lastEmp, cost int)
	dfs = func(i, lastEmp, cost int) {
		if cost+suffix[i] >= bestCost {
			return
		}
		if i == n {
			bestCost = cost
			copy(best, assign)
			return
		}
		s := sorted[i]
		for e := 0; e < m; e++ {
			if !qual[i][e] {
				continue
			}
			if hours[e]+durs[i] > emps[e].MaxHours {
				continue
			}
			if lastEnd[e] >= 0 && s.Start-lastEnd[e] < p.MinRest {
				continue
			}
			add := tierCost(emps[e].Tiers, hours[e]+durs[i]) - tierCost(emps[e].Tiers, hours[e])
			if lastEmp >= 0 && lastEmp != e {
				add += p.ChangeoverCost
			}
			prevEnd := lastEnd[e]
			hours[e] += durs[i]
			lastEnd[e] = s.End
			assign[i] = e
			dfs(i+1, e, cost+add)
			hours[e] -= durs[i]
			lastEnd[e] = prevEnd
		}
	}
	dfs(0, -1, 0)
	if bestCost == math.MaxInt {
		return Result{}, ErrInfeasible
	}
	return buildResult(sorted, emps, p, best, bestCost), nil
}
