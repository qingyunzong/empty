package main

import (
	"strings"
	"testing"
)

func mustEnv(t *testing.T, decls map[string]*Interface) *Env {
	t.Helper()
	env, err := NewEnv(decls)
	if err != nil {
		t.Fatalf("NewEnv: %v", err)
	}
	return env
}

func iface(fields map[string]string, methods map[string]*FuncSig) *Interface {
	return &Interface{Fields: fields, Methods: methods}
}

func sig(result string, params ...string) *FuncSig {
	return &FuncSig{Params: params, Result: result}
}

// check runs Compatible and, on failure, ShortestFailure, returning both.
func check(t *testing.T, env *Env, sub, sup string) (bool, string) {
	t.Helper()
	c := NewChecker(env)
	ok := c.Compatible(sub, sup)
	if ok {
		return true, ""
	}
	path, reason, found := c.ShortestFailure(sub, sup)
	if !found {
		t.Fatalf("%s <: %s: Compatible=false but ShortestFailure found nothing", sub, sup)
	}
	return false, strings.Join(path, "") + ": " + reason
}

func TestFieldCovariance(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"Animal": iface(map[string]string{"name": "string"}, nil),
		"Cat":    iface(map[string]string{"name": "string", "lives": "int"}, nil),
		"BoxA":   iface(map[string]string{"pet": "Animal"}, nil),
		"BoxC":   iface(map[string]string{"pet": "Cat"}, nil),
	})
	if ok, detail := check(t, env, "BoxC", "BoxA"); !ok {
		t.Fatalf("want compatible, got %s", detail)
	}
	ok, detail := check(t, env, "BoxA", "BoxC")
	if ok {
		t.Fatal("want incompatible")
	}
	if !strings.HasPrefix(detail, ".pet: ") {
		t.Fatalf("want shortest path .pet, got %q", detail)
	}
}

func TestMethodParamContravariance(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"Animal":   iface(map[string]string{"name": "string"}, nil),
		"Cat":      iface(map[string]string{"name": "string", "lives": "int"}, nil),
		"HandlerA": iface(nil, map[string]*FuncSig{"handle": sig("string", "Animal")}),
		"HandlerC": iface(nil, map[string]*FuncSig{"handle": sig("string", "Cat")}),
	})
	// A handler accepting any Animal can serve where a Cat handler is wanted.
	if ok, detail := check(t, env, "HandlerA", "HandlerC"); !ok {
		t.Fatalf("want compatible, got %s", detail)
	}
	ok, detail := check(t, env, "HandlerC", "HandlerA")
	if ok {
		t.Fatal("want incompatible")
	}
	if !strings.HasPrefix(detail, ".handle(arg0): ") {
		t.Fatalf("want shortest path .handle(arg0), got %q", detail)
	}
}

func TestMethodResultCovariance(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"Animal": iface(map[string]string{"name": "string"}, nil),
		"Cat":    iface(map[string]string{"name": "string", "lives": "int"}, nil),
		"SrcA":   iface(nil, map[string]*FuncSig{"get": sig("Animal")}),
		"SrcC":   iface(nil, map[string]*FuncSig{"get": sig("Cat")}),
	})
	if ok, detail := check(t, env, "SrcC", "SrcA"); !ok {
		t.Fatalf("want compatible, got %s", detail)
	}
	ok, detail := check(t, env, "SrcA", "SrcC")
	if ok {
		t.Fatal("want incompatible")
	}
	if !strings.HasPrefix(detail, ".get(): ") {
		t.Fatalf("want shortest path .get(), got %q", detail)
	}
}

func TestRecursiveTypesCoinductive(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		// Two isomorphic recursive lists.
		"ListA": iface(map[string]string{"head": "int", "tail": "ListA"}, nil),
		"ListB": iface(map[string]string{"head": "int", "tail": "ListB"}, nil),
		// Diverges deep in the recursion.
		"NodeA": iface(map[string]string{"next": "NodeA", "tag": "int"}, nil),
		"NodeB": iface(map[string]string{"next": "NodeB", "tag": "string"}, nil),
	})
	if ok, detail := check(t, env, "ListA", "ListB"); !ok {
		t.Fatalf("isomorphic recursive lists must be compatible, got %s", detail)
	}
	ok, detail := check(t, env, "NodeA", "NodeB")
	if ok {
		t.Fatal("want incompatible")
	}
	// BFS must not loop on the .next self-edge; the shallow .tag failure wins.
	if !strings.HasPrefix(detail, ".tag: ") {
		t.Fatalf("want shortest path .tag, got %q", detail)
	}
}

func TestMutualRecursionFailurePath(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"A":  iface(map[string]string{"b": "B"}, nil),
		"B":  iface(map[string]string{"a": "A", "n": "int"}, nil),
		"A2": iface(map[string]string{"b": "B2"}, nil),
		"B2": iface(map[string]string{"a": "A2", "n": "string"}, nil),
	})
	ok, detail := check(t, env, "A", "A2")
	if ok {
		t.Fatal("want incompatible")
	}
	if !strings.HasPrefix(detail, ".b.n: ") {
		t.Fatalf("want shortest path .b.n, got %q", detail)
	}
}

