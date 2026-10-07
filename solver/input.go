package solver

import (
	"fmt"
	"sort"
)

// Input describes an offline dependency resolution problem: up to 16
// packages with up to 4 versions each, version-ranged dependencies,
// mutual-exclusion conflicts, root requirements and an optional existing
// lock file.
type Input struct {
	Packages     []Package         `json:"packages"`
	Dependencies []Dependency      `json:"dependencies"`
	Conflicts    []Conflict        `json:"conflicts"`
	Roots        []Root            `json:"roots"`
	Lock         map[string]string `json:"lock"`
}

type Package struct {
	Name     string   `json:"name"`
	Versions []string `json:"versions"`
}

// Dependency: when package From is selected at version FromVersion,
// package To must be selected at a version inside Range.
type Dependency struct {
	From        string `json:"from"`
	FromVersion string `json:"from_version"`
	To          string `json:"to"`
	Range       string `json:"range"`
}

// Conflict: package P at version Version is mutually exclusive with any
// version of With inside WithRange.
type Conflict struct {
	Package   string `json:"package"`
	Version   string `json:"version"`
	With      string `json:"with"`
	WithRange string `json:"with_range"`
}

// Root constrains the selected version of a required package.
type Root struct {
	Name  string `json:"name"`
	Range string `json:"range"`
}

const (
	MaxPackages       = 16
	MaxVersionsPerPkg = 4
)

// Validate checks structural limits and referential integrity.
func (in *Input) Validate() error {
	if len(in.Packages) == 0 {
		return fmt.Errorf("no packages declared")
	}
	if len(in.Packages) > MaxPackages {
		return fmt.Errorf("too many packages: %d > %d", len(in.Packages), MaxPackages)
	}
	seen := map[string]bool{}
	vers := map[string]map[string]bool{}
	for _, p := range in.Packages {
		if p.Name == "" {
			return fmt.Errorf("package with empty name")
		}
		if seen[p.Name] {
			return fmt.Errorf("duplicate package %q", p.Name)
		}
		seen[p.Name] = true
		if len(p.Versions) == 0 {
			return fmt.Errorf("package %q has no versions", p.Name)
		}
		if len(p.Versions) > MaxVersionsPerPkg {
			return fmt.Errorf("package %q has %d versions > %d", p.Name, len(p.Versions), MaxVersionsPerPkg)
		}
		vs := map[string]bool{}
		for _, v := range p.Versions {
			if vs[v] {
				return fmt.Errorf("package %q: duplicate version %q", p.Name, v)
			}
			vs[v] = true
		}
		vers[p.Name] = vs
	}
	checkPkg := func(name, ctx string) error {
		if !seen[name] {
			return fmt.Errorf("%s: unknown package %q", ctx, name)
		}
		return nil
	}
	checkVer := func(name, ver, ctx string) error {
		if err := checkPkg(name, ctx); err != nil {
			return err
		}
		if !vers[name][ver] {
			return fmt.Errorf("%s: unknown version %q of package %q", ctx, ver, name)
		}
		return nil
	}
	for i, d := range in.Dependencies {
		ctx := fmt.Sprintf("dependencies[%d]", i)
		if err := checkVer(d.From, d.FromVersion, ctx); err != nil {
			return err
		}
		if err := checkPkg(d.To, ctx); err != nil {
			return err
		}
		if _, err := ParseRange(d.Range); err != nil {
			return fmt.Errorf("%s: %v", ctx, err)
		}
	}
	for i, c := range in.Conflicts {
		ctx := fmt.Sprintf("conflicts[%d]", i)
		if err := checkVer(c.Package, c.Version, ctx); err != nil {
			return err
		}
		if err := checkPkg(c.With, ctx); err != nil {
			return err
		}
		if _, err := ParseRange(c.WithRange); err != nil {
			return fmt.Errorf("%s: %v", ctx, err)
		}
	}
	for i, r := range in.Roots {
		ctx := fmt.Sprintf("roots[%d]", i)
		if err := checkPkg(r.Name, ctx); err != nil {
			return err
		}
		if _, err := ParseRange(r.Range); err != nil {
			return fmt.Errorf("%s: %v", ctx, err)
		}
	}
	for name, v := range in.Lock {
		if err := checkVer(name, v, "lock"); err != nil {
			return err
		}
	}
	return nil
}

// sortedPackages returns package names in deterministic (sorted) order.
func (in *Input) sortedPackages() []string {
	names := make([]string, 0, len(in.Packages))
	for _, p := range in.Packages {
		names = append(names, p.Name)
	}
	sort.Strings(names)
	return names
}
