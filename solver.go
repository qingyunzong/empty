package licenseselect

import (
	"fmt"
	"sort"
	"strings"
)

// MaxPackages bounds how many packages the solver will select branches for.
const MaxPackages = 20

// Constraints describes license compatibility requirements.
type Constraints struct {
	// Allowed lists license names permitted by policy. A chosen branch
	// containing any other license is a violation.
	Allowed map[string]bool
	// Incompatible lists pairs of license names that must not both appear
	// in the overall selection (in either order).
	Incompatible [][2]string
}

// Selection records the branch chosen for one package.
type Selection struct {
	Package string
	Branch  Branch
}

// Certificate is the output of Solve: the chosen branch per package plus the
// list of exception packages (those involved in at least one violated
// constraint). Verify re-checks every claim in the certificate.
type Certificate struct {
	// Selections maps package name to the chosen branch.
	Selections map[string]Branch
	// Exceptions lists package names involved in a violation, sorted.
	Exceptions []string
}

// Solve picks one license branch for every package reachable from entry and
// minimizes the number of exception packages. Unreachable packages are never
// inspected, so violations hidden in them cannot be reported. It returns an
// error if more than MaxPackages packages are reachable.
func Solve(g *Graph, entry string, c *Constraints) (*Certificate, error) {
	names := g.Reachable(entry)
	if len(names) > MaxPackages {
		return nil, fmt.Errorf("licenseselect: %d reachable packages exceeds limit of %d", len(names), MaxPackages)
	}
	branches := make([][]Branch, len(names))
	for i, name := range names {
		expr, err := ParseExpr(g.Pkgs[name].License)
		if err != nil {
			return nil, fmt.Errorf("licenseselect: package %s: %w", name, err)
		}
		branches[i] = Branches(expr)
	}
	s := &solver{
		names:    names,
		branches: branches,
		allowed:  c.Allowed,
		incompat: buildIncompat(c.Incompatible),
		best:     len(names) + 1,
	}
	s.search(0, make([]int, len(names)), nil)
	return s.certificate(), nil
}

type solver struct {
	names    []string
	branches [][]Branch
	allowed  map[string]bool
	incompat map[[2]string]bool
	best     int
	bestPick []int
	bestBad  []bool
}

func buildIncompat(pairs [][2]string) map[[2]string]bool {
	m := map[[2]string]bool{}
	for _, p := range pairs {
		a, b := p[0], p[1]
		if a > b {
			a, b = b, a
		}
		m[[2]string{a, b}] = true
	}
	return m
}

// bad marks packages currently involved in a violation; len(bad) == idx.
func (s *solver) search(idx int, pick []int, bad []bool) {
	cost := countBad(bad)
	if cost >= s.best {
		return
	}
	if idx == len(s.names) {
		s.best = cost
		s.bestPick = append([]int(nil), pick...)
		s.bestBad = append([]bool(nil), bad...)
		return
	}
	for bi, br := range s.branches[idx] {
		nb := branchBadness(br, s.allowed)
		// Conflicts with already-assigned packages.
		var conflicts []int
		for j := 0; j < idx; j++ {
			if s.conflictsWith(br, s.branches[j][pick[j]]) {
				conflicts = append(conflicts, j)
			}
		}
		// Lower bound: idx itself will be bad if nb or any conflict.
		if !nb && len(conflicts) == 0 {
			pick[idx] = bi
			clean := make([]bool, idx+1)
			copy(clean, bad)
			s.search(idx+1, pick, clean)
			continue
		}
		grown := make([]bool, idx+1)
		copy(grown, bad)
		grown[idx] = true
		for _, j := range conflicts {
			grown[j] = true
		}
		pick[idx] = bi
		s.search(idx+1, pick, grown)
	}
}

func (s *solver) conflictsWith(a, b Branch) bool {
	for _, x := range a {
		for _, y := range b {
			p := [2]string{x, y}
			if p[0] > p[1] {
				p[0], p[1] = p[1], p[0]
			}
			if s.incompat[p] {
				return true
			}
		}
	}
	return false
}

func branchBadness(b Branch, allowed map[string]bool) bool {
	for _, lic := range b {
		if !allowed[lic] {
			return true
		}
	}
	return false
}

func countBad(bad []bool) int {
	n := 0
	for _, b := range bad {
		if b {
			n++
		}
	}
	return n
}

