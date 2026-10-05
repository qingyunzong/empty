package expropt_test

import (
	"fmt"

	"expropt/expropt"
)

func Example() {
	src := "1 + 2 * 3 && (8 / 4 > 1) || (1 / 0)"
	n, err := expropt.Parse(src)
	if err != nil {
		panic(err)
	}
	opt := expropt.Optimize(n)
	fmt.Printf("source:    %s\n", src)
	fmt.Printf("optimized:\n%s", expropt.Dump(opt))
	v, err := expropt.Eval(opt)
	fmt.Printf("result:    %d, err: %v\n", v, err)
	// Output:
	// source:    1 + 2 * 3 && (8 / 4 > 1) || (1 / 0)
	// optimized:
	// Const(1) @25
	// result:    1, err: <nil>
}
