package dataeng_test

import (
	"fmt"

	dq "example.org/dataeng/q0294"
)

func ExampleCheck() {
	schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("S", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	result, err := dq.Check(dq.Problem{Schema: schema, A: a, B: b}, dq.Unlimited)
	if err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Println(result.Status)
	fmt.Println(result.Mapping.Lookup("x"))

	// Output:
	// contained
	// var(x) true
}
