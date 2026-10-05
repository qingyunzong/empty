package licchk

import (
	"errors"
	"fmt"
	"sort"
)

// MaxPackages is the maximum number of reachable packages Solve will select
// license branches for.
const MaxPackages = 20

// ErrTooManyPackages is returned when more than MaxPackages packages are
// reachable from the entry point.
var ErrTooManyPackages = errors.New("licchk: more than 20 reachable packages")

// Problem bundles the inputs of a license-selection run.
type Problem struct {
	// Packages maps package name to its license expression. Every package
	// reachable from Entry must be present.
	Packages map[string]Expr
	// Graph is the dependency graph.
	Graph Graph
	// Entry is the root package of the reachability traversal.
	Entry string
	// Policy holds the compatibility constraints.
	Policy Policy
}

// solveState is the shared search context for Solve and solveExhaustive.
type solveState struct {
	names      []string
	opts       [][]Option // opts[i]: all options of package i
	valid      [][]bool   // valid[i][j]: option j of package i is self-consistent
	incompat   map[[2]string]struct{}
	chosen     []int // chosen[i]: option index, -1 = exception, -2 = undecided
	bestCost   int
	best       []int
	exhaustive bool
}

func newSolveState(p Problem) (*solveState, error) {
	reachable := Reachable(p.Graph, p.Entry)
	if len(reachable) > MaxPackages {
		return nil, fmt.Errorf("%w: %d reachable from %q", ErrTooManyPackages, len(reachable), p.Entry)
	}
	forbidden := p.Policy.forbiddenSet()
	incompat := p.Policy.incompatibleSet()
	st := &solveState{
		names:    reachable,
		incompat: incompat,
		bestCost: len(reachable) + 1,
	}
	for _, name := range reachable {
		expr, ok := p.Packages[name]
		if !ok {
			return nil, fmt.Errorf("licchk: no license expression for reachable package %q", name)
		}
		opts := Options(expr)
		valid := make([]bool, len(opts))
		for j, o := range opts {
			valid[j] = !optionSelfViolates(o, forbidden, incompat)
		}
		st.opts = append(st.opts, opts)
		st.valid = append(st.valid, valid)
	}
	st.chosen = make([]int, len(reachable))
	for i := range st.chosen {
		st.chosen[i] = -2
	}
	return st, nil
}

// conflictsWithChosen reports whether assigning option j to package i
// conflicts with any already-assigned non-exception package.
func (st *solveState) conflictsWithChosen(i, j int) bool {
	for k := 0; k < i; k++ {
		if st.chosen[k] < 0 {
			continue
		}
		if optionsConflict(st.opts[i][j], st.opts[k][st.chosen[k]], st.incompat) {
			return true
		}
	}
	return false
}

func (st *solveState) search(i, cost int) {
	if !st.exhaustive && cost >= st.bestCost {
		return
	}
	if i == len(st.names) {
		if cost < st.bestCost {
			st.bestCost = cost
			st.best = append([]int(nil), st.chosen...)
		}
		return
	}
	for j := range st.opts[i] {
		if !st.valid[i][j] || st.conflictsWithChosen(i, j) {
			continue
		}
		st.chosen[i] = j
		st.search(i+1, cost)
	}
	st.chosen[i] = -1 // exception
	st.search(i+1, cost+1)
	st.chosen[i] = -2
}

// Solve selects one license branch per reachable package (at most
// MaxPackages) minimizing the number of exceptions, using branch-and-bound.
// The result is a verifiable Certificate. Unreachable packages are never
// inspected and never reported.
func Solve(p Problem) (*Certificate, error) {
	st, err := newSolveState(p)
	if err != nil {
		return nil, err
	}
	st.search(0, 0)
	return st.certificate(p), nil
}

// solveExhaustive explores the full assignment tree without pruning and
// returns the minimal exception count. It exists to cross-check Solve.
func solveExhaustive(p Problem) (int, error) {
	st, err := newSolveState(p)
	if err != nil {
		return 0, err
	}
	st.exhaustive = true
	st.search(0, 0)
	return st.bestCost, nil
}

