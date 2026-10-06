package sched

import (
	"fmt"
	"sort"
	"strings"
)

// EmployeeCert 是逐员工证书：记录一名员工的排班明细、阶梯计费与约束核验结果。
type EmployeeCert struct {
	EmployeeID string
	Shifts     []Shift // 按时间顺序的已分配班次
	TotalMin   int     // 总时数（分钟）
	MaxHours   int     // 时数上限（分钟）
	TierMin    []int   // 各阶梯段计费分钟数
	LaborCost  int     // 该员工人工费
	QualOK     bool    // 全部班次资质兼容
	HoursOK    bool    // 总时数未超上限
	RestOK     bool    // 相邻班次休息均满足
}

// OK 报告该员工证书的全部约束核验是否通过。
func (c EmployeeCert) OK() bool { return c.QualOK && c.HoursOK && c.RestOK }

// Result 是一次求解的完整输出。
type Result struct {
	Cost        int          // 总费用 = 人工费 + 换人费
	LaborCost   int          // 全员人工费合计
	Changeovers int          // 换人次数
	ChangeCost  int          // 换人费合计
	Assignments []Assignment // 按班次时间顺序
	Certs       []EmployeeCert
}

// buildResult 由最优指派向量构造 Result 与逐员工证书。
func buildResult(sorted []Shift, emps []Employee, p Params, best []int, bestCost int) Result {
	r := Result{Cost: bestCost}
	certs := make([]EmployeeCert, len(emps))
	for e, emp := range emps {
		certs[e] = EmployeeCert{EmployeeID: emp.ID, MaxHours: emp.MaxHours, QualOK: true, HoursOK: true, RestOK: true}
	}
	lastEmp := -1
	for i, s := range sorted {
		e := best[i]
		r.Assignments = append(r.Assignments, Assignment{ShiftID: s.ID, EmployeeID: emps[e].ID})
		c := &certs[e]
		if !emps[e].hasQual(s.Qual) {
			c.QualOK = false
		}
		if len(c.Shifts) > 0 && s.Start-c.Shifts[len(c.Shifts)-1].End < p.MinRest {
			c.RestOK = false
		}
		c.Shifts = append(c.Shifts, s)
		c.TotalMin += s.End - s.Start
		if lastEmp >= 0 && lastEmp != e {
			r.Changeovers++
		}
		lastEmp = e
	}
	r.ChangeCost = r.Changeovers * p.ChangeoverCost
	for e, emp := range emps {
		c := &certs[e]
		if c.TotalMin > emp.MaxHours {
			c.HoursOK = false
		}
		c.TierMin = tierMinutes(emp.Tiers, c.TotalMin)
		c.LaborCost = tierCost(emp.Tiers, c.TotalMin)
		r.LaborCost += c.LaborCost
	}
	r.Certs = certs
	return r
}

