package main

import "testing"

func mustParse(t *testing.T, src string) *Program {
	t.Helper()
	prog, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return prog
}

// runCheck parses src, runs its single check statement, and returns the result.
func runCheck(t *testing.T, src string) Result {
	t.Helper()
	prog := mustParse(t, src)
	if len(prog.Checks) != 1 {
		t.Fatalf("expected exactly 1 check, got %d", len(prog.Checks))
	}
	c := prog.Checks[0]
	return Check(prog.Types[c.Sub], prog.Types[c.Sup])
}

func TestCompatible(t *testing.T) {
	cases := map[string]string{
		"identical fields": `
			type A = interface { V: int }
			type B = interface { V: int }
			check A <: B`,
		"extra members allowed": `
			type A = interface { V: int; W: string }
			type B = interface { V: int }
			check A <: B`,
		"field covariance": `
			type A = interface { Item: interface { X: int; Y: int } }
			type B = interface { Item: interface { X: int } }
			check A <: B`,
		"field to any": `
			type A = interface { V: int }
			type B = interface { V: any }
			check A <: B`,
		"param contravariance and result covariance": `
			type A = interface { M(x: any): int }
			type B = interface { M(x: int): any }
			check A <: B`,
		"func field variance": `
			type A = interface { F: func(any) int }
			type B = interface { F: func(int) any }
			check A <: B`,
		"self recursion": `
			type A = interface { Next: A; V: int }
			type B = interface { Next: B; V: int }
			check A <: B`,
		"mutual recursion": `
			type A = interface { B: B; V: int }
			type B = interface { A: A }
			type C = interface { B: D; V: int }
			type D = interface { A: C }
			check A <: C`,
		"recursion with variance": `
			type A = interface { Next: A; M(x: any): int }
			type B = interface { Next: B; M(x: int): any }
			check A <: B`,
		"empty interface": `
			type A = interface { V: int }
			type B = interface {}
			check A <: B`,
		"any to any": `
			type A = interface { V: any }
			type B = interface { V: any }
			check A <: B`,
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			res := runCheck(t, src)
			if !res.OK {
				t.Errorf("expected COMPATIBLE, got INCOMPATIBLE at %s: %s",
					PathString(res.Path), res.Reason)
			}
		})
	}
}

func TestIncompatible(t *testing.T) {
	cases := []struct {
		name string
		src  string
		path string
	}{
		{"missing member", `
			type A = interface { V: int }
			type B = interface { V: int; W: string }
			check A <: B`, ".W"},
		{"primitive mismatch", `
			type A = interface { V: int }
			type B = interface { V: string }
			check A <: B`, ".V"},
		{"field not covariant", `
			type A = interface { Item: interface { X: int } }
			type B = interface { Item: interface { X: int; Y: int } }
			check A <: B`, ".Item.Y"},
		{"param must be contravariant", `
			type A = interface { M(x: int): any }
			type B = interface { M(x: any): int }
			check A <: B`, ".M(arg 0)"},
		{"result must be covariant", `
			type A = interface { M(): any }
			type B = interface { M(): int }
			check A <: B`, ".M(result)"},
		{"param count mismatch", `
			type A = interface { M(x: int, y: int): int }
			type B = interface { M(x: int): int }
			check A <: B`, ".M"},
		{"kind mismatch", `
			type A = interface { V: int }
			type B = interface { V: func() int }
			check A <: B`, ".V"},
		{"any not subtype of concrete", `
			type A = interface { V: any }
			type B = interface { V: int }
			check A <: B`, ".V"},
		{"recursive mismatch at root member", `
			type A = interface { Next: A; V: int }
			type B = interface { Next: B; V: bool }
			check A <: B`, ".V"},
		{"recursive mismatch deep", `
			type A = interface { Next: A; V: int }
			type B = interface { Next: C }
			type C = interface { Next: C; V: string }
			check A <: B`, ".Next.V"},
		{"shortest path wins", `
			type A = interface { Deep: interface { X: interface { Y: string } }; V: bool }
			type B = interface { Deep: interface { X: interface { Y: int } }; V: int }
			check A <: B`, ".V"},
		{"recursive func mismatch", `
			type A = interface { M(x: int): A }
			type B = interface { M(x: any): B }
			check A <: B`, ".M(arg 0)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := runCheck(t, tc.src)
			if res.OK {
				t.Fatalf("expected INCOMPATIBLE at %s, got COMPATIBLE", tc.path)
			}
			if got := PathString(res.Path); got != tc.path {
				t.Errorf("path = %s, want %s (reason: %s)", got, tc.path, res.Reason)
			}
		})
	}
}