func (st *solveState) certificate(p Problem) *Certificate {
	cert := &Certificate{
		Entry:     p.Entry,
		Reachable: append([]string(nil), st.names...),
		Choices:   make(map[string]int),
		Selected:  make(map[string]Option),
	}
	for i, name := range st.names {
		if st.best[i] >= 0 {
			cert.Choices[name] = st.best[i]
			cert.Selected[name] = append(Option(nil), st.opts[i][st.best[i]]...)
		} else {
			cert.Exceptions = append(cert.Exceptions, name)
		}
	}
	return cert
}

// Certificate is a selection certificate: the reachable set, the chosen
// license branch per compliant package, and the minimal list of exceptions.
type Certificate struct {
	Entry      string
	Reachable  []string          // sorted, reachable packages from Entry
	Choices    map[string]int    // package -> option index into Options(expr)
	Selected   map[string]Option // package -> concrete chosen license set
	Exceptions []string          // sorted packages left as exceptions
}

// NumExceptions reports how many packages are exceptions.
func (c *Certificate) NumExceptions() int { return len(c.Exceptions) }

// Verify checks the certificate against the package expressions, the
// dependency graph and the policy. It confirms that the reachable set is
// exactly the set reachable from Entry (so cyclic graphs are handled and no
// unreachable package is reported), that choices and exceptions partition
// the reachable set, that every choice is a valid branch of the package's
// expression, that Selected matches Choices, and that no compatibility
// constraint is violated by any chosen branch.
func (c *Certificate) Verify(p Problem) error {
	if c.Entry != p.Entry {
		return fmt.Errorf("licchk: certificate entry %q != problem entry %q", c.Entry, p.Entry)
	}
	want := Reachable(p.Graph, p.Entry)
	if !equalStrings(c.Reachable, want) {
		return fmt.Errorf("licchk: certificate reachable set mismatch: got %v, want %v", c.Reachable, want)
	}
	if !sort.StringsAreSorted(c.Exceptions) {
		return fmt.Errorf("licchk: exceptions not sorted")
	}
	seen := make(map[string]bool, len(want))
	for _, name := range c.Exceptions {
		if seen[name] {
			return fmt.Errorf("licchk: duplicate exception %q", name)
		}
		seen[name] = true
	}
	for name := range c.Choices {
		if seen[name] {
			return fmt.Errorf("licchk: package %q is both chosen and exception", name)
		}
		seen[name] = true
	}
	for _, name := range want {
		if !seen[name] {
			return fmt.Errorf("licchk: reachable package %q missing from certificate", name)
		}
	}
	if len(seen) != len(want) {
		for name := range seen {
			found := false
			for _, w := range want {
				if w == name {
					found = true
					break
				}
			}
			if !found {
				return fmt.Errorf("licchk: certificate covers unreachable package %q", name)
			}
		}
	}
	forbidden := p.Policy.forbiddenSet()
	incompat := p.Policy.incompatibleSet()
	var chosenNames []string
	for name := range c.Choices {
		chosenNames = append(chosenNames, name)
	}
	sort.Strings(chosenNames)
	chosenOpts := make(map[string]Option, len(chosenNames))
	for _, name := range chosenNames {
		expr, ok := p.Packages[name]
		if !ok {
			return fmt.Errorf("licchk: no license expression for chosen package %q", name)
		}
		opts := Options(expr)
		idx := c.Choices[name]
		if idx < 0 || idx >= len(opts) {
			return fmt.Errorf("licchk: choice index %d out of range for %q (%d options)", idx, name, len(opts))
		}
		opt := opts[idx]
		if sel, ok := c.Selected[name]; !ok {
			return fmt.Errorf("licchk: Selected missing entry for %q", name)
		} else if !equalStrings(sel, opt) {
			return fmt.Errorf("licchk: Selected[%q] = %v does not match option %d = %v", name, sel, idx, opt)
		}
		if optionSelfViolates(opt, forbidden, incompat) {
			return fmt.Errorf("licchk: chosen option %v for %q violates policy", opt, name)
		}
		chosenOpts[name] = opt
	}
	for name := range c.Selected {
		if _, ok := c.Choices[name]; !ok {
			return fmt.Errorf("licchk: Selected has entry for non-chosen package %q", name)
		}
	}
	for i := 0; i < len(chosenNames); i++ {
		for j := i + 1; j < len(chosenNames); j++ {
			a, b := chosenNames[i], chosenNames[j]
			if optionsConflict(chosenOpts[a], chosenOpts[b], incompat) {
				return fmt.Errorf("licchk: chosen options of %q and %q are incompatible", a, b)
			}
		}
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
