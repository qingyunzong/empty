package main

import (
	"math/rand"
	"testing"
)

func TestExpandRejectsCycles(t *testing.T) {
	prog := mustParse(t, `
		type A = interface { Next: A }
		type B = interface { B: C }
		type C = interface { C: B }
		check A <: A
	`)
	if _, err := Expand(prog.Types["A"]); err == nil {
		t.Errorf("expected cycle error for self-recursive A")
	}
	if _, err := Expand(prog.Types["B"]); err == nil {
		t.Errorf("expected cycle error for mutually recursive B")
	}
}

func TestCrossCheckSkipsCyclic(t *testing.T) {
	prog := mustParse(t, `
		type A = interface { Next: A; V: int }
		type B = interface { Next: B; V: int }
		check A <: B
	`)
	res := Check(prog.Types["A"], prog.Types["B"])
	note, consistent := CrossCheck(prog.Types["A"], prog.Types["B"], res.OK)
	if !consistent {
		t.Errorf("cyclic cross-check should never report mismatch: %s", note)
	}
}

// TestReferenceModelAgrees cross-checks the coinductive algorithm against
// the expanded reference model on every acyclic case from the tables.
func TestReferenceModelAgrees(t *testing.T) {
	srcs := []string{
		`type A = interface { V: int; W: string }
		 type B = interface { V: int }
		 check A <: B`,
		`type A = interface { M(x: any): int }
		 type B = interface { M(x: int): any }
		 check A <: B`,
		`type A = interface { M(x: int): any }
		 type B = interface { M(x: any): int }
		 check A <: B`,
		`type A = interface { Item: interface { X: int; Y: int } }
		 type B = interface { Item: interface { X: int } }
		 check A <: B`,
		`type A = interface { F: func(func(int) int) func() any }
		 type B = interface { F: func(func(any) int) func() int }
		 check A <: B`,
		`type A = interface { V: int }
		 type B = interface { V: int; W: bool }
		 check A <: B`,
	}
	for i, src := range srcs {
		prog := mustParse(t, src)
		c := prog.Checks[0]
		sub, sup := prog.Types[c.Sub], prog.Types[c.Sup]
		res := Check(sub, sup)
		note, consistent := CrossCheck(sub, sup, res.OK)
		if !consistent {
			t.Errorf("case %d: %s", i, note)
		}
	}
}

// genType builds a random acyclic type graph (a DAG, since nodes are only
// built from previously generated nodes).
func genType(r *rand.Rand, depth int) *Type {
	if depth <= 0 {
		switch r.Intn(4) {
		case 0:
			return &Type{Kind: KindAny}
		default:
			name := []string{"int", "string", "bool"}[r.Intn(3)]
			return &Type{Kind: KindPrim, Name: name}
		}
	}
	switch r.Intn(4) {
	case 0:
		return &Type{Kind: KindAny}
	case 1:
		name := []string{"int", "string", "bool"}[r.Intn(3)]
		return &Type{Kind: KindPrim, Name: name}
	case 2:
		fn := &Type{Kind: KindFunc, Result: genType(r, depth-1)}
		for i := 0; i < r.Intn(3); i++ {
			fn.Params = append(fn.Params, genType(r, depth-1))
		}
		return fn
	default:
		iface := &Type{Kind: KindInterface}
		for i := 0; i < r.Intn(4); i++ {
			name := string(rune('a' + r.Intn(4)))
			if iface.Lookup(name) != nil {
				continue
			}
			iface.Members = append(iface.Members,
				Member{Name: name, Type: genType(r, depth-1)})
		}
		return iface
	}
}

// TestRandomizedAgreement fuzzes small acyclic types and requires the
// coinductive algorithm to agree with the expanded reference model.
func TestRandomizedAgreement(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 2000; i++ {
		sub := genType(r, 3)
		sup := genType(r, 3)
		got := Check(sub, sup).OK
		subTree, err := Expand(sub)
		if err != nil {
			t.Fatalf("iter %d: generated type is cyclic: %v", i, err)
		}
		supTree, err := Expand(sup)
		if err != nil {
			t.Fatalf("iter %d: generated type is cyclic: %v", i, err)
		}
		if want := TreeCheck(subTree, supTree); got != want {
			t.Fatalf("iter %d: coinductive=%v reference=%v\nsub=%+v\nsup=%+v",
				i, got, want, subTree, supTree)
		}
	}
}
