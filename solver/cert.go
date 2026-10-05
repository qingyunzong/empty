package solver

import (
	"fmt"
	"sort"
)

// CoverageEntry witnesses one covered requirement.
type CoverageEntry struct {
	Kind string `json:"kind"` // "branch" or "pair"
	Name string `json:"name"`
	Test string `json:"test"` // a selected test covering it
}

// Certificate is a self-contained proof of the solver's answer: the
// selection, a witness test for every requirement, and the search bound
// that certifies optimality.
type Certificate struct {
	Instance   string          `json:"instance"`
	Status     Status          `json:"status"`
	Cost       int             `json:"cost"`
	Count      int             `json:"count"`
	Time       int             `json:"time"`
	TimeLimit  int             `json:"timeLimit"`
	Selected   []string        `json:"selected,omitempty"`
	Coverage   []CoverageEntry `json:"coverage,omitempty"`
	BoundCost  int             `json:"boundCost"`
	BoundCount int             `json:"boundCount"`
	Nodes      int             `json:"nodes"`
	Pruned     int             `json:"pruned"`
}

// BuildCertificate assembles a certificate from a solve result.
func BuildCertificate(inst *Instance, res *Result) *Certificate {
	cert := &Certificate{
		Instance:   inst.Name,
		Status:     res.Status,
		TimeLimit:  inst.TimeLimit,
		BoundCost:  res.Stats.BoundCost,
		BoundCount: res.Stats.BoundCount,
		Nodes:      res.Stats.Nodes,
		Pruned:     res.Stats.Pruned,
	}
	if res.Status == Infeasible {
		return cert
	}
	cert.Cost, cert.Count, cert.Time = res.Cost, res.Count, res.Time
	sel := make([]string, len(res.Selected))
	inSel := make([]bool, len(inst.Tests))
	for i, t := range res.Selected {
		sel[i] = inst.Tests[t].ID
		inSel[t] = true
	}
	sort.Strings(sel)
	cert.Selected = sel

	// Assign each requirement to the first selected test covering it.
	// Deterministic: tests are scanned in input order.
	witness := func(kind, name string, covers func(t int) bool) {
		for ti, t := range inst.Tests {
			if inSel[ti] && covers(ti) {
				cert.Coverage = append(cert.Coverage, CoverageEntry{Kind: kind, Name: name, Test: t.ID})
				return
			}
		}
	}
	c, err := compile(inst)
	if err != nil { // cannot happen: instance already solved
		panic(err)
	}
	for _, b := range inst.Branches {
		j := c.branchIdx[b]
		witness("branch", b, func(t int) bool { return c.coverB[t].has(j) })
	}
	for _, p := range inst.Pairs {
		j := c.pairIdx[p]
		witness("pair", p, func(t int) bool { return c.coverP[t].has(j) })
	}
	return cert
}

