package main

import (
	"fmt"
	"sort"
)

// Tree is a finite expansion of a type graph: the reference model.
// It only exists for acyclic types.
type Tree struct {
	Kind    string // "any" | "prim" | "func" | "interface"
	Name    string // primitive name
	Params  []*Tree
	Result  *Tree
	Members []TreeMember // sorted by name
}

// TreeMember is a named member of an expanded interface tree.
type TreeMember struct {
	Name string
	Type *Tree
}

// Expand unfolds a type graph into a finite tree. It fails if the graph
// is cyclic, since a recursive type has no finite expansion.
func Expand(t *Type) (*Tree, error) {
	return expand(t, map[*Type]bool{})
}

func expand(t *Type, onPath map[*Type]bool) (*Tree, error) {
	if onPath[t] {
		return nil, fmt.Errorf("cyclic type %s has no finite expansion", describe(t))
	}
	onPath[t] = true
	defer delete(onPath, t)
	switch t.Kind {
	case KindAny:
		return &Tree{Kind: "any"}, nil
	case KindPrim:
		return &Tree{Kind: "prim", Name: t.Name}, nil
	case KindFunc:
		tr := &Tree{Kind: "func"}
		for _, pt := range t.Params {
			et, err := expand(pt, onPath)
			if err != nil {
				return nil, err
			}
			tr.Params = append(tr.Params, et)
		}
		res, err := expand(t.Result, onPath)
		if err != nil {
			return nil, err
		}
		tr.Result = res
		return tr, nil
	case KindInterface:
		tr := &Tree{Kind: "interface"}
		for _, m := range t.Members {
			em, err := expand(m.Type, onPath)
			if err != nil {
				return nil, err
			}
			tr.Members = append(tr.Members, TreeMember{Name: m.Name, Type: em})
		}
		sort.Slice(tr.Members, func(i, j int) bool {
			return tr.Members[i].Name < tr.Members[j].Name
		})
		return tr, nil
	}
	return nil, fmt.Errorf("invalid type node in %s", describe(t))
}

// TreeCheck is the reference subtyping relation on finite trees, using the
// same variance rules as Check. It is plain structural recursion, so it is
// simple enough to trust as a cross-check of the coinductive algorithm.
func TreeCheck(sub, sup *Tree) bool {
	if sup.Kind == "any" {
		return true
	}
	if sub.Kind != sup.Kind {
		return false
	}
	switch sub.Kind {
	case "prim":
		return sub.Name == sup.Name
	case "func":
		if len(sub.Params) != len(sup.Params) {
			return false
		}
		for i := range sub.Params {
			if !TreeCheck(sup.Params[i], sub.Params[i]) { // contravariant
				return false
			}
		}
		return TreeCheck(sub.Result, sup.Result) // covariant
	case "interface":
		for _, m := range sup.Members {
			var found *Tree
			for _, sm := range sub.Members {
				if sm.Name == m.Name {
					found = sm.Type
					break
				}
			}
			if found == nil || !TreeCheck(found, m.Type) { // covariant
				return false
			}
		}
		return true
	}
	return false
}

// CrossCheck verifies the coinductive result against the expanded reference
// model. It is skipped for cyclic types, which have no finite expansion.
func CrossCheck(sub, sup *Type, got bool) (note string, consistent bool) {
	subTree, err := Expand(sub)
	if err != nil {
		return "verify: skipped (" + err.Error() + ")", true
	}
	supTree, err := Expand(sup)
	if err != nil {
		return "verify: skipped (" + err.Error() + ")", true
	}
	want := TreeCheck(subTree, supTree)
	if want != got {
		return fmt.Sprintf("verify: MISMATCH coinductive=%v reference=%v", got, want), false
	}
	return fmt.Sprintf("verify: reference model agrees (%v)", got), true
}
