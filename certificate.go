package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"sort"
	"strings"
)

// certificate is the machine-checkable output of a solve: the selection,
// the full coverage witness, and the search bounds proving optimality.
type certificate struct {
	Status    string `json:"status"` // "optimal" or "infeasible"
	Instance  string `json:"instance"`
	Objective struct {
		Cost  int `json:"cost"`
		Tests int `json:"tests"`
	} `json:"objective"`
	TimeUsed  int      `json:"time_used"`
	TimeLimit int      `json:"time_limit"`
	Selected  []string `json:"selected_tests,omitempty"`
	Coverage  struct {
		Covered  int      `json:"covered"`
		Total    int      `json:"total"`
		Elements []string `json:"elements,omitempty"`
		Missing  []string `json:"missing,omitempty"`
	} `json:"coverage"`
	Bounds struct {
		Lower   int    `json:"lower"`
		Upper   *int   `json:"upper"`
		Optimal *int   `json:"optimal"`
		Proof   string `json:"proof"`
	} `json:"bounds"`
	Stats struct {
		Nodes     int   `json:"nodes"`
		Pruned    int   `json:"pruned"`
		ElapsedMs int64 `json:"elapsed_ms"`
	} `json:"stats"`
	Checksum string `json:"checksum"`
}

func buildCertificate(m *model, r result) *certificate {
	c := &certificate{Instance: m.spec.Name, TimeLimit: m.spec.TimeLimit}
	c.Coverage.Total = len(m.elemNames)
	c.Stats.Nodes = r.nodes
	c.Stats.Pruned = r.pruned
	c.Stats.ElapsedMs = r.elapsed.Milliseconds()
	c.Bounds.Lower = r.initialLower
	if r.initialUpper != math.MaxInt {
		up := r.initialUpper
		c.Bounds.Upper = &up
	}

	if !r.feasible {
		c.Status = "infeasible"
		c.Coverage.Missing = m.uncoverable()
		if len(c.Coverage.Missing) == 0 {
			c.Bounds.Proof = "no feasible selection within time_limit; search tree exhausted"
		} else {
			c.Bounds.Proof = "universe elements are uncoverable by any test"
		}
		c.Checksum = checksum(c.Instance, nil, 0, 0, c.Coverage.Missing)
		return c
	}

	c.Status = "optimal"
	c.Objective.Cost = r.obj.cost
	c.Objective.Tests = r.obj.count
	opt := r.obj.cost
	c.Bounds.Optimal = &opt
	// The optimum itself is the tightest known upper bound once the
	// search completes, even if the greedy seed failed to find one.
	if c.Bounds.Upper == nil || *c.Bounds.Upper > opt {
		c.Bounds.Upper = &opt
	}
	c.Bounds.Proof = "branch-and-bound exhausted the search tree; lower bound meets upper bound"

	covered := newBitset(len(m.elemNames))
	for _, t := range r.tests {
		c.Selected = append(c.Selected, m.spec.Tests[t].Name)
		covered.or(m.cov[t])
		c.TimeUsed += m.dur[t]
	}
	for _, e := range covered.indices() {
		c.Coverage.Elements = append(c.Coverage.Elements, m.elemNames[e])
	}
	c.Coverage.Covered = len(c.Coverage.Elements)
	sort.Strings(c.Selected)
	c.Checksum = checksum(c.Instance, c.Selected, r.obj.cost, r.obj.count, c.Coverage.Elements)
	return c
}

// checksum is a deterministic FNV-1a digest of the certificate's core
// claims, so a certificate can be spot-checked for tampering.
func checksum(instance string, selected []string, cost, count int, elements []string) string {
	h := fnv.New64a()
	sorted := append([]string(nil), elements...)
	sort.Strings(sorted)
	fmt.Fprintf(h, "%s|%d|%d|%s|%s", instance, cost, count,
		strings.Join(selected, ","), strings.Join(sorted, ","))
	return fmt.Sprintf("fnv1a64:%016x", h.Sum64())
}

func (c *certificate) json() (string, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(c); err != nil {
		return "", err
	}
	return strings.TrimRight(b.String(), "\n"), nil
}

// summary renders a short human-readable report.
func (c *certificate) summary() string {
	var b strings.Builder
	fmt.Fprintf(&b, "instance:   %s\n", c.Instance)
	fmt.Fprintf(&b, "status:     %s\n", c.Status)
	if c.Status == "optimal" {
		fmt.Fprintf(&b, "objective:  cost=%d tests=%d (lexicographic: cost, then count)\n",
			c.Objective.Cost, c.Objective.Tests)
		fmt.Fprintf(&b, "time:       %d / %d\n", c.TimeUsed, c.TimeLimit)
		fmt.Fprintf(&b, "selected:   %s\n", strings.Join(c.Selected, ", "))
		fmt.Fprintf(&b, "coverage:   %d / %d elements\n", c.Coverage.Covered, c.Coverage.Total)
	} else if len(c.Coverage.Missing) > 0 {
		fmt.Fprintf(&b, "uncoverable elements: %s\n", strings.Join(c.Coverage.Missing, ", "))
	} else {
		fmt.Fprintf(&b, "no feasible selection within time_limit=%d\n", c.TimeLimit)
	}
	upper := "none"
	if c.Bounds.Upper != nil {
		upper = fmt.Sprintf("%d", *c.Bounds.Upper)
	}
	fmt.Fprintf(&b, "bounds:     lower=%d upper=%s\n", c.Bounds.Lower, upper)
	fmt.Fprintf(&b, "proof:      %s\n", c.Bounds.Proof)
	fmt.Fprintf(&b, "stats:      nodes=%d pruned=%d elapsed=%dms\n",
		c.Stats.Nodes, c.Stats.Pruned, c.Stats.ElapsedMs)
	fmt.Fprintf(&b, "checksum:   %s\n", c.Checksum)
	return b.String()
}