// VerifyCertificate checks a certificate against the instance: the
// selection must be closed under prerequisites, respect the time limit,
// cover every requirement via the listed witnesses, and match the stated
// cost/count. When checkOptimal is true it also re-solves the instance and
// confirms the objective and bound.
func VerifyCertificate(inst *Instance, cert *Certificate, checkOptimal bool) error {
	if cert.Status == Infeasible {
		if !checkOptimal {
			return nil
		}
		res, err := Solve(inst, nil)
		if err != nil {
			return err
		}
		if res.Status != Infeasible {
			return fmt.Errorf("certificate claims infeasible but a cover with cost %d exists", res.Cost)
		}
		return nil
	}
	if cert.Status == Unknown {
		return fmt.Errorf("status UNKNOWN: search was cut off before any result was proven")
	}
	if cert.Status != Optimal && cert.Status != Feasible {
		return fmt.Errorf("unexpected certificate status %q", cert.Status)
	}

	idx := map[string]int{}
	for i, t := range inst.Tests {
		idx[t.ID] = i
	}
	var selMask uint64
	cost, count, time := 0, 0, 0
	for _, id := range cert.Selected {
		i, ok := idx[id]
		if !ok {
			return fmt.Errorf("certificate selects unknown test %q", id)
		}
		if selMask&(1<<uint(i)) != 0 {
			return fmt.Errorf("certificate selects test %q twice", id)
		}
		selMask |= 1 << uint(i)
		cost += inst.Tests[i].Cost
		time += inst.Tests[i].Time
		count++
	}
	if cost != cert.Cost || count != cert.Count || time != cert.Time {
		return fmt.Errorf("certificate totals mismatch: got cost=%d count=%d time=%d, want cost=%d count=%d time=%d",
			cost, count, time, cert.Cost, cert.Count, cert.Time)
	}
	if time > inst.TimeLimit {
		return fmt.Errorf("certificate exceeds time limit: %d > %d", time, inst.TimeLimit)
	}

	c, err := compile(inst)
	if err != nil {
		return err
	}
	// Prerequisite closure.
	for _, id := range cert.Selected {
		i := idx[id]
		if c.closure[i]&^selMask != 0 {
			return fmt.Errorf("selection not closed: test %q is missing prerequisites", id)
		}
	}
	// Coverage witnesses.
	covB := newBitset(len(inst.Branches))
	covP := newBitset(len(inst.Pairs))
	for m := selMask; m != 0; m &= m - 1 {
		t := bitsTrailing(m)
		covB.unionInto(c.coverB[t])
		covP.unionInto(c.coverP[t])
	}
	seen := map[string]bool{}
	for _, e := range cert.Coverage {
		ti, ok := idx[e.Test]
		if !ok || selMask&(1<<uint(ti)) == 0 {
			return fmt.Errorf("witness test %q is not selected", e.Test)
		}
		switch e.Kind {
		case "branch":
			j, ok := c.branchIdx[e.Name]
			if !ok {
				return fmt.Errorf("certificate covers unknown branch %q", e.Name)
			}
			if !c.coverB[ti].has(j) {
				return fmt.Errorf("test %q does not cover branch %q", e.Test, e.Name)
			}
			seen["b:"+e.Name] = true
		case "pair":
			j, ok := c.pairIdx[e.Name]
			if !ok {
				return fmt.Errorf("certificate covers unknown pair %q", e.Name)
			}
			if !c.coverP[ti].has(j) {
				return fmt.Errorf("test %q does not cover pair %q", e.Test, e.Name)
			}
			seen["p:"+e.Name] = true
		default:
			return fmt.Errorf("unknown coverage kind %q", e.Kind)
		}
	}
	for _, b := range inst.Branches {
		if !seen["b:"+b] {
			return fmt.Errorf("required branch %q has no witness", b)
		}
	}
	for _, p := range inst.Pairs {
		if !seen["p:"+p] {
			return fmt.Errorf("required pair %q has no witness", p)
		}
	}
	if !covB.contains(c.reqB) || !covP.contains(c.reqP) {
		return fmt.Errorf("selection does not cover all requirements")
	}

	if checkOptimal {
		res, err := Solve(inst, nil)
		if err != nil {
			return err
		}
		if res.Status != Optimal {
			return fmt.Errorf("re-solve did not prove optimality (status %s)", res.Status)
		}
		if res.Cost != cert.Cost || res.Count != cert.Count {
			return fmt.Errorf("certificate objective (cost=%d count=%d) is not optimal: solver proves (cost=%d count=%d)",
				cert.Cost, cert.Count, res.Cost, res.Count)
		}
		if cert.Status != Optimal {
			return fmt.Errorf("certificate status is %s but the instance is solvable to optimality", cert.Status)
		}
		if cert.BoundCost != res.Stats.BoundCost || cert.BoundCount != res.Stats.BoundCount {
			return fmt.Errorf("certificate bound (cost=%d count=%d) does not match proven bound (cost=%d count=%d)",
				cert.BoundCost, cert.BoundCount, res.Stats.BoundCost, res.Stats.BoundCount)
		}
	}
	return nil
}