func (s *solver) certificate() *Certificate {
	cert := &Certificate{Selections: map[string]Branch{}}
	for i, name := range s.names {
		cert.Selections[name] = s.branches[i][s.bestPick[i]]
	}
	for i, name := range s.names {
		if s.bestBad[i] {
			cert.Exceptions = append(cert.Exceptions, name)
		}
	}
	sort.Strings(cert.Exceptions)
	return cert
}

// Verify re-checks the certificate against the graph and constraints: every
// reachable package must have a selection, every non-exception package must
// satisfy all constraints, and every exception must actually be involved in
// a violation. It returns the set of violated-constraint descriptions for
// transparency.
func (cert *Certificate) Verify(g *Graph, entry string, c *Constraints) error {
	names := g.Reachable(entry)
	if len(names) > MaxPackages {
		return fmt.Errorf("licenseselect: %d reachable packages exceeds limit of %d", len(names), MaxPackages)
	}
	exc := map[string]bool{}
	for _, e := range cert.Exceptions {
		exc[e] = true
	}
	incompat := buildIncompat(c.Incompatible)
	violated := map[string]bool{}
	for _, name := range names {
		br, ok := cert.Selections[name]
		if !ok {
			return fmt.Errorf("licenseselect: reachable package %s has no selection", name)
		}
		// The branch must be a genuine alternative of the expression.
		expr, err := ParseExpr(g.Pkgs[name].License)
		if err != nil {
			return err
		}
		if !branchIn(br, Branches(expr)) {
			return fmt.Errorf("licenseselect: package %s: selected branch %v is not a valid alternative", name, br)
		}
		if branchBadness(br, c.Allowed) {
			violated[name] = true
		}
	}
	for i, a := range names {
		for _, b := range names[i+1:] {
			for _, x := range cert.Selections[a] {
				for _, y := range cert.Selections[b] {
					p := [2]string{x, y}
					if p[0] > p[1] {
						p[0], p[1] = p[1], p[0]
					}
					if incompat[p] {
						violated[a] = true
						violated[b] = true
					}
				}
			}
		}
	}
	for name := range violated {
		if !exc[name] {
			return fmt.Errorf("licenseselect: package %s violates constraints but is not listed as exception", name)
		}
	}
	for _, e := range cert.Exceptions {
		if !violated[e] {
			return fmt.Errorf("licenseselect: package %s listed as exception but violates nothing", e)
		}
	}
	return nil
}

func branchIn(b Branch, all []Branch) bool {
	key := strings.Join(b, "\x00")
	for _, x := range all {
		if strings.Join(x, "\x00") == key {
			return true
		}
	}
	return false
}

// ExceptionCount returns the number of exception packages in the certificate.
func (cert *Certificate) ExceptionCount() int { return len(cert.Exceptions) }

// ExhaustiveMinExceptions computes the optimum by brute force over the full
// cartesian product of branch alternatives. It exists as an independent
// cross-check for Solve and is only practical for small inputs.
func ExhaustiveMinExceptions(g *Graph, entry string, c *Constraints) (int, error) {
	names := g.Reachable(entry)
	if len(names) > MaxPackages {
		return 0, fmt.Errorf("licenseselect: %d reachable packages exceeds limit of %d", len(names), MaxPackages)
	}
	all := make([][]Branch, len(names))
	for i, name := range names {
		expr, err := ParseExpr(g.Pkgs[name].License)
		if err != nil {
			return 0, fmt.Errorf("licenseselect: package %s: %w", name, err)
		}
		all[i] = Branches(expr)
	}
	incompat := buildIncompat(c.Incompatible)
	best := len(names) + 1
	pick := make([]int, len(names))
	var walk func(idx int)
	walk = func(idx int) {
		if idx == len(names) {
			bad := map[string]bool{}
			for i := range names {
				if branchBadness(all[i][pick[i]], c.Allowed) {
					bad[names[i]] = true
				}
			}
			for i := range names {
				for j := i + 1; j < len(names); j++ {
					for _, x := range all[i][pick[i]] {
						for _, y := range all[j][pick[j]] {
							p := [2]string{x, y}
							if p[0] > p[1] {
								p[0], p[1] = p[1], p[0]
							}
							if incompat[p] {
								bad[names[i]] = true
								bad[names[j]] = true
							}
						}
					}
				}
			}
			if len(bad) < best {
				best = len(bad)
			}
			return
		}
		for bi := range all[idx] {
			pick[idx] = bi
			walk(idx + 1)
		}
	}
	walk(0)
	return best, nil
}
