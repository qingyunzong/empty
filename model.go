package main

import (
	"fmt"
	"sort"
)

// Interface is a finite interface type: named members that are either
// fields (with a type) or methods (with parameter and result types).
// Member types are references: a primitive name, "any", or the name of
// another interface declared in the same environment.
type Interface struct {
	Fields  map[string]string   `json:"fields"`
	Methods map[string]*FuncSig `json:"methods"`
}

// FuncSig is a method signature. Params are contravariant positions,
// Result is a covariant position.
type FuncSig struct {
	Params []string `json:"params"`
	Result string   `json:"result"`
}

// Query asks whether Sub is usable where Super is expected (Sub <: Super).
type Query struct {
	Sub   string `json:"sub"`
	Super string `json:"super"`
}

// Document is the CLI input: a finite type graph plus queries.
type Document struct {
	Types   map[string]*Interface `json:"types"`
	Queries []Query               `json:"queries"`
}

var primitives = map[string]bool{
	"int":     true,
	"string":  true,
	"bool":    true,
	"float64": true,
}

const anyType = "any"

// Env is a validated type environment.
type Env struct {
	types map[string]*Interface
}

// NewEnv validates the raw declarations and builds an environment.
func NewEnv(decls map[string]*Interface) (*Env, error) {
	env := &Env{types: decls}
	for name, iface := range decls {
		if primitives[name] || name == anyType {
			return nil, fmt.Errorf("type %q conflicts with a built-in type", name)
		}
		if iface == nil {
			return nil, fmt.Errorf("type %q has no definition", name)
		}
		for field := range iface.Fields {
			if _, ok := iface.Methods[field]; ok {
				return nil, fmt.Errorf("type %q: member %q declared as both field and method", name, field)
			}
		}
		checkRef := func(ref, where string) error {
			if primitives[ref] || ref == anyType {
				return nil
			}
			if _, ok := decls[ref]; !ok {
				return fmt.Errorf("type %q: %s references unknown type %q", name, where, ref)
			}
			return nil
		}
		for field, ref := range iface.Fields {
			if err := checkRef(ref, "field "+field); err != nil {
				return nil, err
			}
		}
		for m, sig := range iface.Methods {
			if sig == nil {
				return nil, fmt.Errorf("type %q: method %q has no signature", name, m)
			}
			for i, ref := range sig.Params {
				if err := checkRef(ref, fmt.Sprintf("method %s param %d", m, i)); err != nil {
					return nil, err
				}
			}
			if err := checkRef(sig.Result, "method "+m+" result"); err != nil {
				return nil, err
			}
		}
	}
	return env, nil
}

// lookup resolves a type reference.
func (e *Env) lookup(name string) (iface *Interface, isIface, isPrim, isAny bool) {
	if name == anyType {
		return nil, false, false, true
	}
	if primitives[name] {
		return nil, false, true, false
	}
	iface, ok := e.types[name]
	return iface, ok, false, false
}

// memberNames returns the sorted union of field and method names.
func memberNames(iface *Interface) []string {
	names := make([]string, 0, len(iface.Fields)+len(iface.Methods))
	for n := range iface.Fields {
		names = append(names, n)
	}
	for n := range iface.Methods {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
