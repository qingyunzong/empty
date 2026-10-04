package cfg

import (
	"fmt"
	"regexp"
	"strings"
)

// CycleError reports a cycle in inheritance or field interpolation.
// Path lists the nodes in visit order, with the first node repeated at
// the end to close the loop, e.g. [a b c a].
type CycleError struct {
	Kind string // "inheritance" or "interpolation"
	Path []string
}

func (e *CycleError) Error() string {
	return fmt.Sprintf("%s cycle detected: %s", e.Kind, strings.Join(e.Path, " -> "))
}

// MissingError reports a reference to a section or field that does not exist.
type MissingError struct{ Msg string }

func (e *MissingError) Error() string { return e.Msg }

// Section is a fully resolved section.
type Section struct {
	Name    string
	Parents []string
	// Fields holds the merged raw values: ancestors first (parents in
	// listed order, later parents overriding earlier ones), then this
	// section's own fields overriding everything inherited.
	Fields map[string]string
	// Origin maps each field to the section whose definition won.
	Origin map[string]string
	// Values holds the final values after interpolation against Fields.
	Values map[string]string
	// Refs maps each field to the direct references used while expanding it.
	Refs map[string][]Ref
}

// Ref identifies one field in one section.
type Ref struct{ Section, Field string }

func (r Ref) String() string { return r.Section + "." + r.Field }

// Config is a parsed config file.
type Config struct {
	raw      map[string]*RawSection
	order    []string
	merged   bool
	Sections map[string]*Section
}

var refPattern = regexp.MustCompile(`\$\{([^}]+)\}`)

// parseRef parses "field" (same section) or "section.field".
func parseRef(text, ctxSection string) Ref {
	if sec, field, ok := strings.Cut(text, "."); ok {
		return Ref{Section: sec, Field: field}
	}
	return Ref{Section: ctxSection, Field: text}
}

