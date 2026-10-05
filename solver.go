package main

import (
	"fmt"
	"math"
	"math/bits"
	"sort"
	"strings"
)

const (
	// maxAssertions caps the candidate pool so exhaustive small-subset
	// enumeration stays trivially cheap (2^18 subsets).
	maxAssertions = 18
	// maxModels is bounded by the uint64 coverage bitmask.
	maxModels = 63
)

// Instance is a validated spec with precomputed coverage bitmasks.
type Instance struct {
	Spec       Spec
	cover      []uint64
	modelIndex map[string]int
	// distinguishable is the set of models at least one assertion separates
	// from normal; the rest are indistinguishable and reported separately.
	distinguishable   uint64
	indistinguishable []int
}

// NewInstance validates a spec and builds the planning instance.
func NewInstance(spec Spec) (*Instance, error) {
	if len(spec.Assertions) == 0 {
		return nil, fmt.Errorf("spec must declare at least 1 candidate assertion")
	}
	if len(spec.Assertions) > maxAssertions {
		return nil, fmt.Errorf("too many candidate assertions: %d > %d", len(spec.Assertions), maxAssertions)
	}
	if len(spec.Models) == 0 {
		return nil, fmt.Errorf("spec must declare at least 1 fault model")
	}
	if len(spec.Models) > maxModels {
		return nil, fmt.Errorf("too many fault models: %d > %d", len(spec.Models), maxModels)
	}

	in := &Instance{Spec: spec, modelIndex: make(map[string]int, len(spec.Models))}
	for i, m := range spec.Models {
		if m.ID == "" {
			return nil, fmt.Errorf("fault model #%d has an empty id", i)
		}
		if _, dup := in.modelIndex[m.ID]; dup {
			return nil, fmt.Errorf("duplicate fault model id %q", m.ID)
		}
		in.modelIndex[m.ID] = i
	}

	seen := make(map[string]bool, len(spec.Assertions))
	in.cover = make([]uint64, len(spec.Assertions))
	for i, a := range spec.Assertions {
		if a.ID == "" {
			return nil, fmt.Errorf("assertion #%d has an empty id", i)
		}
		if seen[a.ID] {
			return nil, fmt.Errorf("duplicate assertion id %q", a.ID)
		}
		seen[a.ID] = true
		if a.Cost < 0 {
			return nil, fmt.Errorf("assertion %q has negative cost %d", a.ID, a.Cost)
		}
		var mask uint64
		for _, mid := range a.Distinguishes {
			j, ok := in.modelIndex[mid]
			if !ok {
				return nil, fmt.Errorf("assertion %q references unknown fault model %q", a.ID, mid)
			}
			mask |= 1 << uint(j)
		}
		in.cover[i] = mask
		in.distinguishable |= mask
	}
	for j := range spec.Models {
		if in.distinguishable&(1<<uint(j)) == 0 {
			in.indistinguishable = append(in.indistinguishable, j)
		}
	}
	return in, nil
}

// Plan is a selected set of assertion indices with its total cost and the
// models it separates from normal.
type Plan struct {
	Assertions []int
	Cost       int
	Covered    uint64
}

// mutexOK reports whether a selection respects side-effect mutual exclusion.
func (in *Instance) mutexOK(chosen []int) bool {
	used := make(map[string]bool)
	for _, i := range chosen {
		g := in.Spec.Assertions[i].SideEffectGroup
		if g == "" {
			continue
		}
		if used[g] {
			return false
		}
		used[g] = true
	}
	return true
}

// Greedy builds a plan by repeatedly taking the assertion with the lowest
// cost per newly distinguished model. Ties break toward the cheaper
// assertion, then declaration order, so the result is deterministic. It may
// stall (Covered < distinguishable) when side-effect mutex blocks every
// remaining useful assertion.
func (in *Instance) Greedy() Plan {
	target := in.distinguishable
	var chosen []int
	inSet := make([]bool, len(in.Spec.Assertions))
	usedGroups := make(map[string]bool)
	var covered uint64
	cost := 0
	for covered != target {
		best := -1
		var bestNew uint64
		for i := range in.Spec.Assertions {
			if inSet[i] {
				continue
			}
			if g := in.Spec.Assertions[i].SideEffectGroup; g != "" && usedGroups[g] {
				continue
			}
			newBits := in.cover[i] &^ covered & target
			if newBits == 0 {
				continue
			}
			if best < 0 || lessRatio(in.Spec.Assertions[i].Cost, bits.OnesCount64(newBits),
				in.Spec.Assertions[best].Cost, bits.OnesCount64(bestNew)) {
				best, bestNew = i, newBits
			}
		}
		if best < 0 {
			break
		}
		chosen = append(chosen, best)
		inSet[best] = true
		if g := in.Spec.Assertions[best].SideEffectGroup; g != "" {
			usedGroups[g] = true
		}
		covered |= in.cover[best]
		cost += in.Spec.Assertions[best].Cost
	}
	return Plan{Assertions: chosen, Cost: cost, Covered: covered}
}

