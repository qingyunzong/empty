package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0172"
)

func ExampleSolve_cyclicForeignKeys() {
	spec := dataeng.Spec{Tables: []dataeng.Table{
		{ID: "a", Rows: 1, Columns: []dataeng.Column{
			{ID: "b", Domain: []string{"x", "y"}},
		}},
		{ID: "b", Rows: 1, Columns: []dataeng.Column{
			{ID: "a", Domain: []string{"x", "y"}},
		}},
	}}
	constraints := []dataeng.Constraint{
		dataeng.NotNull("nn_a_b", "a", "b"),
		dataeng.NotNull("nn_b_a", "b", "a"),
		dataeng.ForeignKey("fk_a_b", "a", "b", "b", "a"),
		dataeng.ForeignKey("fk_b_a", "b", "a", "a", "b"),
	}
	result, err := dataeng.Solve(spec, constraints)
	if err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Println("satisfiable:", result.Satisfiable)
	for i, p := range result.Fixture.Positions {
		fmt.Printf("%s[%d].%s=%v\n", p.Table, p.Row, p.Column, result.Fixture.Values[i])
	}
	// Output:
	// satisfiable: true
	// a[0].b=0
	// b[0].a=0
}

func ExampleSolve_unsatisfiable() {
	spec := dataeng.Spec{Tables: []dataeng.Table{
		{ID: "child", Rows: 1, Columns: []dataeng.Column{
			{ID: "ref", Domain: []string{"u", "v"}},
		}},
		{ID: "empty", Rows: 0, Columns: []dataeng.Column{
			{ID: "code", Domain: []string{"u", "v"}},
		}},
	}}
	constraints := []dataeng.Constraint{
		dataeng.ForeignKey("fk_child_ref", "child", "ref", "empty", "code"),
		dataeng.NotNull("nn_child_ref", "child", "ref"),
	}
	result, err := dataeng.Solve(spec, constraints)
	if err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Println("satisfiable:", result.Satisfiable)
	fmt.Println("MUS:", result.Unsat.MUS)
	cert := result.Unsat.Certificates["fk_child_ref"]
	cell, _ := cert.ValueAt("child", 0, "ref")
	fmt.Println("cert without fk_child_ref:", cell)
	// Output:
	// satisfiable: false
	// MUS: [fk_child_ref nn_child_ref]
	// cert without fk_child_ref: 0
}