func TestWidthSubtypingAndMissingMember(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"Big":   iface(map[string]string{"a": "int", "b": "string", "c": "bool"}, nil),
		"Small": iface(map[string]string{"a": "int"}, nil),
	})
	if ok, detail := check(t, env, "Big", "Small"); !ok {
		t.Fatalf("width subtyping must hold, got %s", detail)
	}
	ok, detail := check(t, env, "Small", "Big")
	if ok {
		t.Fatal("want incompatible")
	}
	if !strings.Contains(detail, `missing member`) {
		t.Fatalf("want missing member reason, got %q", detail)
	}
	if !strings.HasPrefix(detail, ": missing member") {
		t.Fatalf("want failure at root path, got %q", detail)
	}
}

func TestArityAndKindMismatch(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"M1": iface(nil, map[string]*FuncSig{"m": sig("int", "int")}),
		"M2": iface(nil, map[string]*FuncSig{"m": sig("int", "int", "int")}),
		"F":  iface(map[string]string{"m": "int"}, nil),
	})
	ok, detail := check(t, env, "M1", "M2")
	if ok || !strings.Contains(detail, "arity mismatch") {
		t.Fatalf("want arity mismatch, got ok=%v %q", ok, detail)
	}
	ok, detail = check(t, env, "F", "M1")
	if ok || !strings.Contains(detail, "field") {
		t.Fatalf("want kind mismatch, got ok=%v %q", ok, detail)
	}
}

func TestAnyAndPrimitives(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"HasAny": iface(map[string]string{"v": "any"}, nil),
		"HasInt": iface(map[string]string{"v": "int"}, nil),
	})
	c := NewChecker(env)
	if !c.Compatible("int", "any") {
		t.Fatal("int <: any must hold")
	}
	if c.Compatible("any", "int") {
		t.Fatal("any <: int must not hold")
	}
	if !c.Compatible("int", "int") {
		t.Fatal("int <: int must hold")
	}
	if c.Compatible("int", "string") {
		t.Fatal("int <: string must not hold")
	}
	if ok, detail := check(t, env, "HasInt", "HasAny"); !ok {
		t.Fatalf("want compatible, got %s", detail)
	}
	if ok, _ := check(t, env, "HasAny", "HasInt"); ok {
		t.Fatal("want incompatible")
	}
}

func TestShortestPathPrefersShallowFailure(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"Deep1": iface(map[string]string{"c": "string"}, nil),
		"Deep2": iface(map[string]string{"c": "int"}, nil),
		"A":     iface(map[string]string{"a": "int", "b": "Deep1"}, nil),
		"B":     iface(map[string]string{"a": "string", "b": "Deep2"}, nil),
	})
	ok, detail := check(t, env, "A", "B")
	if ok {
		t.Fatal("want incompatible")
	}
	// Both .a (depth 1) and .b.c (depth 2) fail; shortest is .a.
	if !strings.HasPrefix(detail, ".a: ") {
		t.Fatalf("want shortest path .a, got %q", detail)
	}
}

// TestReferenceCrossCheck verifies the coinductive checker against the
// expansion reference model on a battery of small acyclic graphs.
func TestReferenceCrossCheck(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"Animal": iface(map[string]string{"name": "string"}, nil),
		"Cat":    iface(map[string]string{"name": "string", "lives": "int"}, nil),
		"Dog":    iface(map[string]string{"name": "string", "good": "bool"}, nil),
		"BoxA":   iface(map[string]string{"pet": "Animal"}, nil),
		"BoxC":   iface(map[string]string{"pet": "Cat"}, nil),
		"Nest1":  iface(map[string]string{"box": "BoxA"}, nil),
		"Nest2":  iface(map[string]string{"box": "BoxC"}, nil),
		"Fn1":    iface(nil, map[string]*FuncSig{"f": sig("Animal", "Cat")}),
		"Fn2":    iface(nil, map[string]*FuncSig{"f": sig("Cat", "Animal")}),
		"Empty":  iface(nil, nil),
	})
	names := []string{"Animal", "Cat", "Dog", "BoxA", "BoxC", "Nest1", "Nest2", "Fn1", "Fn2", "Empty"}
	checker := NewChecker(env)
	mismatches := 0
	for _, sub := range names {
		for _, sup := range names {
			q := Query{Sub: sub, Super: sup}
			ref, err := VerifyAcyclic(env, checker, q)
			if err != nil {
				t.Errorf("%s <: %s: %v", sub, sup, err)
				mismatches++
				continue
			}
			_ = ref
		}
	}
	if mismatches > 0 {
		t.Fatalf("%d mismatches against reference model", mismatches)
	}
}

// TestReferenceRejectsCycles ensures the reference model only applies to
// acyclic graphs.
func TestReferenceRejectsCycles(t *testing.T) {
	env := mustEnv(t, map[string]*Interface{
		"Loop": iface(map[string]string{"next": "Loop"}, nil),
	})
	if _, err := env.Expand("Loop"); err == nil {
		t.Fatal("want cycle error from Expand")
	}
}

func TestNewEnvValidation(t *testing.T) {
	if _, err := NewEnv(map[string]*Interface{
		"Bad": iface(map[string]string{"x": "Nope"}, nil),
	}); err == nil {
		t.Fatal("want unknown reference error")
	}
	if _, err := NewEnv(map[string]*Interface{
		"int": iface(nil, nil),
	}); err == nil {
		t.Fatal("want built-in name conflict error")
	}
	if _, err := NewEnv(map[string]*Interface{
		"Dup": {Fields: map[string]string{"m": "int"}, Methods: map[string]*FuncSig{"m": sig("int")}},
	}); err == nil {
		t.Fatal("want field/method collision error")
	}
}
