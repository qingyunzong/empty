// Package config implements an INI-style configuration library with
// section inheritance and field interpolation.
//
// Resolution model: inheritance is resolved first (parents are merged in
// the order listed by "extends", earlier parents win conflicts, and the
// section's own fields override everything inherited). Interpolation of
// ${key} / ${section.key} references is then expanded against the final
// merged fields of the target section.
package config

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

// Field is a single key/value pair as parsed from a file.
type Field struct {
	Key   string
	Value string
	Line  int
}

// Section is a parsed [section] block.
type Section struct {
	Name    string
	Extends []string
	Fields  map[string]Field // own fields only (extends is reserved)
	Order   []string         // own field keys in file order
	Line    int
}

// Config is a parsed configuration file.
type Config struct {
	Sections map[string]*Section
	Order    []string // section names in file order
}

// CycleError reports a dependency cycle; Path starts and ends with the
// same node, e.g. [a b c a].
type CycleError struct {
	Kind string // "inheritance" or "interpolation"
	Path []string
}

func (e *CycleError) Error() string {
	return fmt.Sprintf("%s cycle detected: %s", e.Kind, strings.Join(e.Path, " -> "))
}

// MissingRefError reports a reference to a section or field that does
// not exist after inheritance resolution.
type MissingRefError struct {
	Ref string // "section.key"
}

func (e *MissingRefError) Error() string {
	return fmt.Sprintf("missing reference: %s", e.Ref)
}

// Parse reads an INI-style document. Lines may be blank, comments
// (starting with # or ;), section headers ([name]) or key = value pairs.
// The key "extends" is reserved: its comma-separated value lists parent
// sections and is not stored as a field.
func Parse(r io.Reader) (*Config, error) {
	c := &Config{Sections: map[string]*Section{}}
	var cur *Section
	sc := bufio.NewScanner(r)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			if !strings.HasSuffix(line, "]") {
				return nil, fmt.Errorf("line %d: malformed section header %q", lineNo, line)
			}
			name := strings.TrimSpace(line[1 : len(line)-1])
			if name == "" {
				return nil, fmt.Errorf("line %d: empty section name", lineNo)
			}
			if _, dup := c.Sections[name]; dup {
				return nil, fmt.Errorf("line %d: duplicate section %q", lineNo, name)
			}
			cur = &Section{Name: name, Fields: map[string]Field{}, Line: lineNo}
			c.Sections[name] = cur
			c.Order = append(c.Order, name)
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			return nil, fmt.Errorf("line %d: expected key = value, got %q", lineNo, line)
		}
		if cur == nil {
			return nil, fmt.Errorf("line %d: key/value outside any section", lineNo)
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		if key == "" {
			return nil, fmt.Errorf("line %d: empty key", lineNo)
		}
		if key == "extends" {
			for _, p := range strings.Split(val, ",") {
				if p = strings.TrimSpace(p); p != "" {
					cur.Extends = append(cur.Extends, p)
				}
			}
			continue
		}
		if _, dup := cur.Fields[key]; dup {
			return nil, fmt.Errorf("line %d: duplicate key %q in section %q", lineNo, key, cur.Name)
		}
		cur.Fields[key] = Field{Key: key, Value: val, Line: lineNo}
		cur.Order = append(cur.Order, key)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return c, nil
}

// ResolvedField is a field after inheritance resolution, before
// interpolation. Source and Line identify where the raw value was
// defined.
type ResolvedField struct {
	Value  string
	Source string // section that defined the winning raw value
	Line   int
}

// Resolved holds the merged (pre-interpolation) view of a Config.
type Resolved struct {
	cfg      *Config
	sections map[string]map[string]ResolvedField
	order    map[string][]string
}