// lessRatio compares cost-per-new-model ratios aCost/aNew vs bCost/bNew
// without floating point; exact ties break toward the cheaper assertion.
func lessRatio(aCost, aNew, bCost, bNew int) bool {
	if aCost*bNew != bCost*aNew {
		return aCost*bNew < bCost*aNew
	}
	return aCost < bCost
}

// Exhaustive enumerates every subset of the candidate assertions and keeps
// the cheapest feasible one: every distinguishable model covered and
// side-effect groups mutually exclusive. It also counts how many subsets
// attain the optimum. optima == 0 means the instance is infeasible.
func (in *Instance) Exhaustive() (best Plan, optima, explored int) {
	n := len(in.Spec.Assertions)
	target := in.distinguishable
	bestCost := math.MaxInt
	for mask := 0; mask < 1<<uint(n); mask++ {
		explored++
		var covered uint64
		cost := 0
		usedGroups := make(map[string]bool)
		ok := true
		for i := 0; i < n; i++ {
			if mask&(1<<uint(i)) == 0 {
				continue
			}
			if g := in.Spec.Assertions[i].SideEffectGroup; g != "" {
				if usedGroups[g] {
					ok = false
					break
				}
				usedGroups[g] = true
			}
			cost += in.Spec.Assertions[i].Cost
			covered |= in.cover[i]
		}
		if !ok || covered&target != target {
			continue
		}
		if cost < bestCost {
			bestCost = cost
			optima = 1
			best = Plan{Assertions: subsetIndices(mask, n), Cost: cost, Covered: covered}
		} else if cost == bestCost {
			optima++
		}
	}
	return best, optima, explored
}

func subsetIndices(mask, n int) []int {
	var out []int
	for i := 0; i < n; i++ {
		if mask&(1<<uint(i)) != 0 {
			out = append(out, i)
		}
	}
	return out
}

// Certificate is the coverage proof artifact emitted by the CLI.
type Certificate struct {
	Instance *Instance
	Selected Plan
	Greedy   Plan
	Optima   int
	Explored int
}

// Solve produces the minimum-cost plan and cross-checks it: the greedy plan
// is computed for reference, and exhaustive small-subset enumeration proves
// the selected plan's cost is minimal.
func Solve(in *Instance) Certificate {
	greedy := in.Greedy()
	best, optima, explored := in.Exhaustive()
	return Certificate{
		Instance: in,
		Selected: best,
		Greedy:   greedy,
		Optima:   optima,
		Explored: explored,
	}
}