// Verify 独立复核 Result：每个班次恰被指派一次、全部约束满足、费用重算一致。
// 它不信任 Result 中的任何派生数据，从原始输入重新计算。
func Verify(shifts []Shift, emps []Employee, p Params, r Result) error {
	if err := validate(shifts, emps); err != nil {
		return err
	}
	byID := make(map[string]Employee, len(emps))
	idx := make(map[string]int, len(emps))
	for i, e := range emps {
		byID[e.ID] = e
		idx[e.ID] = i
	}
	seen := make(map[string]string, len(shifts))
	perEmp := make(map[string][]Shift)
	for _, a := range r.Assignments {
		if _, ok := byID[a.EmployeeID]; !ok {
			return fmt.Errorf("sched: 指派引用未知员工 %q", a.EmployeeID)
		}
		if _, dup := seen[a.ShiftID]; dup {
			return fmt.Errorf("sched: 班次 %s 被重复指派", a.ShiftID)
		}
		seen[a.ShiftID] = a.EmployeeID
	}
	shiftByID := make(map[string]Shift, len(shifts))
	for _, s := range shifts {
		shiftByID[s.ID] = s
		if _, ok := seen[s.ID]; !ok {
			return fmt.Errorf("sched: 班次 %s 未被指派", s.ID)
		}
	}
	// 逐员工核验约束并累计人工费。
	labor := 0
	for _, e := range emps {
		var list []Shift
		for _, a := range r.Assignments {
			if a.EmployeeID == e.ID {
				list = append(list, shiftByID[a.ShiftID])
			}
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Start < list[j].Start })
		total := 0
		for i, s := range list {
			if !e.hasQual(s.Qual) {
				return fmt.Errorf("sched: 员工 %s 不具备班次 %s 要求的资质 %q", e.ID, s.ID, s.Qual)
			}
			if i > 0 && s.Start-list[i-1].End < p.MinRest {
				return fmt.Errorf("sched: 员工 %s 在班次 %s 前休息不足 %d 分钟", e.ID, s.ID, p.MinRest)
			}
			total += s.End - s.Start
		}
		if total > e.MaxHours {
			return fmt.Errorf("sched: 员工 %s 总时数 %d 超过上限 %d", e.ID, total, e.MaxHours)
		}
		labor += tierCost(e.Tiers, total)
		perEmp[e.ID] = list
	}
	// 按时间顺序重算换人费。
	ordered := make([]Assignment, len(r.Assignments))
	copy(ordered, r.Assignments)
	sort.Slice(ordered, func(i, j int) bool {
		a, b := shiftByID[ordered[i].ShiftID], shiftByID[ordered[j].ShiftID]
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		if a.End != b.End {
			return a.End < b.End
		}
		return a.ID < b.ID
	})
	change := 0
	for i := 1; i < len(ordered); i++ {
		if ordered[i].EmployeeID != ordered[i-1].EmployeeID {
			change += p.ChangeoverCost
		}
	}
	if got := labor + change; got != r.Cost {
		return fmt.Errorf("sched: 费用不符，重算 %d，结果声称 %d", got, r.Cost)
	}
	// 复核逐员工证书与指派一致。
	if len(r.Certs) != len(emps) {
		return fmt.Errorf("sched: 证书数量 %d 与员工数 %d 不符", len(r.Certs), len(emps))
	}
	for i, c := range r.Certs {
		e := emps[i]
		if c.EmployeeID != e.ID {
			return fmt.Errorf("sched: 证书 %d 属于 %s，应为 %s", i, c.EmployeeID, e.ID)
		}
		if !c.OK() {
			return fmt.Errorf("sched: 员工 %s 证书存在未通过的核验项", e.ID)
		}
		if c.LaborCost != tierCost(e.Tiers, c.TotalMin) {
			return fmt.Errorf("sched: 员工 %s 证书人工费重算不符", e.ID)
		}
		if len(c.Shifts) != len(perEmp[e.ID]) {
			return fmt.Errorf("sched: 员工 %s 证书班次数与指派不符", e.ID)
		}
	}
	return nil
}

// Table 渲染最小费用表。
func (r Result) Table() string {
	var b strings.Builder
	fmt.Fprintln(&b, "最小费用表")
	fmt.Fprintln(&b, "──────────────┬──────────")
	fmt.Fprintf(&b, "总费用        │ %d\n", r.Cost)
	fmt.Fprintf(&b, "人工费        │ %d\n", r.LaborCost)
	fmt.Fprintf(&b, "换人费        │ %d (%d 次)\n", r.ChangeCost, r.Changeovers)
	fmt.Fprintln(&b, "──────────────┴──────────")
	for _, c := range r.Certs {
		fmt.Fprintf(&b, "%-13s │ 时数 %d/%d 人工费 %d\n", c.EmployeeID, c.TotalMin, c.MaxHours, c.LaborCost)
	}
	return b.String()
}

// String 渲染单份逐员工证书。
func (c EmployeeCert) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "员工 %s 证书\n", c.EmployeeID)
	for _, s := range c.Shifts {
		fmt.Fprintf(&b, "  班次 %s [%d,%d) 资质=%s\n", s.ID, s.Start, s.End, s.Qual)
	}
	fmt.Fprintf(&b, "  总时数 %d 分钟（上限 %d）\n", c.TotalMin, c.MaxHours)
	parts := make([]string, len(c.TierMin))
	for i, m := range c.TierMin {
		parts[i] = fmt.Sprintf("阶梯%d=%d分钟", i+1, m)
	}
	fmt.Fprintf(&b, "  计费: %s → 人工费 %d\n", strings.Join(parts, ", "), c.LaborCost)
	mark := func(ok bool) string {
		if ok {
			return "✓"
		}
		return "✗"
	}
	fmt.Fprintf(&b, "  核验: 资质%s 时数%s 休息%s\n", mark(c.QualOK), mark(c.HoursOK), mark(c.RestOK))
	return b.String()
}