// Resolve merges every section with its ancestors. It fails with a
// *CycleError (Kind "inheritance") if the extends graph contains a
// cycle, or a plain error if a parent section does not exist.
func (c *Config) Resolve() (*Resolved, error) {
	r := &Resolved{
		cfg:      c,
		sections: map[string]map[string]ResolvedField{},
		order:    map[string][]string{},
	}
	visiting := map[string]bool{}
	var stack []string
	var resolve func(name string) error
	resolve = func(name string) error {
		if _, done := r.sections[name]; done {
			return nil
		}
		sec, ok := c.Sections[name]
		if !ok {
			return fmt.Errorf("section %q extends unknown section %q", stack[len(stack)-1], name)
		}
		if visiting[name] {
			idx := 0
			for i, s := range stack {
				if s == name {
					idx = i
					break
				}
			}
			path := append(append([]string{}, stack[idx:]...), name)
			return &CycleError{Kind: "inheritance", Path: path}
		}
		visiting[name] = true
		stack = append(stack, name)
		merged := map[string]ResolvedField{}
		var order []string
		add := func(k string, f ResolvedField, overwrite bool) {
			if _, exists := merged[k]; !exists {
				order = append(order, k)
				merged[k] = f
			} else if overwrite {
				merged[k] = f
			}
		}
		for _, p := range sec.Extends {
			if err := resolve(p); err != nil {
				return err
			}
			for _, k := range r.order[p] {
				add(k, r.sections[p][k], false) // earlier parent wins
			}
		}
		for _, k := range sec.Order {
			f := sec.Fields[k]
			add(k, ResolvedField{Value: f.Value, Source: name, Line: f.Line}, true) // own wins
		}
		stack = stack[:len(stack)-1]
		visiting[name] = false
		r.sections[name] = merged
		r.order[name] = order
		return nil
	}
	for _, name := range c.Order {
		if err := resolve(name); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// Field returns the merged raw field for section.key.
func (r *Resolved) Field(section, key string) (ResolvedField, bool) {
	fields, ok := r.sections[section]
	if !ok {
		return ResolvedField{}, false
	}
	f, ok := fields[key]
	return f, ok
}

// Keys returns the merged field keys of a section in definition order.
func (r *Resolved) Keys(section string) []string {
	return append([]string{}, r.order[section]...)
}

// Sections lists section names in file order.
func (r *Resolved) Sections() []string {
	return append([]string{}, r.cfg.Order...)
}

// splitRef interprets a ${...} reference: a dotted ref is section.key,
// anything else is a key local to the given section.
func splitRef(ref, localSection string) (section, key string) {
	if i := strings.IndexByte(ref, '.'); i >= 0 {
		return ref[:i], ref[i+1:]
	}
	return localSection, ref
}

// interpolate expands ${...} references in a raw value using resolve.
func interpolate(value string, resolve func(ref string) (string, error)) (string, error) {
	var b strings.Builder
	i := 0
	for i < len(value) {
		if value[i] == '$' && i+1 < len(value) && value[i+1] == '{' {
			end := strings.IndexByte(value[i+2:], '}')
			if end < 0 {
				return "", fmt.Errorf("unterminated ${...} in value %q", value)
			}
			ref := strings.TrimSpace(value[i+2 : i+2+end])
			if ref == "" {
				return "", fmt.Errorf("empty ${} reference in value %q", value)
			}
			rep, err := resolve(ref)
			if err != nil {
				return "", err
			}
			b.WriteString(rep)
			i += 2 + end + 1
			continue
		}
		b.WriteByte(value[i])
		i++
	}
	return b.String(), nil
}

// References returns the ${...} references appearing in a raw value.
func References(value string) ([]string, error) {
	var refs []string
	_, err := interpolate(value, func(ref string) (string, error) {
		refs = append(refs, ref)
		return "", nil
	})
	return refs, err
}

// expand recursively interpolates section.key against the final merged
// fields, tracking the reference stack for cycle detection.
func (r *Resolved) expand(section, key string, stack []string) (string, error) {
	id := section + "." + key
	for _, s := range stack {
		if s == id {
			path := append(append([]string{}, stack...), id)
			return "", &CycleError{Kind: "interpolation", Path: path}
		}
	}
	f, ok := r.Field(section, key)
	if !ok {
		return "", &MissingRefError{Ref: id}
	}
	stack = append(stack, id)
	return interpolate(f.Value, func(ref string) (string, error) {
		ts, tk := splitRef(ref, section)
		return r.expand(ts, tk, stack)
	})
}

// Get returns the fully interpolated value of section.key. It fails
// with *CycleError (Kind "interpolation") on reference cycles and with
// *MissingRefError on references to unknown sections or fields.
func (r *Resolved) Get(section, key string) (string, error) {
	return r.expand(section, key, nil)
}

// LookupField implements the per-field recursive model: starting at
// section, find the winning raw field for key by checking the section
// itself, then walking each parent's subtree depth-first in extends
// order. This is the field-at-a-time counterpart of Resolve.
func (c *Config) LookupField(section, key string) (ResolvedField, bool) {
	visited := map[string]bool{}
	var walk func(name string) (ResolvedField, bool)
	walk = func(name string) (ResolvedField, bool) {
		if visited[name] {
			return ResolvedField{}, false
		}
		visited[name] = true
		sec, ok := c.Sections[name]
		if !ok {
			return ResolvedField{}, false
		}
		if f, ok := sec.Fields[key]; ok {
			return ResolvedField{Value: f.Value, Source: name, Line: f.Line}, true
		}
		for _, p := range sec.Extends {
			if f, ok := walk(p); ok {
				return f, true
			}
		}
		return ResolvedField{}, false
	}
	return walk(section)
}

// CompareModels cross-checks the merged-section model (Resolve) against
// the per-field recursive model (LookupField) for every resolved field.
// It returns a list of human-readable differences; empty means the two
// models agree.
func (r *Resolved) CompareModels() []string {
	var diffs []string
	for _, sec := range r.cfg.Order {
		for _, k := range r.order[sec] {
			merged := r.sections[sec][k]
			pf, ok := r.cfg.LookupField(sec, k)
			if !ok {
				diffs = append(diffs, fmt.Sprintf("%s.%s: merged model has %q (from [%s]) but per-field model found nothing", sec, k, merged.Value, merged.Source))
				continue
			}
			if merged.Value != pf.Value || merged.Source != pf.Source {
				diffs = append(diffs, fmt.Sprintf("%s.%s: merged=%q (from [%s]) per-field=%q (from [%s])", sec, k, merged.Value, merged.Source, pf.Value, pf.Source))
			}
		}
	}
	return diffs
}

// InheritancePath returns the extends chain from section `from` to
// ancestor `to` (depth-first, extends order), or nil if `to` is not an
// ancestor of `from`. If from == to the path is [from].
func (c *Config) InheritancePath(from, to string) []string {
	visited := map[string]bool{}
	var walk func(name string) []string
	walk = func(name string) []string {
		if name == to {
			return []string{name}
		}
		if visited[name] {
			return nil
		}
		visited[name] = true
		sec, ok := c.Sections[name]
		if !ok {
			return nil
		}
		for _, p := range sec.Extends {
			if rest := walk(p); rest != nil {
				return append([]string{name}, rest...)
			}
		}
		return nil
	}
	return walk(from)
}