// String renders the certificate as human-readable text.
func (c Certificate) String() string {
	in := c.Instance
	var b strings.Builder

	b.WriteString("================================================================\n")
	b.WriteString("COVERAGE CERTIFICATE - minimum-cost assertion selection\n")
	b.WriteString("================================================================\n")
	fmt.Fprintf(&b, "Instance: %d candidate assertions, %d fault models\n",
		len(in.Spec.Assertions), len(in.Spec.Models))
	fmt.Fprintf(&b, "Distinguishable models: %d/%d\n\n",
		len(in.Spec.Models)-len(in.indistinguishable), len(in.Spec.Models))

	if len(in.indistinguishable) == 0 {
		b.WriteString("Indistinguishable models: none\n\n")
	} else {
		b.WriteString("Indistinguishable models (listed separately; no candidate\n")
		b.WriteString("assertion separates them from normal, excluded from target):\n")
		for _, j := range in.indistinguishable {
			m := in.Spec.Models[j]
			fmt.Fprintf(&b, "  %-4s %s\n", m.ID, m.Name)
		}
		b.WriteString("\n")
	}

	if c.Optima == 0 {
		b.WriteString("STATUS: INFEASIBLE - side-effect mutual exclusion prevents\n")
		b.WriteString("covering every distinguishable model; no plan can be certified.\n")
		return b.String()
	}

	fmt.Fprintf(&b, "Selected plan (minimum total cost = %d):\n", c.Selected.Cost)
	for _, i := range c.Selected.Assertions {
		a := in.Spec.Assertions[i]
		group := a.SideEffectGroup
		if group == "" {
			group = "-"
		}
		fmt.Fprintf(&b, "  %-4s %-22s cost=%-3d side-effect=%s\n", a.ID, a.Name, a.Cost, group)
		fmt.Fprintf(&b, "       preconditions: %s\n", joinOrDash(a.Preconditions))
		fmt.Fprintf(&b, "       distinguishes: %s\n", strings.Join(a.Distinguishes, ", "))
	}
	b.WriteString("\n")

	fmt.Fprintf(&b, "Public preconditions required by the plan: %s\n\n", c.publicPreconditions())

	b.WriteString("Side-effect mutex groups (at most one assertion each):\n")
	groups := c.selectedGroups()
	if len(groups) == 0 {
		b.WriteString("  (no selected assertion has side effects)\n")
	}
	for _, g := range groups {
		fmt.Fprintf(&b, "  %-12s -> %s\n", g, c.groupOwner(g))
	}
	b.WriteString("\n")

	b.WriteString("Per-model separation from normal:\n")
	for j, m := range in.Spec.Models {
		bit := uint64(1) << uint(j)
		if c.Selected.Covered&bit == 0 {
			continue
		}
		var by []string
		for _, i := range c.Selected.Assertions {
			if in.cover[i]&bit != 0 {
				by = append(by, in.Spec.Assertions[i].ID)
			}
		}
		fmt.Fprintf(&b, "  %-4s %-22s <- %s\n", m.ID, m.Name, strings.Join(by, ", "))
	}
	b.WriteString("\n")

	b.WriteString("Optimality cross-check (small-subset enumeration):\n")
	if c.Greedy.Covered == in.distinguishable {
		fmt.Fprintf(&b, "  greedy plan cost ............. %d\n", c.Greedy.Cost)
	} else {
		b.WriteString("  greedy plan cost ............. infeasible (stalled on mutex)\n")
	}
	fmt.Fprintf(&b, "  exhaustive subsets explored .. %d (2^%d)\n", c.Explored, len(in.Spec.Assertions))
	fmt.Fprintf(&b, "  enumeration optimum .......... %d\n", c.Selected.Cost)
	fmt.Fprintf(&b, "  optimal plans at this cost ... %d\n", c.Optima)
	if c.Greedy.Covered == in.distinguishable && c.Greedy.Cost == c.Selected.Cost {
		b.WriteString("  STATUS: OPTIMAL (greedy also attains the minimum)\n")
	} else {
		b.WriteString("  STATUS: OPTIMAL (enumeration confirms the minimum)\n")
	}
	return b.String()
}

// publicPreconditions discloses the union of preconditions the selected plan
// relies on, sorted for stable output.
func (c Certificate) publicPreconditions() string {
	seen := make(map[string]bool)
	var list []string
	for _, i := range c.Selected.Assertions {
		for _, p := range c.Instance.Spec.Assertions[i].Preconditions {
			if !seen[p] {
				seen[p] = true
				list = append(list, p)
			}
		}
	}
	sort.Strings(list)
	return joinOrDash(list)
}

func (c Certificate) selectedGroups() []string {
	seen := make(map[string]bool)
	var groups []string
	for _, i := range c.Selected.Assertions {
		g := c.Instance.Spec.Assertions[i].SideEffectGroup
		if g != "" && !seen[g] {
			seen[g] = true
			groups = append(groups, g)
		}
	}
	sort.Strings(groups)
	return groups
}

func (c Certificate) groupOwner(group string) string {
	for _, i := range c.Selected.Assertions {
		if c.Instance.Spec.Assertions[i].SideEffectGroup == group {
			return c.Instance.Spec.Assertions[i].ID
		}
	}
	return ""
}

func joinOrDash(items []string) string {
	if len(items) == 0 {
		return "-"
	}
	return strings.Join(items, ", ")
}
