package main

import "testing"

func TestParseShapes(t *testing.T) {
	prog := mustParse(t, `
		# comment
		type Node = interface {
			Value: int
			Next: Node
			Map(f: func(int) string): Node
		}
		check Node <: Node
	`)
	node := prog.Types["Node"]
	if node.Kind != KindInterface {
		t.Fatalf("Node kind = %v, want interface", node.Kind)
	}
	if len(node.Members) != 3 {
		t.Fatalf("Node has %d members, want 3", len(node.Members))
	}
	next := node.Lookup("Next")
	if next != node {
		t.Errorf("Next should reference the Node node itself (recursion)")
	}
	m := node.Lookup("Map")
	if m.Kind != KindFunc || len(m.Params) != 1 || m.Result != node {
		t.Errorf("Map desugared incorrectly: %+v", m)
	}
	if m.Params[0].Kind != KindFunc || m.Params[0].Result.Name != "string" {
		t.Errorf("Map parameter desugared incorrectly: %+v", m.Params[0])
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]string{
		"undefined type":   `type A = interface { V: mystery }`,
		"undefined check":  `type A = interface {}` + "\n" + `check A <: B`,
		"cyclic alias":     `type A = A`,
		"duplicate decl":   "type A = interface {}\ntype A = interface {}",
		"duplicate member": `type A = interface { V: int; V: string }`,
		"reserved name":    `type any = interface {}`,
		"missing colon":    `type A = interface { V int }`,
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(src); err == nil {
				t.Errorf("expected parse error, got nil")
			}
		})
	}
}

func TestParseMultipleChecks(t *testing.T) {
	prog := mustParse(t, `
		type A = interface { V: int }
		type B = interface { V: any }
		check A <: B
		check B <: A
	`)
	if len(prog.Checks) != 2 {
		t.Fatalf("got %d checks, want 2", len(prog.Checks))
	}
	res1 := Check(prog.Types["A"], prog.Types["B"])
	res2 := Check(prog.Types["B"], prog.Types["A"])
	if !res1.OK || res2.OK {
		t.Errorf("A<:B=%v (want true), B<:A=%v (want false)", res1.OK, res2.OK)
	}
}
