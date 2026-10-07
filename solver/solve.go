package solver

import (
	"fmt"
	"sort"
)

// Assignment maps package name to the selected version. It is the
// feasibility certificate: Verify can check it against the input.
type Assignment map[string]string

// constraint is the unified internal form of roots, dependencies and
// conflicts. A constraint fires when TriggerPkg is selected at TriggerVer
// (roots fire unconditionally). When fired, TargetPkg must (polarity
// require) or must not (polarity forbid) be selected inside Rng.
type constraint struct {
	Desc       string
	TriggerPkg string
	TriggerVer string
	TargetPkg  string
	Rng        Range
	Forbid     bool
}

func buildConstraints(in *Input) ([]constraint, error) {
	var cs []constraint
	for _, r := range in.Roots {
		rng, err := ParseRange(r.Range)
		if err != nil {
			return nil, err
		}
		cs = append(cs, constraint{
			Desc:      fmt.Sprintf("root %s@%s", r.Name, rng),
			TargetPkg: r.Name,
			Rng:       rng,
		})
	}
	for _, d := range in.Dependencies {
		rng, err := ParseRange(d.Range)
		if err != nil {
			return nil, err
		}
		cs = append(cs, constraint{
			Desc:       fmt.Sprintf("dep %s@%s -> %s@%s", d.From, d.FromVersion, d.To, rng),
			TriggerPkg: d.From,
			TriggerVer: d.FromVersion,
			TargetPkg:  d.To,
			Rng:        rng,
		})
	}
	for _, c := range in.Conflicts {
		rng, err := ParseRange(c.WithRange)
		if err != nil {
			return nil, err
		}
		cs = append(cs, constraint{
			Desc:       fmt.Sprintf("conflict %s@%s !! %s@%s", c.Package, c.Version, c.With, rng),
			TriggerPkg: c.Package,
			TriggerVer: c.Version,
			TargetPkg:  c.With,
			Rng:        rng,
			Forbid:     true,
		})
	}
	return cs, nil
}

// model is the preprocessed, solver-ready form of an Input plus a subset of
// active constraints.
type model struct {
	names    []string            // sorted package names
	versions map[string][]string // versions sorted descending
	rank     map[string]map[string]int
	lock     map[string]string
	tryOrder map[string][]string // locked version first, then descending
	cons     []constraint
}

func newModel(in *Input, active []bool) *model {
	m := &model{
		names:    in.sortedPackages(),
		versions: map[string][]string{},
		rank:     map[string]map[string]int{},
		lock:     in.Lock,
		tryOrder: map[string][]string{},
	}
	for _, p := range in.Packages {
		vs := append([]string(nil), p.Versions...)
		sort.Slice(vs, func(i, j int) bool { return CompareVersions(vs[i], vs[j]) > 0 })
		m.versions[p.Name] = vs
		m.rank[p.Name] = map[string]int{}
		for i, v := range vs {
			m.rank[p.Name][v] = i
		}
		order := append([]string(nil), vs...)
		if lv, ok := in.Lock[p.Name]; ok {
			for i, v := range order {
				if v == lv {
					copy(order[1:i+1], order[:i])
					order[0] = lv
					break
				}
			}
		}
		m.tryOrder[p.Name] = order
	}
	all, _ := buildConstraints(in)
	for i, c := range all {
		if active == nil || active[i] {
			m.cons = append(m.cons, c)
		}
	}
	return m
}

// consistent reports whether the partial assignment satisfies every fired
// constraint, with forward checking on unassigned targets.
func (m *model) consistent(asgn map[string]string) bool {
	for _, c := range m.cons {
		if c.TriggerPkg != "" {
			if v, ok := asgn[c.TriggerPkg]; !ok || v != c.TriggerVer {
				continue
			}
		}
		tv, assigned := asgn[c.TargetPkg]
		if assigned {
			if c.Rng.Satisfied(tv) == c.Forbid {
				return false
			}
			continue
		}
		// Forward check: the target must retain at least one usable version.
		usable := false
		for _, v := range m.versions[c.TargetPkg] {
			if c.Rng.Satisfied(v) != c.Forbid {
				usable = true
				break
			}
		}
		if !usable {
			return false
		}
	}
	return true
}

// changes counts selected versions differing from the lock file.
func (m *model) changes(asgn map[string]string) int {
	n := 0
	for name, lv := range m.lock {
		if asgn[name] != lv {
			n++
		}
	}
	return n
}

// better reports whether full assignment a is preferable to b: fewer lock
// changes first, then lexicographically higher versions in sorted package
// order.
func (m *model) better(a, b map[string]string) bool {
	ca, cb := m.changes(a), m.changes(b)
	if ca != cb {
		return ca < cb
	}
	for _, name := range m.names {
		ra, rb := m.rank[name][a[name]], m.rank[name][b[name]]
		if ra != rb {
			return ra < rb
		}
	}
	return false
}

// solve runs branch and bound over packages in sorted name order.
func (m *model) solve() (Assignment, bool) {
	var best map[string]string
	bestChanges := len(m.lock) + 1
	cur := map[string]string{}

	var dfs func(i int, curChanges int)
	dfs = func(i int, curChanges int) {
		if best != nil {
			if curChanges > bestChanges {
				return
			}
			if curChanges == bestChanges {
				// Lexicographic bound: if the assigned prefix is already
				// version-worse than best, no completion can win.
				for j := 0; j < i; j++ {
					name := m.names[j]
					rc, rb := m.rank[name][cur[name]], m.rank[name][best[name]]
					if rc != rb {
						if rc > rb {
							return
						}
						break
					}
				}
			}
		}
		if i == len(m.names) {
			if best == nil || m.better(cur, best) {
				best = make(map[string]string, len(cur))
				for k, v := range cur {
					best[k] = v
				}
				bestChanges = m.changes(best)
			}
			return
		}
		name := m.names[i]
		for _, v := range m.tryOrder[name] {
			delta := 0
			if lv, ok := m.lock[name]; ok && lv != v {
				delta = 1
			}
			cur[name] = v
			if m.consistent(cur) {
				dfs(i+1, curChanges+delta)
			}
		}
		delete(cur, name)
	}
	dfs(0, 0)
	if best == nil {
		return nil, false
	}
	return Assignment(best), true
}

// Solve finds the optimal assignment: fewest changes versus the lock file,
// then highest versions (lexicographic over package names). The returned
// assignment is the feasibility certificate.
func Solve(in *Input) (Assignment, bool) {
	return solveActive(in, nil)
}

func solveActive(in *Input, active []bool) (Assignment, bool) {
	return newModel(in, active).solve()
}

// Verify checks that asgn is a valid certificate for in: every package is
// assigned one of its declared versions and all constraints hold.
func Verify(in *Input, asgn Assignment) error {
	for _, p := range in.Packages {
		v, ok := asgn[p.Name]
		if !ok {
			return fmt.Errorf("package %q not assigned", p.Name)
		}
		found := false
		for _, dv := range p.Versions {
			if dv == v {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("package %q assigned undeclared version %q", p.Name, v)
		}
	}
	cons, err := buildConstraints(in)
	if err != nil {
		return err
	}
	m := map[string]string(asgn)
	for _, c := range cons {
		if c.TriggerPkg != "" && m[c.TriggerPkg] != c.TriggerVer {
			continue
		}
		if c.Rng.Satisfied(m[c.TargetPkg]) == c.Forbid {
			return fmt.Errorf("violated constraint: %s (selected %s@%s)", c.Desc, c.TargetPkg, m[c.TargetPkg])
		}
	}
	return nil
}