// checkInheritance validates parent references and detects inheritance
// cycles, returning section names in topological order (parents first).
func (c *Config) checkInheritance() ([]string, error) {
	for _, name := range c.order {
		for _, p := range c.raw[name].Parents {
			if _, ok := c.raw[p]; !ok {
				return nil, &MissingError{Msg: fmt.Sprintf("section %q inherits from missing section %q", name, p)}
			}
		}
	}
	const (
		white = iota // unvisited
		gray         // on the current DFS stack
		black        // fully explored
	)
	color := map[string]int{}
	var stack []string
	var topo []string
	var visit func(name string) error
	visit = func(name string) error {
		switch color[name] {
		case black:
			return nil
		case gray:
			i := 0
			for i < len(stack) && stack[i] != name {
				i++
			}
			return &CycleError{Kind: "inheritance", Path: append(append([]string{}, stack[i:]...), name)}
		}
		color[name] = gray
		stack = append(stack, name)
		for _, p := range c.raw[name].Parents {
			if err := visit(p); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		color[name] = black
		topo = append(topo, name)
		return nil
	}
	for _, name := range c.order {
		if err := visit(name); err != nil {
			return nil, err
		}
	}
	return topo, nil
}

// mergeFields flattens inheritance into every section. Parents are merged
// in listed order (later parents override earlier ones); the section's own
// fields are applied last and always win.
func (c *Config) mergeFields() error {
	if c.merged {
		return nil
	}
	topo, err := c.checkInheritance()
	if err != nil {
		return err
	}
	if c.Sections == nil {
		c.Sections = map[string]*Section{}
	}
	for _, name := range topo {
		raw := c.raw[name]
		sec := &Section{
			Name:    name,
			Parents: raw.Parents,
			Fields:  map[string]string{},
			Origin:  map[string]string{},
			Values:  map[string]string{},
			Refs:    map[string][]Ref{},
		}
		for _, p := range raw.Parents {
			parent := c.Sections[p]
			for k, v := range parent.Fields {
				sec.Fields[k] = v
				sec.Origin[k] = parent.Origin[k]
			}
		}
		for _, k := range raw.OwnOrder {
			sec.Fields[k] = raw.Own[k]
			sec.Origin[k] = name
		}
		c.Sections[name] = sec
	}
	c.merged = true
	return nil
}

// Resolve builds the final view of every section with the flatten model:
// inheritance is merged first (child overrides parent), then interpolation
// expands against the final merged fields of the referencing section.
func (c *Config) Resolve() error {
	if err := c.mergeFields(); err != nil {
		return err
	}
	memo := map[Ref]string{}
	rec := map[Ref][]Ref{}
	for _, name := range c.order {
		sec := c.Sections[name]
		for _, field := range SortedFields(sec.Fields) {
			if _, err := c.expand(flatScope{c}, Ref{Section: name, Field: field}, nil, memo, rec); err != nil {
				return err
			}
		}
	}
	for _, name := range c.order {
		sec := c.Sections[name]
		for field := range sec.Fields {
			r := Ref{Section: name, Field: field}
			sec.Values[field] = memo[r]
			sec.Refs[field] = rec[r]
		}
	}
	return nil
}

// scope abstracts how the winning raw value of a field is found and which
// section's context its references expand in. This is the single point of
// difference between the flatten model and the per-field recursive model.
type scope interface {
	// raw resolves target to its winning raw value and returns the ref
	// whose context should be used to expand references inside it.
	raw(target Ref) (value string, interpCtx Ref, ok bool)
}

// flatScope serves the flatten model: fields come from the fully merged
// section, and references expand in the requesting section's final fields.
type flatScope struct{ c *Config }

func (s flatScope) raw(target Ref) (string, Ref, bool) {
	sec, ok := s.c.Sections[target.Section]
	if !ok {
		return "", Ref{}, false
	}
	v, ok := sec.Fields[target.Field]
	return v, target, ok
}

// recursiveScope serves the per-field recursive model: each field lookup
// walks the inheritance chain (own definition first, then parents from
// last to first, depth-first) to find the defining section, and references
// inside the winning value expand in the *defining* section's context.
type recursiveScope struct{ c *Config }

func (s recursiveScope) raw(target Ref) (string, Ref, bool) {
	definer, ok := s.findDefiner(target.Section, target.Field, map[string]bool{})
	if !ok {
		return "", Ref{}, false
	}
	ctx := Ref{Section: definer, Field: target.Field}
	return s.c.raw[definer].Own[target.Field], ctx, true
}

func (s recursiveScope) findDefiner(section, field string, seen map[string]bool) (string, bool) {
	if seen[section] {
		return "", false
	}
	seen[section] = true
	raw := s.c.raw[section]
	if _, ok := raw.Own[field]; ok {
		return section, true
	}
	for i := len(raw.Parents) - 1; i >= 0; i-- {
		if d, ok := s.findDefiner(raw.Parents[i], field, seen); ok {
			return d, true
		}
	}
	return "", false
}

// expand evaluates one field. memo caches results per interpolation
// context; rec records the direct references of each expanded ref.
// stack holds the refs currently being expanded, for cycle detection.
func (c *Config) expand(sc scope, target Ref, stack []Ref, memo map[Ref]string, rec map[Ref][]Ref) (string, error) {
	if _, ok := c.raw[target.Section]; !ok {
		return "", &MissingError{Msg: fmt.Sprintf("missing section %q referenced from %s", target.Section, lastRef(stack, target))}
	}
	rawVal, interpCtx, ok := sc.raw(target)
	if !ok {
		return "", &MissingError{Msg: fmt.Sprintf("missing reference ${%s} expanded from %s", target.Field, lastRef(stack, target))}
	}
	if v, done := memo[interpCtx]; done {
		return v, nil
	}
	for i, r := range stack {
		if r == interpCtx {
			path := make([]string, 0, len(stack)-i+1)
			for _, s := range stack[i:] {
				path = append(path, s.String())
			}
			path = append(path, interpCtx.String())
			return "", &CycleError{Kind: "interpolation", Path: path}
		}
	}
	stack = append(stack, interpCtx)
	var refs []Ref
	var err error
	out := refPattern.ReplaceAllStringFunc(rawVal, func(m string) string {
		if err != nil {
			return m
		}
		sub := parseRef(m[2:len(m)-1], interpCtx.Section)
		refs = append(refs, sub)
		var v string
		v, err = c.expand(sc, sub, stack, memo, rec)
		return v
	})
	if err != nil {
		return "", err
	}
	memo[interpCtx] = out
	rec[interpCtx] = refs
	return out, nil
}

func lastRef(stack []Ref, fallback Ref) Ref {
	if len(stack) == 0 {
		return fallback
	}
	return stack[len(stack)-1]
}
