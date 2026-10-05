package main

import "fmt"

// Reference model: for acyclic type graphs, expand named types into finite
// trees and check subtyping by plain structural recursion. This is an
// independent, obviously-correct implementation used to cross-check the
// coinductive checker on acyclic inputs.

// Tree is a fully expanded type.
type Tree struct {
	Prim    string // non-empty for primitive types
	Any     bool
	Fields  map[string]*Tree
	Methods map[string]*MethodTree
}

type MethodTree struct {
	Params []*Tree
	Result *Tree
}

// Expand unfolds a type reference into a Tree. It fails if the graph is
// recursive (a name repeats on the expansion stack).
func (e *Env) Expand(name string) (*Tree, error) {
	return e.expand(name, nil)
}

func (e *Env) expand(name string, stack []string) (*Tree, error) {
	if name == anyType {
		return &Tree{Any: true}, nil
	}
	if primitives[name] {
		return &Tree{Prim: name}, nil
	}
	for _, s := range stack {
		if s == name {
			return nil, fmt.Errorf("cyclic type graph at %q", name)
		}
	}
	iface, ok := e.types[name]
	if !ok {
		return nil, fmt.Errorf("unknown type %q", name)
	}
	t := &Tree{Fields: map[string]*Tree{}, Methods: map[string]*MethodTree{}}
	for field, ref := range iface.Fields {
		sub, err := e.expand(ref, append(stack, name))
		if err != nil {
			return nil, err
		}
		t.Fields[field] = sub
	}
	for m, sig := range iface.Methods {
		mt := &MethodTree{}
		for _, ref := range sig.Params {
			sub, err := e.expand(ref, append(stack, name))
			if err != nil {
				return nil, err
			}
			mt.Params = append(mt.Params, sub)
		}
		res, err := e.expand(sig.Result, append(stack, name))
		if err != nil {
			return nil, err
		}
		mt.Result = res
		t.Methods[m] = mt
	}
	return t, nil
}

// RefCompatible checks sub <: sup on expanded trees by structural
// recursion, mirroring the Checker rules (covariant fields and results,
// contravariant params, width subtyping, any as top).
func RefCompatible(sub, sup *Tree) bool {
	if sup.Any {
		return true
	}
	if sub.Any {
		return false
	}
	if sub.Prim != "" || sup.Prim != "" {
		return sub.Prim == sup.Prim && sub.Prim != ""
	}
	for name, supField := range sup.Fields {
		subField, ok := sub.Fields[name]
		if !ok || !RefCompatible(subField, supField) {
			return false
		}
	}
	for name, supSig := range sup.Methods {
		subSig, ok := sub.Methods[name]
		if !ok || len(subSig.Params) != len(supSig.Params) {
			return false
		}
		for i := range supSig.Params {
			if !RefCompatible(supSig.Params[i], subSig.Params[i]) {
				return false
			}
		}
		if !RefCompatible(subSig.Result, supSig.Result) {
			return false
		}
	}
	return true
}

// VerifyAcyclic expands both query types and compares the reference result
// with the coinductive checker. It returns an error when the graph is
// cyclic (reference model not applicable) or when the two disagree.
func VerifyAcyclic(env *Env, checker *Checker, q Query) (refResult bool, err error) {
	subTree, err := env.Expand(q.Sub)
	if err != nil {
		return false, fmt.Errorf("reference model skipped: %v", err)
	}
	supTree, err := env.Expand(q.Super)
	if err != nil {
		return false, fmt.Errorf("reference model skipped: %v", err)
	}
	refResult = RefCompatible(subTree, supTree)
	if got := checker.Compatible(q.Sub, q.Super); got != refResult {
		return refResult, fmt.Errorf("checker disagrees with reference model: coinductive=%v reference=%v", got, refResult)
	}
	return refResult, nil
}
