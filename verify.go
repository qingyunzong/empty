package sched

import (
	"fmt"
	"strings"
)

// EmployeeCert certifies one employee's share of a solution: which shifts
// were assigned and that every constraint held for them.
type EmployeeCert struct {
	EmployeeID string
	Shifts     []string
	Minutes    int
	MaxHours   int
	Labor      int
}

// Certificate is the per-employee proof returned by Verify, together with
// the recomputed changeover and total cost.
type Certificate struct {
	Employees      [4]EmployeeCert
	Changeovers    int
	ChangeoverCost int
	Total          int
}

// Verify independently re-checks a solution against every constraint
// (skill compatibility, hours cap, rest gap) and recomputes the full cost
// from scratch. It returns a per-employee certificate, or a descriptive
// error if the solution is invalid or its cost fields are wrong.
func Verify(inst *Instance, sol *Solution) (Certificate, error) {
	var cert Certificate
	if err := inst.validate(); err != nil {
		return cert, err
	}
	n := len(inst.Shifts)
	if len(sol.Assign) != n {
		return cert, fmt.Errorf("sched: assignment length %d, want %d", len(sol.Assign), n)
	}
	lastEnd := [4]int{-1, -1, -1, -1}
	for i, sh := range inst.Shifts {
		e := sol.Assign[i]
		if e < 0 || e > 3 {
			return cert, fmt.Errorf("sched: shift %q assigned to invalid employee %d", sh.ID, e)
		}
		emp := &inst.Employees[e]
		if !emp.hasSkill(sh.Skill) {
			return cert, fmt.Errorf("sched: employee %q lacks skill %q for shift %q", emp.ID, sh.Skill, sh.ID)
		}
		if lastEnd[e] >= 0 && sh.Start-lastEnd[e] < inst.Params.MinRest {
			return cert, fmt.Errorf("sched: employee %q has only %d min rest before shift %q (need %d)",
				emp.ID, sh.Start-lastEnd[e], sh.ID, inst.Params.MinRest)
		}
		lastEnd[e] = sh.End
		ec := &cert.Employees[e]
		ec.EmployeeID = emp.ID
		ec.Shifts = append(ec.Shifts, sh.ID)
		ec.Minutes += sh.End - sh.Start
	}
	for e := 0; e < 4; e++ {
		ec := &cert.Employees[e]
		ec.MaxHours = inst.Employees[e].MaxHours
		if ec.Minutes > ec.MaxHours {
			return cert, fmt.Errorf("sched: employee %q works %d min, cap is %d",
				ec.EmployeeID, ec.Minutes, ec.MaxHours)
		}
		ec.Labor = labor(ec.Minutes, inst.Params.Tiers)
		cert.Total += ec.Labor
		if sol.Minutes[e] != ec.Minutes || sol.Labor[e] != ec.Labor {
			return cert, fmt.Errorf("sched: solution cost fields for employee %q do not match recomputation",
				ec.EmployeeID)
		}
	}
	for i := 1; i < n; i++ {
		if sol.Assign[i] != sol.Assign[i-1] {
			cert.Changeovers++
		}
	}
	cert.ChangeoverCost = cert.Changeovers * inst.Params.Changeover
	cert.Total += cert.ChangeoverCost
	if sol.Changeovers != cert.Changeovers || sol.Total != cert.Total {
		return cert, fmt.Errorf("sched: solution total %d does not match recomputed %d",
			sol.Total, cert.Total)
	}
	return cert, nil
}

// String renders the per-employee certificate table.
func (c Certificate) String() string {
	var b strings.Builder
	b.WriteString("certificate\n")
	for _, ec := range c.Employees {
		shifts := strings.Join(ec.Shifts, ",")
		if shifts == "" {
			shifts = "-"
		}
		fmt.Fprintf(&b, "  %s: shifts=[%s] minutes=%d<=%d labor=%d\n",
			ec.EmployeeID, shifts, ec.Minutes, ec.MaxHours, ec.Labor)
	}
	fmt.Fprintf(&b, "  changeovers=%d cost=%d total=%d\n", c.Changeovers, c.ChangeoverCost, c.Total)
	return b.String()
}
